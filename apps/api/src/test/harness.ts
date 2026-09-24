import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiErrorBody, ErrorCode } from '@daliz/shared';
import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../bootstrap.js';
import { ENV, type Env } from '../config/env.js';
import { EncryptionService, PasswordService } from '../common/crypto.js';
import { PlatformDb } from '../database/platform/platform-db.js';
import { accounts, organizations, platformAdmins, tenantMemberships, tenants } from '../database/platform/schema.js';
import { userRoles, users } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { getRoleIdsByKey } from '../database/tenant/tenant-seed.js';
import { QUEUES, QueueService, type EmailJob } from '../infra/queue.js';
import { RedisService } from '../infra/redis.js';
import { StorageService } from '../infra/storage.js';
import { PlatformAccessService } from '../modules/platform/platform-access.service.js';
import { ProvisioningService, dropTenantDatabase } from '../modules/platform/provisioning.service.js';

export const PASSWORD = 'Correct-Horse-Battery-9';

export function uniqueSlug(prefix = 't'): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

type Body = Record<string, unknown> | unknown[] | undefined;

export interface ApiResult<T = unknown> {
  status: number;
  body: { success: true; data: T; meta?: unknown } | ApiErrorBody;
  data: T;
  code: ErrorCode | undefined;
  headers: Record<string, string>;
}

/** An HTTP client with its own cookie jar that tracks the CSRF token like the web app does. */
export class ApiClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrf: string | undefined;

  constructor(
    server: Parameters<typeof request.agent>[0],
    public host?: string,
  ) {
    this.agent = request.agent(server);
  }

  private prep(req: request.Test, opts: { csrf?: boolean; headers?: Record<string, string> }) {
    if (this.host) req.set('Host', this.host);
    if (opts.csrf !== false && this.csrf) req.set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(opts.headers ?? {})) req.set(k, v);
    return req;
  }

  private async send<T>(req: request.Test): Promise<ApiResult<T>> {
    const res = await req;
    const body = res.body as ApiResult<T>['body'];
    if (!body || typeof body !== 'object' || !('success' in body)) {
      throw new Error(`Non-envelope response ${res.status} ${res.headers['content-type'] ?? ''}: ${String(res.text).slice(0, 300)}`);
    }
    if (body && body.success && body.data && typeof body.data === 'object' && 'csrfToken' in (body.data as object)) {
      this.csrf = (body.data as unknown as { csrfToken: string }).csrfToken;
    }
    return {
      status: res.status,
      body,
      data: (body && body.success ? body.data : undefined) as T,
      code: body && !body.success ? body.error.code : undefined,
      headers: res.headers as Record<string, string>,
    };
  }

  get<T = unknown>(path: string, opts: { headers?: Record<string, string> } = {}) {
    return this.send<T>(this.prep(this.agent.get(`/api/v1${path}`), opts));
  }
  post<T = unknown>(path: string, body?: Body, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
    return this.send<T>(this.prep(this.agent.post(`/api/v1${path}`), opts).send(body ?? {}));
  }
  put<T = unknown>(path: string, body?: Body, opts: { csrf?: boolean } = {}) {
    return this.send<T>(this.prep(this.agent.put(`/api/v1${path}`), opts).send(body ?? {}));
  }
  patch<T = unknown>(path: string, body?: Body, opts: { csrf?: boolean } = {}) {
    return this.send<T>(this.prep(this.agent.patch(`/api/v1${path}`), opts).send(body ?? {}));
  }
  del<T = unknown>(path: string, opts: { csrf?: boolean } = {}) {
    return this.send<T>(this.prep(this.agent.delete(`/api/v1${path}`), opts));
  }
  upload<T = unknown>(path: string, field: string, file: Buffer, filename: string, contentType: string) {
    return this.send<T>(this.prep(this.agent.post(`/api/v1${path}`), {}).attach(field, file, { filename, contentType }));
  }

  async login(email: string, password = PASSWORD): Promise<ApiResult<{ stage: string; csrfToken: string }>> {
    return this.post('/auth/login', { email, password });
  }

  async me() {
    return this.get<import('@daliz/shared').MeResponse>('/auth/me');
  }

  async stepUp(password = PASSWORD, code?: string) {
    return this.post('/auth/step-up', { password, ...(code ? { code } : {}) });
  }
}

export interface TestTenant {
  tenantId: string;
  slug: string;
  host: string;
  ownerEmail: string;
}

/** Boots the real API against real Postgres/Redis/MinIO, with a clean slate per test file. */
export class TestEnv {
  app!: NestExpressApplication;
  env!: Env;

  static async start(): Promise<TestEnv> {
    const t = new TestEnv();
    t.app = await createApp({ logger: process.env.TEST_LOGS === '1' });
    // Listen once. Otherwise supertest starts and stops a server per request, and concurrent
    // requests on reused keep-alive sockets intermittently hit a closing server.
    await t.app.listen(0, '127.0.0.1');
    t.env = t.app.get<Env>(ENV);
    await t.reset();
    return t;
  }

  get server() {
    return this.app.getHttpServer();
  }

  get<T>(token: abstract new (...args: never[]) => T): T {
    return this.app.get(token as never) as T;
  }

  client(host?: string): ApiClient {
    return new ApiClient(this.server, host);
  }

  /** Drops every test tenant database/role and recreates the platform test schema. */
  async reset(): Promise<void> {
    if (!this.env.PLATFORM_DB_NAME.endsWith('_test') || this.env.TENANT_DB_PREFIX !== 'daliz_test_') {
      throw new Error('Refusing to reset: not pointed at the test databases');
    }
    const platform = this.get(PlatformDb);
    const provisioner = new pg.Client({
      host: this.env.TENANT_DB_HOST,
      port: this.env.TENANT_DB_PORT,
      user: this.env.PROVISIONER_DB_USER,
      password: this.env.PROVISIONER_DB_PASSWORD,
      database: 'postgres',
    });
    await provisioner.connect();
    try {
      const dbs = await provisioner.query<{ datname: string; owner: string }>(
        "select datname, pg_get_userbyid(datdba) as owner from pg_database where datname like 'daliz\\_test\\_%'",
      );
      for (const d of dbs.rows) await dropTenantDatabase(provisioner, d.datname, d.owner);
      const roles = await provisioner.query<{ rolname: string }>("select rolname from pg_roles where rolname like 'daliz\\_test\\_%'");
      for (const r of roles.rows) await provisioner.query(`DROP ROLE IF EXISTS ${provisioner.escapeIdentifier(r.rolname)}`);
    } finally {
      await provisioner.end();
    }
    await platform.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await platform.migrate();
    await this.get(PlatformAccessService).syncCatalog();
    await this.get(RedisService).client.flushdb();
    await this.get(StorageService).ensureBucket();
    // Most tests exercise platform features without also exercising MFA enrolment.
    await this.get(PlatformAccessService).updateSettings(
      {
        maintenanceMode: false,
        maintenanceMessage: 'Maintenance',
        requireMfaForPlatformAdmins: false,
        allowTenantSelfBranding: true,
        defaultStorageQuotaMb: 1024,
        defaultMaxUsers: 50,
      },
      '00000000-0000-0000-0000-000000000000',
    );
  }

  /** Tests share one client IP, so counters are cleared between tests that don't test limits. */
  async clearRateLimits(): Promise<void> {
    await this.get(RedisService).delPattern('rl:*');
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  async createAccount(email: string, name = email.split('@')[0]!, password = PASSWORD): Promise<string> {
    const hash = await this.get(PasswordService).hash(password);
    const [row] = await this.get(PlatformDb)
      .db.insert(accounts)
      .values({ email, name, passwordHash: hash, status: 'active', emailVerifiedAt: new Date() })
      .onConflictDoUpdate({ target: accounts.email, set: { passwordHash: hash, status: 'active' } })
      .returning({ id: accounts.id });
    return row!.id;
  }

  async createSuperAdmin(email = `root-${uniqueSlug()}@daliz.test`, role: 'super_admin' | 'operator' | 'support' | 'auditor' = 'super_admin'): Promise<string> {
    const id = await this.createAccount(email);
    await this.get(PlatformDb).db.insert(platformAdmins).values({ accountId: id, roleKey: role, status: 'active' }).onConflictDoNothing();
    return email;
  }

  /** Provisions a real tenant (its own database) through the production code path. */
  async createTenant(slug = uniqueSlug(), maxUsers = 100): Promise<TestTenant> {
    const platform = this.get(PlatformDb);
    const [org] = await platform.db
      .insert(organizations)
      .values({ name: `Org ${slug}`, slug: `org-${slug}`, contactEmail: `ops@${slug}.test` })
      .returning();
    const ownerEmail = `owner@${slug}.test`;
    const created = await this.get(ProvisioningService).createTenant(
      {
        organizationId: org!.id,
        name: `Tenant ${slug}`,
        slug,
        plan: 'business',
        limits: { maxUsers, storageQuotaMb: 1024 },
        locale: 'en-US',
        timezone: 'UTC',
        currency: 'USD',
        admin: { email: ownerEmail, name: 'Owner' },
      },
      { accountId: '00000000-0000-0000-0000-000000000000', name: 'Test' },
    );
    await this.get(ProvisioningService).runJob(created.jobId, true);
    const [tenant] = await platform.db.select().from(tenants).where(eq(tenants.id, created.tenantId));
    if (tenant?.status !== 'active') throw new Error(`Tenant ${slug} failed to provision: ${tenant?.statusReason}`);
    // The owner was invited; activate them directly (invitation flow has its own tests).
    await this.addUser(created.tenantId, 'owner', ownerEmail);
    return { tenantId: created.tenantId, slug, host: `${slug}.localhost`, ownerEmail };
  }

  async addUser(tenantId: string, roleKey: string, email = `${roleKey}-${uniqueSlug()}@example.test`): Promise<{ email: string; userId: string; accountId: string }> {
    const accountId = await this.createAccount(email);
    await this.get(PlatformDb)
      .db.insert(tenantMemberships)
      .values({ accountId, tenantId, status: 'active', isTenantAdmin: roleKey === 'owner' || roleKey === 'admin' })
      .onConflictDoUpdate({ target: [tenantMemberships.accountId, tenantMemberships.tenantId], set: { status: 'active' } });
    const db = await this.get(TenantConnectionManager).get(tenantId);
    await db.insert(users).values({ accountId, email, name: email, status: 'active' }).onConflictDoUpdate({ target: users.accountId, set: { status: 'active' } });
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
    const roleIds = await getRoleIdsByKey(db, [roleKey]);
    await db.insert(userRoles).values({ userId: u!.id, roleId: roleIds.get(roleKey)! }).onConflictDoNothing();
    return { email, userId: u!.id, accountId };
  }

  async loggedIn(email: string, host?: string): Promise<ApiClient> {
    const c = this.client(host);
    const res = await c.login(email);
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
    return c;
  }

  /** Most recent queued email to an address (tokens only ever exist in the email). */
  async lastEmail(to: string, template?: EmailJob['template']): Promise<EmailJob | undefined> {
    const jobs = await this.get(QueueService).queue(QUEUES.email).getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200);
    return jobs
      .map((j) => j.data as EmailJob)
      .filter((j) => j.to === to && (!template || j.template === template))
      .at(0);
  }

  tokenFromEmail(job: EmailJob | undefined): string {
    const url = job?.data.url;
    if (!url) throw new Error('email has no url');
    return new URL(url).searchParams.get('token')!;
  }

  async tenantDbPassword(tenantId: string): Promise<{ user: string; password: string; database: string }> {
    const creds = await this.get(TenantConnectionManager).credentials(tenantId, { requireReady: false });
    void this.get(EncryptionService);
    return { user: creds.user, password: creds.password, database: creds.database };
  }
}

export function totpFor(secretBase32: string, offsetSteps = 0): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32), digits: 6, period: 30, algorithm: 'SHA1' });
  return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}
