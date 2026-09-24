import type { AuditRow, TenantDetail, TenantUserRow } from '@daliz/shared';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlatformDb } from '../database/platform/platform-db.js';
import { tenantDatabases } from '../database/platform/schema.js';
import { PlatformAccessService } from '../modules/platform/platform-access.service.js';
import { ProvisioningService } from '../modules/platform/provisioning.service.js';
import { PASSWORD, TestEnv, totpFor, uniqueSlug, type ApiClient } from './harness.js';

describe('platform administration', () => {
  let t: TestEnv;
  let root: ApiClient;
  let orgId: string;

  const createTenantViaApi = async (slug = uniqueSlug()) => {
    const res = await root.post<{ tenantId: string; jobId: string }>('/platform/tenants', {
      organizationId: orgId,
      name: `Tenant ${slug}`,
      slug,
      plan: 'business',
      limits: { maxUsers: 25, storageQuotaMb: 2048 },
      locale: 'en-US',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      admin: { email: `admin@${slug}.test`, name: 'Tenant Admin' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { ...res.data, slug };
  };

  const databaseExists = async (name: string) => {
    const c = new pg.Client({ host: t.env.TENANT_DB_HOST, port: t.env.TENANT_DB_PORT, user: t.env.PROVISIONER_DB_USER, password: t.env.PROVISIONER_DB_PASSWORD, database: 'postgres' });
    await c.connect();
    const r = await c.query('select 1 from pg_database where datname = $1', [name]);
    await c.end();
    return r.rowCount === 1;
  };

  beforeAll(async () => {
    t = await TestEnv.start();
    root = await t.loggedIn(await t.createSuperAdmin());
    const org = await root.post<{ id: string }>('/platform/organizations', { name: 'Initech', slug: `initech-${uniqueSlug()}`, contactEmail: 'it@initech.test' });
    orgId = org.data.id;
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('keeps tenant users and platform roles out of the platform console', async () => {
    const tenant = await t.createTenant();
    const tenantOwner = await t.loggedIn(tenant.ownerEmail);
    expect((await tenantOwner.get('/platform/tenants')).status).toBe(403);
    const auditor = await t.loggedIn(await t.createSuperAdmin(undefined, 'auditor'));
    expect((await auditor.get('/platform/tenants')).status).toBe(200);
    expect((await auditor.post('/platform/organizations', { name: 'Nope', slug: `nope-${uniqueSlug()}`, contactEmail: 'a@b.test' })).status).toBe(403);
  });

  it('requires platform admins to enrol MFA when the platform policy says so', async () => {
    const access = t.get(PlatformAccessService);
    const settings = await access.settings();
    await access.updateSettings({ ...settings, requireMfaForPlatformAdmins: true }, '00000000-0000-0000-0000-000000000000');
    try {
      const admin = await t.loggedIn(await t.createSuperAdmin());
      expect((await admin.get('/platform/dashboard')).code).toBe('MFA_ENROLLMENT_REQUIRED');
      expect((await admin.me()).data.mustEnrollMfa).toBe(true);
    } finally {
      await access.updateSettings({ ...settings, requireMfaForPlatformAdmins: false }, '00000000-0000-0000-0000-000000000000');
    }
  });

  it('provisions a tenant into its own database with an invited admin', async () => {
    const { tenantId, jobId, slug } = await createTenantViaApi();
    const before = await root.get<TenantDetail>(`/platform/tenants/${tenantId}`);
    expect(before.data.status).toBe('provisioning');
    await t.get(ProvisioningService).runJob(jobId, true);

    const detail = await root.get<TenantDetail>(`/platform/tenants/${tenantId}`);
    expect(detail.data.status).toBe('active');
    expect(detail.data.database.status).toBe('ready');
    expect(detail.data.database.schemaVersion).toMatch(/^\d{4}_/);
    expect(detail.data.provisioning?.steps.every((s) => s.status === 'done')).toBe(true);
    expect(await databaseExists(detail.data.database.name)).toBe(true);
    expect(detail.data.admins.map((a) => a.email)).toEqual([`admin@${slug}.test`]);

    // The admin gets an invitation and becomes the Owner on acceptance.
    const token = t.tokenFromEmail(await t.lastEmail(`admin@${slug}.test`, 'invitation'));
    const admin = t.client();
    expect((await admin.post('/auth/invitations/accept', { token, name: 'Tenant Admin', password: PASSWORD })).status).toBe(200);
    const me = await admin.me();
    expect(me.data.tenant?.id).toBe(tenantId);
    expect(me.data.tenant?.roles.map((r) => r.name)).toEqual(['Owner']);
    expect(me.data.tenant?.settings.timezone).toBe('Europe/Berlin');

    // Re-running a finished job is a no-op (idempotent).
    await t.get(ProvisioningService).runJob(jobId, true);
    expect((await root.get<TenantDetail>(`/platform/tenants/${tenantId}`)).data.status).toBe('active');
  });

  it('counts tenants per organization', async () => {
    await createTenantViaApi();
    const orgs = await root.get<{ id: string; tenantCount: number }[]>('/platform/organizations?pageSize=100');
    expect(orgs.data.find((o) => o.id === orgId)!.tenantCount).toBeGreaterThan(0);
  });

  it('rejects duplicate slugs', async () => {
    const { slug } = await createTenantViaApi();
    const dup = await root.post('/platform/tenants', {
      organizationId: orgId,
      name: 'Dup',
      slug,
      plan: 'business',
      limits: { maxUsers: 5, storageQuotaMb: 1024 },
      locale: 'en-US',
      timezone: 'UTC',
      currency: 'USD',
      admin: { email: 'x@dup.test', name: 'X' },
    });
    expect(dup.status).toBe(409);
  });

  it('records a failed step, keeps the tenant unreachable, and resumes on retry', async () => {
    const { tenantId, jobId } = await createTenantViaApi();
    const platform = t.get(PlatformDb);
    // Point the tenant at a port where nothing listens so the migration step fails.
    await platform.db.update(tenantDatabases).set({ dbPort: 1 }).where(eq(tenantDatabases.tenantId, tenantId));
    await expect(t.get(ProvisioningService).runJob(jobId, true)).rejects.toThrow();

    const failed = await root.get<TenantDetail>(`/platform/tenants/${tenantId}`);
    expect(failed.data.status).toBe('provisioning_failed');
    const steps = failed.data.provisioning!.steps;
    expect(steps.find((s) => s.key === 'create_database')?.status).toBe('done');
    const failedStep = steps.find((s) => s.status === 'failed');
    expect(failedStep?.key).toBe('secure_database');
    expect(failedStep?.error).not.toMatch(/password/i);

    await platform.db.update(tenantDatabases).set({ dbPort: t.env.TENANT_DB_PORT }).where(eq(tenantDatabases.tenantId, tenantId));
    const retry = await root.post<{ jobId: string }>(`/platform/tenants/${tenantId}/retry-provisioning`);
    expect(retry.status).toBe(202);
    await t.get(ProvisioningService).runJob(retry.data.jobId, true);
    expect((await root.get<TenantDetail>(`/platform/tenants/${tenantId}`)).data.status).toBe('active');
  });

  it('suspends a tenant (revoking its sessions) and reactivates it', async () => {
    const tenant = await t.createTenant();
    const user = await t.loggedIn(tenant.ownerEmail);
    expect((await user.get('/dashboard')).status).toBe(200);
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/suspend`, { reason: 'Unpaid invoice' })).status).toBe(200);
    expect((await user.get('/dashboard')).status).toBe(401);
    const again = await t.loggedIn(tenant.ownerEmail);
    expect((await again.get('/dashboard')).status).toBe(403);
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/activate`, { reason: 'Invoice paid' })).status).toBe(200);
    const back = await t.loggedIn(tenant.ownerEmail);
    expect((await back.get('/dashboard')).status).toBe(200);
  });

  it('decommissions only through the gated, multi-step workflow', async () => {
    const tenant = await t.createTenant();
    const detail = await root.get<TenantDetail>(`/platform/tenants/${tenant.tenantId}`);
    const dbName = detail.data.database.name;

    // Active tenants must be suspended first; step-up and a typed confirmation are required.
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/decommission`, { reason: 'Contract ended', confirmSlug: tenant.slug })).code).toBe('STEP_UP_REQUIRED');
    await root.stepUp();
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/decommission`, { reason: 'Contract ended', confirmSlug: tenant.slug })).status).toBe(409);
    await root.post(`/platform/tenants/${tenant.tenantId}/suspend`, { reason: 'Contract ended' });
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/decommission`, { reason: 'Contract ended', confirmSlug: 'wrong-slug' })).status).toBe(400);

    // Cancel is possible during the grace period.
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/decommission`, { reason: 'Contract ended', confirmSlug: tenant.slug })).status).toBe(202);
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/decommission/cancel`)).status).toBe(200);
    expect((await root.get<TenantDetail>(`/platform/tenants/${tenant.tenantId}`)).data.status).toBe('suspended');
    expect(await databaseExists(dbName)).toBe(true);

    // Schedule again and let it run: the database and its role are gone.
    expect((await root.post(`/platform/tenants/${tenant.tenantId}/decommission`, { reason: 'Contract ended', confirmSlug: tenant.slug })).status).toBe(202);
    const job = (await root.get<TenantDetail>(`/platform/tenants/${tenant.tenantId}`)).data.provisioning!;
    await t.get(ProvisioningService).runJob(job.id, true);
    const gone = await root.get<TenantDetail>(`/platform/tenants/${tenant.tenantId}`);
    expect(gone.data.status).toBe('decommissioned');
    expect(gone.data.database.status).toBe('dropped');
    expect(await databaseExists(dbName)).toBe(false);
    expect((await t.client().login(tenant.ownerEmail)).status).toBe(200);
  });

  it('never lets the platform lose its last Super Admin', async () => {
    const me = await root.me();
    const self = await root.patch(`/platform/admins/${me.data.account.id}`, { status: 'disabled' });
    expect([403, 409]).toContain(self.status);
  });

  describe('support access (audited impersonation)', () => {
    it('requires step-up and a reason, is read-only by default, visible to the tenant, and ends cleanly', async () => {
      const tenant = await t.createTenant();
      const supportEmail = await t.createSuperAdmin(undefined, 'support');
      const support = await t.loggedIn(supportEmail);

      const body = { reason: 'Customer ticket #4821: cannot see invoices', durationMinutes: 30, allowWrite: false };
      expect((await support.post(`/platform/tenants/${tenant.tenantId}/support-access`, body)).code).toBe('STEP_UP_REQUIRED');
      await support.stepUp();
      expect((await support.post(`/platform/tenants/${tenant.tenantId}/support-access`, { ...body, reason: 'short' })).status).toBe(422);
      // The support role can't open write sessions.
      expect((await support.post(`/platform/tenants/${tenant.tenantId}/support-access`, { ...body, allowWrite: true })).status).toBe(403);
      expect((await support.post(`/platform/tenants/${tenant.tenantId}/support-access`, body)).status).toBe(200);

      const me = await support.me();
      expect(me.data.support).toMatchObject({ tenantId: tenant.tenantId, allowWrite: false });
      expect((await support.get<TenantUserRow[]>('/users')).status).toBe(200);
      const write = await support.post('/roles', { name: 'Support was here', description: '', permissions: [] });
      expect(write.code).toBe('SUPPORT_SESSION_READ_ONLY');

      // The tenant's own admins can see that support accessed their workspace.
      const owner = await t.loggedIn(tenant.ownerEmail);
      const log = await owner.get<AuditRow[]>('/audit?action=support.');
      expect(log.data.some((e) => e.action === 'support.session_started' && e.actorEmail === supportEmail)).toBe(true);
      // And the platform side has it too.
      const platformLog = await root.get<AuditRow[]>(`/platform/audit?action=support.session_started&tenantId=${tenant.tenantId}`);
      expect(platformLog.data.length).toBeGreaterThan(0);

      expect((await support.post('/platform/support-access/end')).status).toBe(200);
      expect((await support.get('/users')).status).toBe(403);
    });

    it('expires support sessions automatically', async () => {
      const tenant = await t.createTenant();
      const email = await t.createSuperAdmin();
      const admin = await t.loggedIn(email);
      await admin.stepUp();
      await admin.post(`/platform/tenants/${tenant.tenantId}/support-access`, { reason: 'Investigating a report', durationMinutes: 5, allowWrite: true });
      expect((await admin.get('/users')).status).toBe(200);
      const { supportSessions } = await import('../database/platform/schema.js');
      await t.get(PlatformDb).db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) });
      expect((await admin.get('/users')).status).toBe(403);
    });

    it('is only for platform staff with the support permission', async () => {
      const tenant = await t.createTenant();
      const other = await t.createTenant();
      const owner = await t.loggedIn(tenant.ownerEmail);
      await owner.stepUp();
      expect((await owner.post(`/platform/tenants/${other.tenantId}/support-access`, { reason: 'I want to look around', durationMinutes: 30, allowWrite: false })).status).toBe(403);
    });
  });

  it('protects MFA-enrolled admins with step-up that needs a TOTP code', async () => {
    const email = await t.createSuperAdmin();
    const admin = await t.loggedIn(email);
    const setup = await admin.post<{ secret: string }>('/auth/mfa/setup');
    await admin.post('/auth/mfa/enable', { code: totpFor(setup.data.secret) });
    expect((await admin.stepUp()).status).toBe(400);
    expect((await admin.stepUp(PASSWORD, totpFor(setup.data.secret, 1))).status).toBe(200);
  });
});
