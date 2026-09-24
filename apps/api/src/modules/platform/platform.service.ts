import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditRow,
  CreateOrganizationInput,
  OrganizationRow,
  Paginated,
  PlatformAdminRow,
  PlatformDashboard,
  PlatformRoleKey,
  PlatformSettings,
  SecurityEventRow,
  SupportAccessInput,
  TenantDetail,
  TenantLimits,
  TenantRow,
} from '@daliz/shared';
import { and, count, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { ENV, type Env } from '../../config/env.js';
import { Errors } from '../../common/errors.js';
import { qcol } from '../../common/sql.js';
import { RequestContext } from '../../common/request-context.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import {
  accounts,
  featureFlags,
  organizations,
  platformAdmins,
  platformAuditLogs,
  securityEvents,
  supportSessions,
  tenantDatabases,
  tenantDomains,
  tenantMemberships,
  tenantProvisioningJobs,
  tenants,
} from '../../database/platform/schema.js';
import { userRoles, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import { countRows, getRoleIdsByKey } from '../../database/tenant/tenant-seed.js';
import { QueueService } from '../../infra/queue.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { SessionService } from '../auth/session.service.js';
import { HealthService } from '../health/health.service.js';
import { DomainResolver } from '../tenancy/domain-resolver.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';
import { PlatformAccessService } from './platform-access.service.js';

interface ListQuery {
  page: number;
  pageSize: number;
  q?: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

@Injectable()
export class PlatformService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly connections: TenantConnectionManager,
    private readonly directory: TenantDirectory,
    private readonly domains: DomainResolver,
    private readonly access: PlatformAccessService,
    private readonly health: HealthService,
    private readonly queue: QueueService,
  ) {}

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  async dashboard(): Promise<PlatformDashboard> {
    const [orgCount] = await this.platform.db.select({ n: count() }).from(organizations);
    const statusRows = await this.platform.db.select({ status: tenants.status, n: count() }).from(tenants).groupBy(tenants.status);
    const [acctCount] = await this.platform.db.select({ n: count() }).from(accounts).where(eq(accounts.status, 'active'));
    const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
    const recent = await this.securityEvents({ page: 1, pageSize: 8 });
    return {
      organizations: Number(orgCount?.n ?? 0),
      tenants: {
        total: statusRows.filter((r) => r.status !== 'decommissioned').reduce((a, r) => a + Number(r.n), 0),
        active: byStatus.active ?? 0,
        suspended: byStatus.suspended ?? 0,
        provisioning: byStatus.provisioning ?? 0,
        failed: byStatus.provisioning_failed ?? 0,
      },
      accounts: Number(acctCount?.n ?? 0),
      recentSecurityEvents: recent.items,
      health: await this.health.report(),
    };
  }

  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------

  async listOrganizations(q: ListQuery): Promise<Paginated<OrganizationRow>> {
    const where = q.q ? or(ilike(organizations.name, `%${q.q}%`), ilike(organizations.slug, `%${q.q}%`)) : undefined;
    const [total] = await this.platform.db.select({ n: count() }).from(organizations).where(where);
    const rows = await this.platform.db
      .select({
        org: organizations,
        tenantCount: sql<number>`(select count(*)::int from ${tenants} t where t.organization_id = ${qcol(organizations.id)} and t.status <> 'decommissioned')`,
      })
      .from(organizations)
      .where(where)
      .orderBy(organizations.name)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ org, tenantCount }) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        contactEmail: org.contactEmail,
        status: org.status,
        tenantCount: Number(tenantCount),
        createdAt: org.createdAt.toISOString(),
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) },
    };
  }

  async createOrganization(input: CreateOrganizationInput): Promise<{ id: string }> {
    const session = RequestContext.session();
    const [row] = await this.platform.db
      .insert(organizations)
      .values({ ...input, createdBy: session.accountId })
      .returning({ id: organizations.id });
    await this.audit.platformEvent({ action: 'organization.created', resourceType: 'organization', resourceId: row!.id, metadata: { name: input.name, slug: input.slug } });
    return row!;
  }

  async updateOrganization(id: string, patch: Partial<CreateOrganizationInput> & { status?: 'active' | 'suspended' }): Promise<void> {
    const updated = await this.platform.db
      .update(organizations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(organizations.id, id))
      .returning({ id: organizations.id });
    if (!updated.length) throw Errors.notFound();
    const orgTenants = await this.platform.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.organizationId, id));
    await Promise.all(orgTenants.map((t) => this.directory.invalidate(t.id)));
    if (patch.status === 'suspended') {
      await Promise.all(orgTenants.map((t) => this.sessions.revokeAllForTenant(t.id, 'organization_suspended')));
    }
    await this.audit.platformEvent({ action: 'organization.updated', resourceType: 'organization', resourceId: id, metadata: patch });
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------

  private tenantRowSelect() {
    return {
      id: tenants.id,
      organizationId: tenants.organizationId,
      organizationName: organizations.name,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      plan: tenants.plan,
      databaseStatus: tenantDatabases.status,
      schemaVersion: tenantDatabases.schemaVersion,
      primaryAdminEmail: accounts.email,
      createdAt: tenants.createdAt,
      lastActivityAt: tenants.lastActivityAt,
    };
  }

  async listTenants(q: ListQuery & { status?: string; organizationId?: string }): Promise<Paginated<TenantRow>> {
    const filters: (SQL | undefined)[] = [
      q.q ? or(ilike(tenants.name, `%${q.q}%`), ilike(tenants.slug, `%${q.q}%`), ilike(organizations.name, `%${q.q}%`)) : undefined,
      q.status ? eq(tenants.status, q.status as TenantRow['status']) : sql`${tenants.status} <> 'decommissioned'`,
      q.organizationId ? eq(tenants.organizationId, q.organizationId) : undefined,
    ];
    const where = and(...filters);
    const [total] = await this.platform.db
      .select({ n: count() })
      .from(tenants)
      .innerJoin(organizations, eq(organizations.id, tenants.organizationId))
      .where(where);
    const rows = await this.platform.db
      .select(this.tenantRowSelect())
      .from(tenants)
      .innerJoin(organizations, eq(organizations.id, tenants.organizationId))
      .leftJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
      .leftJoin(accounts, eq(accounts.id, tenants.primaryAdminAccountId))
      .where(where)
      .orderBy(desc(tenants.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map((r) => this.toTenantRow(r)),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) },
    };
  }

  private toTenantRow(r: {
    id: string;
    organizationId: string;
    organizationName: string;
    name: string;
    slug: string;
    status: string;
    plan: string;
    databaseStatus: string | null;
    schemaVersion: string | null;
    primaryAdminEmail: string | null;
    createdAt: Date;
    lastActivityAt: Date | null;
  }): TenantRow {
    return {
      ...r,
      status: r.status as TenantRow['status'],
      databaseStatus: (r.databaseStatus ?? 'pending') as TenantRow['databaseStatus'],
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: iso(r.lastActivityAt),
    };
  }

  async tenantDetail(id: string): Promise<TenantDetail> {
    const [row] = await this.platform.db
      .select({
        ...this.tenantRowSelect(),
        maxUsers: tenants.maxUsers,
        storageQuotaMb: tenants.storageQuotaMb,
        locale: tenants.locale,
        timezone: tenants.timezone,
        currency: tenants.currency,
        statusReason: tenants.statusReason,
        dbName: tenantDatabases.dbName,
        dbHost: tenantDatabases.dbHost,
      })
      .from(tenants)
      .innerJoin(organizations, eq(organizations.id, tenants.organizationId))
      .leftJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
      .leftJoin(accounts, eq(accounts.id, tenants.primaryAdminAccountId))
      .where(eq(tenants.id, id));
    if (!row) throw Errors.notFound();

    const domains = await this.platform.db.select().from(tenantDomains).where(eq(tenantDomains.tenantId, id)).orderBy(tenantDomains.domain);
    const admins = await this.platform.db
      .select({ accountId: accounts.id, email: accounts.email, name: accounts.name, status: tenantMemberships.status })
      .from(tenantMemberships)
      .innerJoin(accounts, eq(accounts.id, tenantMemberships.accountId))
      .where(and(eq(tenantMemberships.tenantId, id), eq(tenantMemberships.isTenantAdmin, true)));
    const [job] = await this.platform.db
      .select()
      .from(tenantProvisioningJobs)
      .where(eq(tenantProvisioningJobs.tenantId, id))
      .orderBy(desc(tenantProvisioningJobs.createdAt))
      .limit(1);
    let userCount: number | null = null;
    if (row.status === 'active' || row.status === 'suspended') {
      // A count only — platform admins don't read tenant business data without support access.
      userCount = await this.connections
        .get(id)
        .then((db) => countRows(db, 'users'))
        .catch(() => null);
    }
    return {
      ...this.toTenantRow(row),
      limits: { maxUsers: row.maxUsers, storageQuotaMb: row.storageQuotaMb },
      locale: row.locale,
      timezone: row.timezone,
      currency: row.currency,
      statusReason: row.statusReason,
      domains: domains.map((d) => ({
        id: d.id,
        domain: d.domain,
        verified: !!d.verifiedAt,
        isPrimary: d.isPrimary,
        verificationRecord: d.verifiedAt ? null : { name: `_daliz-verification.${d.domain}`, value: d.verificationToken },
      })),
      admins,
      database: {
        name: row.dbName ?? '',
        host: row.dbHost ?? '',
        status: (row.databaseStatus ?? 'pending') as TenantRow['databaseStatus'],
        schemaVersion: row.schemaVersion,
      },
      provisioning: job
        ? {
            id: job.id,
            status: job.status,
            attempts: job.attempts,
            steps: job.steps,
            lastError: job.lastError,
            updatedAt: job.updatedAt.toISOString(),
          }
        : null,
      userCount,
    };
  }

  async updateTenant(id: string, patch: { name?: string; plan?: string; limits?: TenantLimits }): Promise<void> {
    const updated = await this.platform.db
      .update(tenants)
      .set({
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.plan ? { plan: patch.plan } : {}),
        ...(patch.limits ? { maxUsers: patch.limits.maxUsers, storageQuotaMb: patch.limits.storageQuotaMb } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id });
    if (!updated.length) throw Errors.notFound();
    await this.directory.invalidate(id);
    await this.audit.platformEvent({ action: 'tenant.updated', tenantId: id, resourceType: 'tenant', resourceId: id, metadata: patch });
  }

  async enqueueTenantMigration(tenantId: string): Promise<{ jobId: string }> {
    const [tenant] = await this.platform.db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw Errors.notFound();
    if (!['active', 'suspended'].includes(tenant.status)) throw Errors.conflict('Only live tenants can be migrated.');
    const [job] = await this.platform.db
      .insert(tenantProvisioningJobs)
      .values({ tenantId, kind: 'migrate', status: 'queued', steps: [{ key: 'apply_migrations', status: 'pending' }], requestedBy: RequestContext.session().accountId })
      .returning({ id: tenantProvisioningJobs.id });
    await this.queue.enqueueProvisioning({ kind: 'migrate', tenantId, provisioningJobId: job!.id });
    await this.audit.platformEvent({ action: 'tenant.migration_requested', tenantId, resourceType: 'tenant', resourceId: tenantId });
    return { jobId: job!.id };
  }

  async enqueueMigrateAll(): Promise<{ jobId: string }> {
    const jobId = await this.queue.enqueueMigrateAll({ kind: 'migrate-all', requestedBy: RequestContext.session().accountId });
    await this.audit.platformEvent({ action: 'tenant.migrate_all_requested', metadata: { jobId } });
    return { jobId };
  }

  // -------------------------------------------------------------------------
  // Domains
  // -------------------------------------------------------------------------

  async addDomain(tenantId: string, domain: string): Promise<{ id: string; verificationRecord: { name: string; value: string } }> {
    await this.requireTenant(tenantId);
    if (domain.endsWith(`.${this.env.TENANT_BASE_DOMAIN}`)) throw Errors.badRequest('Subdomains of the platform domain are assigned automatically.');
    const token = `daliz-verify=${randomBytes(16).toString('hex')}`;
    const [row] = await this.platform.db
      .insert(tenantDomains)
      .values({ tenantId, domain, verificationToken: token })
      .returning({ id: tenantDomains.id });
    await this.audit.platformEvent({ action: 'tenant.domain_added', tenantId, resourceType: 'tenant_domain', resourceId: row!.id, metadata: { domain } });
    return { id: row!.id, verificationRecord: { name: `_daliz-verification.${domain}`, value: token } };
  }

  async verifyDomain(tenantId: string, domainId: string): Promise<{ verified: boolean }> {
    const [row] = await this.platform.db
      .select()
      .from(tenantDomains)
      .where(and(eq(tenantDomains.id, domainId), eq(tenantDomains.tenantId, tenantId)));
    if (!row) throw Errors.notFound();
    let verified = false;
    const devDomain = this.env.NODE_ENV !== 'production' && /\.(test|localhost)$/.test(row.domain);
    if (devDomain) verified = true;
    else {
      try {
        const records = await resolveTxt(`_daliz-verification.${row.domain}`);
        verified = records.some((chunks) => chunks.join('') === row.verificationToken);
      } catch {
        verified = false;
      }
    }
    if (verified) {
      await this.platform.db.update(tenantDomains).set({ verifiedAt: new Date() }).where(eq(tenantDomains.id, domainId));
      await this.domains.invalidateHost(row.domain);
    }
    await this.audit.platformEvent({
      action: 'tenant.domain_verification',
      outcome: verified ? 'success' : 'failure',
      tenantId,
      resourceType: 'tenant_domain',
      resourceId: domainId,
      metadata: { domain: row.domain },
    });
    return { verified };
  }

  async removeDomain(tenantId: string, domainId: string): Promise<void> {
    const [row] = await this.platform.db
      .delete(tenantDomains)
      .where(and(eq(tenantDomains.id, domainId), eq(tenantDomains.tenantId, tenantId)))
      .returning();
    if (!row) throw Errors.notFound();
    await this.domains.invalidateHost(row.domain);
    await this.audit.platformEvent({ action: 'tenant.domain_removed', tenantId, resourceType: 'tenant_domain', resourceId: domainId, metadata: { domain: row.domain } });
  }

  // -------------------------------------------------------------------------
  // Tenant admins
  // -------------------------------------------------------------------------

  async addTenantAdmin(tenantId: string, email: string, name: string): Promise<void> {
    const tenant = await this.requireTenant(tenantId);
    if (tenant.status !== 'active') throw Errors.conflict('The tenant must be active.');
    const session = RequestContext.session();
    const acct = await this.platform.db.transaction(async (tx) => {
      const a = await this.accounts.findOrCreatePending(email, name, tx);
      await tx
        .insert(tenantMemberships)
        .values({ accountId: a.id, tenantId, status: 'invited', isTenantAdmin: true })
        .onConflictDoUpdate({ target: [tenantMemberships.accountId, tenantMemberships.tenantId], set: { isTenantAdmin: true, updatedAt: new Date() } });
      return a;
    });
    const db = await this.connections.get(tenantId);
    const roleIds = await getRoleIdsByKey(db, ['admin']);
    await db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({ accountId: acct.id, email: email.toLowerCase(), name, status: 'invited' })
        .onConflictDoNothing({ target: users.accountId });
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.accountId, acct.id));
      await tx.insert(userRoles).values({ userId: u!.id, roleId: roleIds.get('admin')! }).onConflictDoNothing();
    });
    await this.accounts.createInvitation({
      accountId: acct.id,
      email,
      tenantId,
      kind: 'tenant_admin',
      invitedBy: session.accountId,
      inviterName: session.name,
      workspaceName: tenant.name,
    });
    await this.audit.platformEvent({ action: 'tenant.admin_added', tenantId, resourceType: 'account', resourceId: acct.id, metadata: { email } });
  }

  /** Support action for locked-out tenant admins: revoke sessions, optionally reset MFA, send reset link. */
  async resetTenantAdminAccess(tenantId: string, accountId: string, resetMfa: boolean): Promise<void> {
    const [membership] = await this.platform.db
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.accountId, accountId), eq(tenantMemberships.isTenantAdmin, true)));
    if (!membership) throw Errors.notFound();
    const account = await this.accounts.findById(accountId);
    if (!account) throw Errors.notFound();
    const revoked = await this.sessions.revokeAllForAccount(accountId, 'admin_access_reset');
    if (resetMfa) await this.mfa.disable(accountId);
    if (account.status === 'active') {
      const token = await this.accounts.issueEmailToken(accountId, 'reset_password');
      await this.queue.enqueueEmail({
        tenantId,
        to: account.email,
        template: 'password_reset',
        data: { url: `${this.env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}` },
      });
    }
    await this.audit.securityEvent({ type: 'admin.access_reset', severity: 'critical', accountId, email: account.email, tenantId, metadata: { resetMfa, revokedSessions: revoked } });
    await this.audit.platformEvent({ action: 'tenant.admin_access_reset', tenantId, resourceType: 'account', resourceId: accountId, metadata: { resetMfa } });
  }

  // -------------------------------------------------------------------------
  // Support access (audited impersonation)
  // -------------------------------------------------------------------------

  async startSupportSession(tenantId: string, input: SupportAccessInput, canWrite: boolean): Promise<{ token: string; expiresAt: Date; absoluteExpiresAt: Date }> {
    const session = RequestContext.session();
    const ctx = RequestContext.require();
    const tenant = await this.requireTenant(tenantId);
    if (!['active', 'suspended'].includes(tenant.status)) throw Errors.conflict('Support access is only available for live tenants.');
    if (input.allowWrite && !canWrite) throw Errors.forbidden('Your role can only open read-only support sessions.');
    const expiresAt = new Date(Date.now() + input.durationMinutes * 60_000);
    await this.platform.db
      .update(supportSessions)
      .set({ endedAt: new Date(), endedReason: 'superseded' })
      .where(and(eq(supportSessions.accountId, session.accountId), isNull(supportSessions.endedAt)));
    const [support] = await this.platform.db
      .insert(supportSessions)
      .values({
        accountId: session.accountId,
        tenantId,
        reason: input.reason,
        allowWrite: input.allowWrite,
        expiresAt,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .returning({ id: supportSessions.id });
    await this.sessions.update(session.sessionId, { supportSessionId: support!.id, activeTenantId: null });
    const rotated = await this.sessions.rotate(session.sessionId);
    await this.audit.securityEvent({
      type: 'support.session_started',
      severity: 'critical',
      accountId: session.accountId,
      email: session.email,
      tenantId,
      metadata: { supportSessionId: support!.id, allowWrite: input.allowWrite, durationMinutes: input.durationMinutes },
    });
    await this.audit.platformEvent({
      action: 'support.session_started',
      tenantId,
      resourceType: 'support_session',
      resourceId: support!.id,
      metadata: { reason: input.reason, allowWrite: input.allowWrite, expiresAt: expiresAt.toISOString() },
    });
    // Visible to the tenant's own admins in their audit log.
    const db = await this.connections.get(tenantId);
    await this.audit.tenantSystemEvent(db, {
      action: 'support.session_started',
      resourceType: 'support_session',
      resourceId: support!.id,
      actor: { type: 'support', id: session.accountId, email: session.email },
      metadata: { reason: input.reason, allowWrite: input.allowWrite, expiresAt: expiresAt.toISOString() },
    });
    return { token: rotated.token, expiresAt, absoluteExpiresAt: rotated.absoluteExpiresAt };
  }

  async endSupportSession(): Promise<void> {
    const session = RequestContext.session();
    if (!session.supportSessionId) throw Errors.badRequest('No support session is active.');
    const [ended] = await this.platform.db
      .update(supportSessions)
      .set({ endedAt: new Date(), endedReason: 'ended_by_operator' })
      .where(and(eq(supportSessions.id, session.supportSessionId), isNull(supportSessions.endedAt)))
      .returning();
    await this.sessions.update(session.sessionId, { supportSessionId: null });
    if (ended) {
      await this.audit.platformEvent({ action: 'support.session_ended', tenantId: ended.tenantId, resourceType: 'support_session', resourceId: ended.id });
      const db = await this.connections.get(ended.tenantId).catch(() => null);
      if (db) {
        await this.audit.tenantSystemEvent(db, {
          action: 'support.session_ended',
          resourceType: 'support_session',
          resourceId: ended.id,
          actor: { type: 'support', id: session.accountId, email: session.email },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Audit & security events
  // -------------------------------------------------------------------------

  async auditLog(q: ListQuery & { action?: string; tenantId?: string; outcome?: string; from?: Date; to?: Date }): Promise<Paginated<AuditRow>> {
    const where = and(
      q.action ? ilike(platformAuditLogs.action, `${q.action}%`) : undefined,
      q.tenantId ? eq(platformAuditLogs.tenantId, q.tenantId) : undefined,
      q.outcome ? eq(platformAuditLogs.outcome, q.outcome as AuditRow['outcome']) : undefined,
      q.from ? gte(platformAuditLogs.occurredAt, q.from) : undefined,
      q.to ? lte(platformAuditLogs.occurredAt, q.to) : undefined,
      q.q ? or(ilike(platformAuditLogs.actorEmail, `%${q.q}%`), ilike(platformAuditLogs.action, `%${q.q}%`)) : undefined,
    );
    const [total] = await this.platform.db.select({ n: count() }).from(platformAuditLogs).where(where);
    const rows = await this.platform.db
      .select()
      .from(platformAuditLogs)
      .where(where)
      .orderBy(desc(platformAuditLogs.occurredAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        actorType: r.actorType,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        outcome: r.outcome,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        requestId: r.requestId,
        metadata: { ...r.metadata, ...(r.tenantId ? { tenantId: r.tenantId } : {}) },
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) },
    };
  }

  async securityEvents(q: ListQuery & { severity?: string }): Promise<Paginated<SecurityEventRow>> {
    const where = and(
      q.severity ? eq(securityEvents.severity, q.severity as SecurityEventRow['severity']) : undefined,
      q.q ? or(ilike(securityEvents.email, `%${q.q}%`), ilike(securityEvents.type, `%${q.q}%`)) : undefined,
    );
    const [total] = await this.platform.db.select({ n: count() }).from(securityEvents).where(where);
    const rows = await this.platform.db
      .select()
      .from(securityEvents)
      .where(where)
      .orderBy(desc(securityEvents.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        severity: r.severity,
        accountId: r.accountId,
        email: r.email,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        metadata: r.metadata,
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) },
    };
  }

  // -------------------------------------------------------------------------
  // Platform admins
  // -------------------------------------------------------------------------

  async listAdmins(): Promise<PlatformAdminRow[]> {
    const rows = await this.platform.db
      .select({
        accountId: accounts.id,
        email: accounts.email,
        name: accounts.name,
        role: platformAdmins.roleKey,
        status: platformAdmins.status,
        mfaEnabled: accounts.mfaEnabled,
        lastLoginAt: accounts.lastLoginAt,
      })
      .from(platformAdmins)
      .innerJoin(accounts, eq(accounts.id, platformAdmins.accountId))
      .orderBy(accounts.email);
    return rows.map((r) => ({ ...r, role: r.role as PlatformRoleKey, lastLoginAt: iso(r.lastLoginAt) }));
  }

  async createAdmin(email: string, name: string, role: PlatformRoleKey): Promise<void> {
    const session = RequestContext.session();
    const acct = await this.platform.db.transaction(async (tx) => {
      const a = await this.accounts.findOrCreatePending(email, name, tx);
      const [existing] = await tx.select().from(platformAdmins).where(eq(platformAdmins.accountId, a.id));
      if (existing) throw Errors.conflict('That account is already a platform administrator.');
      await tx.insert(platformAdmins).values({ accountId: a.id, roleKey: role, status: 'active', createdBy: session.accountId });
      return a;
    });
    await this.access.invalidate(acct.id);
    if (acct.status !== 'active') {
      await this.accounts.createInvitation({
        accountId: acct.id,
        email,
        tenantId: null,
        kind: 'platform_admin',
        invitedBy: session.accountId,
        inviterName: session.name,
        workspaceName: 'Daliz Platform',
      });
    }
    await this.audit.securityEvent({ type: 'platform_admin.created', severity: 'critical', accountId: acct.id, email, metadata: { role } });
    await this.audit.platformEvent({ action: 'platform_admin.created', resourceType: 'account', resourceId: acct.id, metadata: { email, role } });
  }

  async updateAdmin(accountId: string, patch: { role?: PlatformRoleKey; status?: 'active' | 'disabled' }): Promise<void> {
    const session = RequestContext.session();
    if (accountId === session.accountId) throw Errors.forbidden('You cannot change your own platform role or status.');
    if (patch.role !== 'super_admin' || patch.status === 'disabled') {
      // Never allow the platform to end up with zero active super admins.
      const [target] = await this.platform.db.select().from(platformAdmins).where(eq(platformAdmins.accountId, accountId));
      if (!target) throw Errors.notFound();
      if (target.roleKey === 'super_admin' && (patch.status === 'disabled' || (patch.role && patch.role !== 'super_admin'))) {
        const [n] = await this.platform.db
          .select({ n: count() })
          .from(platformAdmins)
          .where(and(eq(platformAdmins.roleKey, 'super_admin'), eq(platformAdmins.status, 'active')));
        if (Number(n?.n ?? 0) <= 1) throw Errors.conflict('At least one active Super Admin is required.');
      }
    }
    await this.platform.db
      .update(platformAdmins)
      .set({ ...(patch.role ? { roleKey: patch.role } : {}), ...(patch.status ? { status: patch.status } : {}), updatedAt: new Date() })
      .where(eq(platformAdmins.accountId, accountId));
    await this.access.invalidate(accountId);
    if (patch.status === 'disabled') await this.sessions.revokeAllForAccount(accountId, 'platform_admin_disabled');
    await this.audit.securityEvent({ type: 'platform_admin.updated', severity: 'critical', accountId, metadata: patch });
    await this.audit.platformEvent({ action: 'platform_admin.updated', resourceType: 'account', resourceId: accountId, metadata: patch });
  }

  async updateSettings(value: PlatformSettings): Promise<void> {
    const before = await this.access.settings();
    await this.access.updateSettings(value, RequestContext.session().accountId);
    const changed = (Object.keys(value) as (keyof PlatformSettings)[]).filter((k) => value[k] !== before[k]);
    await this.audit.platformEvent({ action: 'platform.settings_updated', metadata: { changed } });
    if (changed.includes('maintenanceMode')) {
      await this.audit.securityEvent({ type: 'platform.maintenance_mode', severity: 'warning', metadata: { enabled: value.maintenanceMode } });
    }
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  async listFlags() {
    const rows = await this.platform.db.select().from(featureFlags).orderBy(featureFlags.key);
    return rows.map((r) => ({ key: r.key, description: r.description, enabled: r.enabled, updatedAt: r.updatedAt.toISOString() }));
  }

  async upsertFlag(input: { key: string; description: string; enabled: boolean }): Promise<void> {
    await this.platform.db
      .insert(featureFlags)
      .values(input)
      .onConflictDoUpdate({ target: featureFlags.key, set: { description: input.description, enabled: input.enabled, updatedAt: new Date() } });
    await this.audit.platformEvent({ action: 'feature_flag.updated', resourceType: 'feature_flag', resourceId: input.key, metadata: { enabled: input.enabled } });
  }

  private async requireTenant(id: string) {
    const [row] = await this.platform.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row) throw Errors.notFound();
    return row;
  }
}
