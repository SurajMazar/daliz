import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SYSTEM_ROLES, type CreateTenantInput, type TenantSettings } from '@daliz/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import { ENV, type Env } from '../../config/env.js';
import { EncryptionService } from '../../common/crypto.js';
import { Errors } from '../../common/errors.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import {
  organizations,
  supportSessions,
  tenantDatabases,
  tenantDomains,
  tenantMemberships,
  tenantProvisioningJobs,
  tenants,
  type ProvisioningStepState,
} from '../../database/platform/schema.js';
import { userRoles, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import { TenantMigrator, hardenTenantDatabase } from '../../database/tenant/tenant-migrator.js';
import { getRoleIdsByKey } from '../../database/tenant/tenant-seed.js';
import { QueueService } from '../../infra/queue.js';
import { RedisService } from '../../infra/redis.js';
import { StorageService } from '../../infra/storage.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { SessionService } from '../auth/session.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';

export const PROVISION_STEPS = [
  'validate',
  'create_role',
  'create_database',
  'secure_database',
  'apply_migrations',
  'configure_storage',
  'create_tenant_admin',
  'send_invitation',
  'activate',
] as const;

export const DECOMMISSION_STEPS = [
  'validate',
  'revoke_sessions',
  'close_connections',
  'drop_database',
  'drop_role',
  'delete_storage',
  'disable_memberships',
  'finalize',
] as const;

interface ProvisionPayload {
  admin: { email: string; name: string };
  general: TenantSettings;
  invitationSentAt?: string;
  requestedByName?: string;
}

const IDENT = /^[a-z][a-z0-9_]{2,62}$/;

/**
 * Drops a tenant database. The provisioner holds SET (not INHERIT) on tenant roles, so it
 * must assume the owner role explicitly — it never silently carries tenant privileges.
 */
export async function dropTenantDatabase(c: pg.Client, dbName: string, dbUser: string): Promise<void> {
  if (!IDENT.test(dbName) || !IDENT.test(dbUser)) throw new Error('Unsafe tenant database identifiers');
  const role = await c.query('select 1 from pg_roles where rolname = $1', [dbUser]);
  if (!role.rowCount) {
    const exists = await c.query('select 1 from pg_database where datname = $1', [dbName]);
    if (exists.rowCount) throw new Error(`Database ${dbName} exists but its owner role is missing`);
    return;
  }
  await c.query(`SET ROLE ${c.escapeIdentifier(dbUser)}`);
  try {
    await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(dbName)} WITH (FORCE)`);
  } finally {
    await c.query('RESET ROLE');
  }
}

/** Strips anything that could be a credential from an error before it is stored or shown. */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/password\s+'[^']*'/gi, "password '***'").replace(/postgres(ql)?:\/\/[^\s]+/gi, '[connection string]').slice(0, 800);
}

/**
 * Tenant lifecycle: create → provision (async, idempotent, retryable) → active →
 * suspended → decommissioning (grace period, cancellable) → decommissioned.
 *
 * Each provisioning step checks whether its work already exists before doing it, so a
 * crashed or retried job resumes safely. A tenant only becomes `active` after every step
 * succeeds, so partially initialized tenants are never reachable.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly encryption: EncryptionService,
    private readonly connections: TenantConnectionManager,
    private readonly migrator: TenantMigrator,
    private readonly queue: QueueService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly sessions: SessionService,
    private readonly directory: TenantDirectory,
  ) {}

  // -------------------------------------------------------------------------
  // API-side operations (enqueue work)
  // -------------------------------------------------------------------------

  async createTenant(input: CreateTenantInput, requestedBy: { accountId: string; name: string }): Promise<{ tenantId: string; jobId: string }> {
    const [org] = await this.platform.db.select().from(organizations).where(eq(organizations.id, input.organizationId));
    if (!org) throw Errors.notFound('Organization not found.');
    if (org.status !== 'active') throw Errors.conflict('The organization is suspended.');

    const dbName = `${this.env.TENANT_DB_PREFIX}${input.slug.replace(/-/g, '_')}`;
    if (!IDENT.test(dbName)) throw Errors.badRequest('That slug cannot be used for a database name.');
    const dbPassword = randomBytes(24).toString('base64url');

    const result = await this.platform.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, input.slug));
      if (existing) throw Errors.conflict('A tenant with this slug already exists.');
      const [tenant] = await tx
        .insert(tenants)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          slug: input.slug,
          status: 'provisioning',
          plan: input.plan,
          maxUsers: input.limits.maxUsers,
          storageQuotaMb: input.limits.storageQuotaMb,
          locale: input.locale,
          timezone: input.timezone,
          currency: input.currency,
          createdBy: requestedBy.accountId,
        })
        .returning({ id: tenants.id });
      const tenantId = tenant!.id;
      await tx.insert(tenantDatabases).values({
        tenantId,
        dbName,
        dbHost: this.env.TENANT_DB_HOST,
        dbPort: this.env.TENANT_DB_PORT,
        dbUser: `${dbName}_owner`.slice(0, 63),
        dbPasswordEnc: this.encryption.encrypt(dbPassword, `tenant-db:${tenantId}`),
        status: 'pending',
      });
      const payload: ProvisionPayload = {
        admin: input.admin,
        general: {
          displayName: input.name,
          locale: input.locale,
          timezone: input.timezone,
          currency: input.currency,
          dateFormat: 'yyyy-MM-dd',
          weekStartsOn: 1,
        },
        requestedByName: requestedBy.name,
      };
      const [job] = await tx
        .insert(tenantProvisioningJobs)
        .values({
          tenantId,
          kind: 'provision',
          status: 'queued',
          steps: PROVISION_STEPS.map((key) => ({ key, status: 'pending' as const })),
          payload: payload as unknown as Record<string, unknown>,
          requestedBy: requestedBy.accountId,
        })
        .returning({ id: tenantProvisioningJobs.id });
      await this.audit.platformEvent(
        {
          action: 'tenant.created',
          tenantId,
          resourceType: 'tenant',
          resourceId: tenantId,
          metadata: { slug: input.slug, organizationId: input.organizationId, plan: input.plan, adminEmail: input.admin.email },
        },
        tx,
      );
      return { tenantId, jobId: job!.id };
    });

    await this.queue.enqueueProvisioning({ kind: 'provision', tenantId: result.tenantId, provisioningJobId: result.jobId });
    return result;
  }

  async retryProvisioning(tenantId: string, requestedBy: string): Promise<{ jobId: string }> {
    const [tenant] = await this.platform.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw Errors.notFound();
    if (tenant.status !== 'provisioning_failed') throw Errors.conflict('Only failed provisioning can be retried.');
    const [last] = await this.platform.db
      .select()
      .from(tenantProvisioningJobs)
      .where(and(eq(tenantProvisioningJobs.tenantId, tenantId), eq(tenantProvisioningJobs.kind, 'provision')))
      .orderBy(desc(tenantProvisioningJobs.createdAt))
      .limit(1);
    if (!last) throw Errors.conflict('No provisioning job found for this tenant.');
    const [job] = await this.platform.db
      .insert(tenantProvisioningJobs)
      .values({
        tenantId,
        kind: 'provision',
        status: 'queued',
        steps: PROVISION_STEPS.map((key) => ({ key, status: 'pending' as const })),
        payload: last.payload,
        requestedBy,
      })
      .returning({ id: tenantProvisioningJobs.id });
    await this.platform.db.update(tenants).set({ status: 'provisioning', statusReason: null, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    await this.directory.invalidate(tenantId);
    await this.audit.platformEvent({ action: 'tenant.provisioning_retried', tenantId, resourceType: 'tenant', resourceId: tenantId });
    await this.queue.enqueueProvisioning({ kind: 'provision', tenantId, provisioningJobId: job!.id });
    return { jobId: job!.id };
  }

  async suspend(tenantId: string, reason: string): Promise<void> {
    const updated = await this.platform.db
      .update(tenants)
      .set({ status: 'suspended', statusReason: reason, suspendedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, 'active')))
      .returning({ id: tenants.id });
    if (!updated.length) throw Errors.conflict('Only active tenants can be suspended.');
    await this.directory.invalidate(tenantId);
    const revoked = await this.sessions.revokeAllForTenant(tenantId, 'tenant_suspended');
    await this.connections.evict(tenantId, 'suspended');
    await this.audit.platformEvent({ action: 'tenant.suspended', tenantId, resourceType: 'tenant', resourceId: tenantId, metadata: { reason, revokedSessions: revoked } });
  }

  async activate(tenantId: string, reason: string): Promise<void> {
    const updated = await this.platform.db
      .update(tenants)
      .set({ status: 'active', statusReason: reason, suspendedAt: null, updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, 'suspended')))
      .returning({ id: tenants.id });
    if (!updated.length) throw Errors.conflict('Only suspended tenants can be reactivated.');
    await this.directory.invalidate(tenantId);
    await this.audit.platformEvent({ action: 'tenant.activated', tenantId, resourceType: 'tenant', resourceId: tenantId, metadata: { reason } });
  }

  async scheduleDecommission(tenantId: string, reason: string, confirmSlug: string, requestedBy: string): Promise<{ purgeAt: string }> {
    const [tenant] = await this.platform.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw Errors.notFound();
    if (tenant.slug !== confirmSlug) throw Errors.badRequest('The confirmation does not match the tenant slug.');
    if (!['suspended', 'provisioning_failed'].includes(tenant.status)) {
      throw Errors.conflict('Suspend the tenant before decommissioning it.');
    }
    const delayMs = this.env.TENANT_DECOMMISSION_GRACE_HOURS * 3600_000;
    const purgeAt = new Date(Date.now() + delayMs);
    const jobId = await this.platform.db.transaction(async (tx) => {
      await tx
        .update(tenants)
        .set({ status: 'decommissioning', statusReason: reason, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
      const [job] = await tx
        .insert(tenantProvisioningJobs)
        .values({
          tenantId,
          kind: 'decommission',
          status: 'queued',
          steps: DECOMMISSION_STEPS.map((key) => ({ key, status: 'pending' as const })),
          payload: { reason, purgeAt: purgeAt.toISOString(), previousStatus: tenant.status },
          requestedBy,
        })
        .returning({ id: tenantProvisioningJobs.id });
      await this.audit.platformEvent(
        { action: 'tenant.decommission_scheduled', tenantId, resourceType: 'tenant', resourceId: tenantId, metadata: { reason, purgeAt: purgeAt.toISOString() } },
        tx,
      );
      return job!.id;
    });
    await this.directory.invalidate(tenantId);
    await this.sessions.revokeAllForTenant(tenantId, 'tenant_decommissioning');
    await this.queue.enqueueProvisioning({ kind: 'decommission', tenantId, provisioningJobId: jobId }, delayMs);
    return { purgeAt: purgeAt.toISOString() };
  }

  async cancelDecommission(tenantId: string): Promise<void> {
    const [job] = await this.platform.db
      .select()
      .from(tenantProvisioningJobs)
      .where(and(eq(tenantProvisioningJobs.tenantId, tenantId), eq(tenantProvisioningJobs.kind, 'decommission'), eq(tenantProvisioningJobs.status, 'queued')))
      .orderBy(desc(tenantProvisioningJobs.createdAt))
      .limit(1);
    if (!job) throw Errors.conflict('There is no pending decommission to cancel.');
    const updated = await this.platform.db
      .update(tenants)
      .set({ status: 'suspended', statusReason: 'Decommission cancelled', updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, 'decommissioning')))
      .returning({ id: tenants.id });
    if (!updated.length) throw Errors.conflict('The tenant is not pending decommission.');
    await this.platform.db
      .update(tenantProvisioningJobs)
      .set({ status: 'failed', lastError: 'Cancelled by operator', updatedAt: new Date() })
      .where(eq(tenantProvisioningJobs.id, job.id));
    await this.queue.queue('provisioning').remove(`decommission-${job.id}`).catch(() => undefined);
    await this.directory.invalidate(tenantId);
    await this.audit.platformEvent({ action: 'tenant.decommission_cancelled', tenantId, resourceType: 'tenant', resourceId: tenantId });
  }

  // -------------------------------------------------------------------------
  // Worker-side execution
  // -------------------------------------------------------------------------

  async runJob(provisioningJobId: string, isFinalAttempt: boolean): Promise<void> {
    const [job] = await this.platform.db.select().from(tenantProvisioningJobs).where(eq(tenantProvisioningJobs.id, provisioningJobId));
    if (!job) throw new Error(`Provisioning job ${provisioningJobId} not found`);
    if (job.status === 'succeeded') return;
    if (job.kind === 'decommission' && job.lastError === 'Cancelled by operator') return;

    const release = await this.redis.acquireLock(`tenant-lifecycle:${job.tenantId}`, 15 * 60_000);
    if (!release) throw new Error(`Another lifecycle job is running for tenant ${job.tenantId}`);
    const steps: ProvisioningStepState[] = job.steps.map((s) => ({ ...s }));
    const save = async (patch: Partial<typeof tenantProvisioningJobs.$inferInsert>) =>
      this.platform.db
        .update(tenantProvisioningJobs)
        .set({ ...patch, steps, updatedAt: new Date() })
        .where(eq(tenantProvisioningJobs.id, job.id));

    try {
      await save({ status: 'running', attempts: job.attempts + 1, lastError: null });
      const handlers =
        job.kind === 'decommission'
          ? this.decommissionHandlers(job.tenantId, job.payload)
          : job.kind === 'migrate'
            ? { apply_migrations: () => this.migrator.migrateTenant(job.tenantId).then(() => undefined) }
            : this.provisionHandlers(job.tenantId, job.id, job.payload as unknown as ProvisionPayload);
      for (const step of steps) {
        if (step.status === 'done') continue;
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        delete step.error;
        await save({});
        try {
          await handlers[step.key]!();
          step.status = 'done';
          step.finishedAt = new Date().toISOString();
          await save({});
        } catch (err) {
          step.status = 'failed';
          step.error = safeError(err);
          step.finishedAt = new Date().toISOString();
          throw err;
        }
      }
      await save({ status: 'succeeded' });
    } catch (err) {
      const message = safeError(err);
      this.logger.error({ tenantId: job.tenantId, jobId: job.id, kind: job.kind, error: message }, 'tenant lifecycle job failed');
      await save({ status: isFinalAttempt ? 'failed' : 'queued', lastError: message });
      if (isFinalAttempt && job.kind === 'provision') {
        await this.platform.db
          .update(tenants)
          .set({ status: 'provisioning_failed', statusReason: message.slice(0, 300), updatedAt: new Date() })
          .where(eq(tenants.id, job.tenantId));
        await this.platform.db
          .update(tenantDatabases)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(and(eq(tenantDatabases.tenantId, job.tenantId), eq(tenantDatabases.status, 'creating')));
        await this.directory.invalidate(job.tenantId);
        await this.audit.platformEvent({
          action: 'tenant.provisioning_failed',
          outcome: 'failure',
          tenantId: job.tenantId,
          resourceType: 'tenant',
          resourceId: job.tenantId,
          actor: { type: 'system', id: null, email: null },
          metadata: { jobId: job.id, error: message },
        });
      }
      throw err;
    } finally {
      await release();
    }
  }

  private async provisionerClient(): Promise<pg.Client> {
    const client = new pg.Client({
      host: this.env.TENANT_DB_HOST,
      port: this.env.TENANT_DB_PORT,
      user: this.env.PROVISIONER_DB_USER,
      password: this.env.PROVISIONER_DB_PASSWORD,
      database: 'postgres',
      application_name: 'daliz-provisioner',
      statement_timeout: 120_000,
    });
    await client.connect();
    return client;
  }

  private async withProvisioner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = await this.provisionerClient();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async databaseRow(tenantId: string) {
    const [row] = await this.platform.db.select().from(tenantDatabases).where(eq(tenantDatabases.tenantId, tenantId));
    if (!row) throw new Error('Tenant database metadata missing');
    if (!IDENT.test(row.dbName) || !IDENT.test(row.dbUser)) throw new Error('Unsafe tenant database identifiers');
    return row;
  }

  private provisionHandlers(tenantId: string, jobId: string, payload: ProvisionPayload): Record<string, () => Promise<void>> {
    return {
      validate: async () => {
        const [tenant] = await this.platform.db.select().from(tenants).where(eq(tenants.id, tenantId));
        if (!tenant) throw new Error('Tenant not found');
        if (!['provisioning', 'provisioning_failed'].includes(tenant.status)) {
          throw new Error(`Tenant is ${tenant.status}; refusing to provision`);
        }
        await this.platform.db.update(tenants).set({ status: 'provisioning', updatedAt: new Date() }).where(eq(tenants.id, tenantId));
      },

      create_role: async () => {
        const row = await this.databaseRow(tenantId);
        const password = this.encryption.decrypt(row.dbPasswordEnc, `tenant-db:${tenantId}`);
        await this.withProvisioner(async (c) => {
          const role = c.escapeIdentifier(row.dbUser);
          const exists = await c.query('select 1 from pg_roles where rolname = $1', [row.dbUser]);
          if (exists.rowCount) {
            await c.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${c.escapeLiteral(password)}`);
          } else {
            await c.query(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 50 PASSWORD ${c.escapeLiteral(password)}`);
          }
          // PostgreSQL 16+: the creating role needs SET on the new role to make it a database owner.
          await c.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`).catch(async () => {
            await c.query(`GRANT ${role} TO CURRENT_USER`);
          });
        });
        await this.platform.db.update(tenantDatabases).set({ status: 'creating', updatedAt: new Date() }).where(eq(tenantDatabases.tenantId, tenantId));
      },

      create_database: async () => {
        const row = await this.databaseRow(tenantId);
        await this.withProvisioner(async (c) => {
          const exists = await c.query('select 1 from pg_database where datname = $1', [row.dbName]);
          if (!exists.rowCount) {
            await c.query(`CREATE DATABASE ${c.escapeIdentifier(row.dbName)} OWNER ${c.escapeIdentifier(row.dbUser)} ENCODING 'UTF8'`);
          }
        });
      },

      secure_database: async () => {
        const creds = await this.connections.credentials(tenantId, { requireReady: false });
        const pool = this.connections.createPool(creds, 'daliz-provisioner', 1);
        try {
          await hardenTenantDatabase(pool, creds.database);
        } finally {
          await pool.end().catch(() => undefined);
        }
      },

      apply_migrations: async () => {
        await this.migrator.migrateTenant(tenantId, payload.general);
      },

      configure_storage: async () => {
        await this.storage.ensureBucket();
        await this.storage.put(
          StorageService.tenantKey(tenantId, 'tenant.json'),
          Buffer.from(JSON.stringify({ tenantId, provisionedAt: new Date().toISOString() })),
          'application/json',
        );
      },

      create_tenant_admin: async () => {
        const [tenant] = await this.platform.db.select().from(tenants).where(eq(tenants.id, tenantId));
        const { accountId, accountStatus } = await this.platform.db.transaction(async (tx) => {
          const acct = await this.accounts.findOrCreatePending(payload.admin.email, payload.admin.name, tx);
          const membershipStatus = acct.status === 'active' ? 'active' : 'invited';
          await tx
            .insert(tenantMemberships)
            .values({ accountId: acct.id, tenantId, status: membershipStatus, isTenantAdmin: true })
            .onConflictDoUpdate({
              target: [tenantMemberships.accountId, tenantMemberships.tenantId],
              set: { isTenantAdmin: true, updatedAt: new Date() },
            });
          await tx.update(tenants).set({ primaryAdminAccountId: acct.id }).where(eq(tenants.id, tenant!.id));
          return { accountId: acct.id, accountStatus: acct.status };
        });
        const db = await this.tenantDb(tenantId);
        const roleIds = await getRoleIdsByKey(db, ['owner']);
        const ownerRoleId = roleIds.get('owner');
        if (!ownerRoleId) throw new Error('Owner role missing after seeding');
        await db.transaction(async (tx) => {
          await tx
            .insert(users)
            .values({
              accountId,
              email: payload.admin.email.toLowerCase(),
              name: payload.admin.name,
              status: accountStatus === 'active' ? 'active' : 'invited',
            })
            .onConflictDoNothing({ target: users.accountId });
          const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
          await tx.insert(userRoles).values({ userId: user!.id, roleId: ownerRoleId }).onConflictDoNothing();
        });
        await this.audit.tenantSystemEvent(db, {
          action: 'user.created',
          resourceType: 'user',
          resourceId: accountId,
          metadata: { email: payload.admin.email, role: SYSTEM_ROLES[0]!.key, source: 'provisioning' },
        });
      },

      send_invitation: async () => {
        if (payload.invitationSentAt) return;
        const [tenant] = await this.platform.db.select().from(tenants).where(eq(tenants.id, tenantId));
        const account = await this.accounts.findByEmail(payload.admin.email);
        if (!account) throw new Error('Tenant admin account missing');
        await this.accounts.createInvitation({
          accountId: account.id,
          email: account.email,
          tenantId,
          kind: 'tenant_admin',
          invitedBy: null,
          inviterName: payload.requestedByName ?? 'Daliz',
          workspaceName: tenant!.name,
        });
        payload.invitationSentAt = new Date().toISOString();
        await this.platform.db
          .update(tenantProvisioningJobs)
          .set({ payload: payload as unknown as Record<string, unknown> })
          .where(eq(tenantProvisioningJobs.id, jobId));
      },

      activate: async () => {
        await this.platform.db
          .update(tenants)
          .set({ status: 'active', statusReason: null, updatedAt: new Date() })
          .where(eq(tenants.id, tenantId));
        await this.directory.invalidate(tenantId);
        await this.audit.platformEvent({
          action: 'tenant.provisioned',
          tenantId,
          resourceType: 'tenant',
          resourceId: tenantId,
          actor: { type: 'system', id: null, email: null },
          metadata: { jobId, schemaVersion: this.migrator.latestVersion() },
        });
      },
    };
  }

  private async tenantDb(tenantId: string) {
    return this.connections.get(tenantId);
  }

  private decommissionHandlers(tenantId: string, payload: Record<string, unknown>): Record<string, () => Promise<void>> {
    return {
      validate: async () => {
        const [tenant] = await this.platform.db.select().from(tenants).where(eq(tenants.id, tenantId));
        if (!tenant || tenant.status !== 'decommissioning') throw new Error('Tenant is not pending decommission (cancelled?)');
      },
      revoke_sessions: async () => {
        await this.sessions.revokeAllForTenant(tenantId, 'tenant_decommissioned');
        await this.platform.db
          .update(supportSessions)
          .set({ endedAt: new Date(), endedReason: 'tenant_decommissioned' })
          .where(and(eq(supportSessions.tenantId, tenantId), isNull(supportSessions.endedAt)));
      },
      close_connections: async () => {
        await this.connections.evict(tenantId, 'decommission');
      },
      drop_database: async () => {
        const row = await this.databaseRow(tenantId);
        await this.withProvisioner((c) => dropTenantDatabase(c, row.dbName, row.dbUser));
        await this.platform.db.update(tenantDatabases).set({ status: 'dropped', updatedAt: new Date() }).where(eq(tenantDatabases.tenantId, tenantId));
      },
      drop_role: async () => {
        const row = await this.databaseRow(tenantId);
        await this.withProvisioner(async (c) => {
          await c.query(`DROP ROLE IF EXISTS ${c.escapeIdentifier(row.dbUser)}`);
        });
      },
      delete_storage: async () => {
        await this.storage.deletePrefix(`tenants/${tenantId}/`);
      },
      disable_memberships: async () => {
        await this.platform.db
          .update(tenantMemberships)
          .set({ status: 'disabled', updatedAt: new Date() })
          .where(eq(tenantMemberships.tenantId, tenantId));
        await this.platform.db.delete(tenantDomains).where(eq(tenantDomains.tenantId, tenantId));
      },
      finalize: async () => {
        await this.platform.db
          .update(tenants)
          .set({ status: 'decommissioned', decommissionedAt: new Date(), updatedAt: new Date() })
          .where(eq(tenants.id, tenantId));
        await this.directory.invalidate(tenantId);
        await this.audit.platformEvent({
          action: 'tenant.decommissioned',
          tenantId,
          resourceType: 'tenant',
          resourceId: tenantId,
          actor: { type: 'system', id: null, email: null },
          metadata: { reason: payload.reason },
        });
      },
    };
  }
}
