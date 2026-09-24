import { Injectable } from '@nestjs/common';
import {
  SUPPORT_READ_ONLY_PERMISSIONS,
  TENANT_PERMISSION_KEYS,
  isTenantPermission,
  tenantSecurityPolicySchema,
  type TenantPermission,
  type TenantSecurityPolicy,
} from '@daliz/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import type { ApiKeyPrincipal, PlatformPrincipal, SessionPrincipal, TenantContext } from '../../common/request-context.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import { supportSessions, tenantMemberships, tenants } from '../../database/platform/schema.js';
import { rolePermissions, settings, userRoles, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { DEFAULT_SECURITY_POLICY } from '../../database/tenant/tenant-seed.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';
import { TenantDirectory } from './tenant-directory.js';

const PERMS_TTL = 60;
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60_000;

export interface ResolvedTenant {
  context: TenantContext;
  security: TenantSecurityPolicy;
}

/**
 * Builds the tenant context for a request. The tenant id comes from exactly two trusted
 * places: the session's selected tenant (validated against platform memberships when it
 * was selected, and again here), or an audited, time-boxed support session. It is then
 * cross-checked against the tenant implied by the Host header.
 */
@Injectable()
export class TenantContextService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnectionManager,
    private readonly redis: RedisService,
  ) {}

  async resolve(
    session: SessionPrincipal,
    platformPrincipal: PlatformPrincipal | null,
    domainTenantId: string | null | undefined,
  ): Promise<ResolvedTenant> {
    if (session.supportSessionId) {
      return this.resolveSupport(session, platformPrincipal, domainTenantId);
    }
    const tenantId = session.activeTenantId;
    if (!tenantId) throw Errors.tenantRequired();
    if (domainTenantId && domainTenantId !== tenantId) throw Errors.tenantDomainMismatch();

    const tenant = await this.directory.get(tenantId);
    if (!tenant || tenant.status !== 'active' || tenant.organizationStatus !== 'active') throw Errors.tenantUnavailable();

    const [membership] = await this.platform.db
      .select({ status: tenantMemberships.status })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.accountId, session.accountId), eq(tenantMemberships.tenantId, tenantId)))
      .limit(1);
    if (membership?.status !== 'active') throw Errors.forbidden('You no longer have access to this workspace.');

    const db = await this.connections.get(tenantId);
    const [user] = await db
      .select({ id: users.id, status: users.status, lastActiveAt: users.lastActiveAt })
      .from(users)
      .where(eq(users.accountId, session.accountId))
      .limit(1);
    if (!user || user.status !== 'active') throw Errors.forbidden('You no longer have access to this workspace.');

    const [permissions, security] = await Promise.all([this.permissionsFor(tenantId, db, user.id), this.securityPolicy(tenantId, db)]);
    void this.recordActivity(tenantId, db, user.id, user.lastActiveAt);

    return {
      context: {
        tenantId,
        slug: tenant.slug,
        name: tenant.name,
        db,
        actor: { type: 'user', userId: user.id, accountId: session.accountId, email: session.email },
        permissions,
      },
      security,
    };
  }

  /** Tenant context for an integration's API key: only its own tenant, only its scopes. */
  async resolveApiKey(apiKey: ApiKeyPrincipal, domainTenantId: string | null | undefined): Promise<ResolvedTenant> {
    if (domainTenantId && domainTenantId !== apiKey.tenantId) throw Errors.tenantDomainMismatch();
    const tenant = await this.directory.get(apiKey.tenantId);
    if (!tenant || tenant.status !== 'active' || tenant.organizationStatus !== 'active') throw Errors.tenantUnavailable();
    const db = await this.connections.get(apiKey.tenantId);
    return {
      context: {
        tenantId: apiKey.tenantId,
        slug: tenant.slug,
        name: tenant.name,
        db,
        actor: { type: 'api_key', keyId: apiKey.keyId, name: apiKey.name },
        permissions: new Set(apiKey.scopes.filter(isTenantPermission)),
      },
      security: await this.securityPolicy(apiKey.tenantId, db),
    };
  }

  private async resolveSupport(
    session: SessionPrincipal,
    platformPrincipal: PlatformPrincipal | null,
    domainTenantId: string | null | undefined,
  ): Promise<ResolvedTenant> {
    if (!platformPrincipal?.permissions.has('platform.support_access')) throw Errors.forbidden();
    const [support] = await this.platform.db
      .select()
      .from(supportSessions)
      .where(
        and(
          eq(supportSessions.id, session.supportSessionId!),
          eq(supportSessions.accountId, session.accountId),
          isNull(supportSessions.endedAt),
          gt(supportSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!support) throw Errors.forbidden('Your support session has ended.');
    if (domainTenantId && domainTenantId !== support.tenantId) throw Errors.tenantDomainMismatch();
    const tenant = await this.directory.get(support.tenantId);
    // Support may enter suspended tenants (to help fix them) but never decommissioned ones.
    if (!tenant || !['active', 'suspended'].includes(tenant.status)) throw Errors.tenantUnavailable();

    const db = await this.connections.get(support.tenantId);
    const permissions = new Set<TenantPermission>(support.allowWrite ? TENANT_PERMISSION_KEYS : SUPPORT_READ_ONLY_PERMISSIONS);
    return {
      context: {
        tenantId: support.tenantId,
        slug: tenant.slug,
        name: tenant.name,
        db,
        actor: {
          type: 'support',
          accountId: session.accountId,
          email: session.email,
          supportSessionId: support.id,
          allowWrite: support.allowWrite,
        },
        permissions,
      },
      security: await this.securityPolicy(support.tenantId, db),
    };
  }

  async permissionsFor(tenantId: string, db: TenantDb, userId: string): Promise<Set<TenantPermission>> {
    const key = RedisKeys.tenantKey(tenantId, 'perms', userId);
    const cached = await this.redis.getJson<string[]>(key);
    if (cached) return new Set(cached.filter(isTenantPermission));
    const rows = await db
      .selectDistinct({ key: rolePermissions.permissionKey })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
    const keys = rows.map((r) => r.key).filter(isTenantPermission);
    await this.redis.setJson(key, keys, PERMS_TTL);
    return new Set(keys);
  }

  /** Call after any role, permission or user-role change in a tenant. */
  async invalidatePermissions(tenantId: string, userId?: string): Promise<void> {
    if (userId) await this.redis.del(RedisKeys.tenantKey(tenantId, 'perms', userId));
    else await this.redis.delPattern(RedisKeys.tenantKey(tenantId, 'perms', '*'));
  }

  async securityPolicy(tenantId: string, db: TenantDb): Promise<TenantSecurityPolicy> {
    const key = RedisKeys.tenantKey(tenantId, 'settings', 'security');
    const cached = await this.redis.getJson<TenantSecurityPolicy>(key);
    if (cached) return cached;
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'security'));
    const parsed = tenantSecurityPolicySchema.safeParse(row?.value);
    const policy = parsed.success ? parsed.data : DEFAULT_SECURITY_POLICY;
    await this.redis.setJson(key, policy, 60);
    return policy;
  }

  async invalidateSettings(tenantId: string, key: string): Promise<void> {
    await this.redis.del(RedisKeys.tenantKey(tenantId, 'settings', key));
  }

  private async recordActivity(tenantId: string, db: TenantDb, userId: string, lastActiveAt: Date | null): Promise<void> {
    if (lastActiveAt && Date.now() - lastActiveAt.getTime() < ACTIVITY_WRITE_INTERVAL_MS) return;
    const now = new Date();
    await Promise.all([
      db.update(users).set({ lastActiveAt: now }).where(eq(users.id, userId)),
      this.platform.db.update(tenants).set({ lastActivityAt: now }).where(eq(tenants.id, tenantId)),
    ]).catch(() => undefined);
  }
}
