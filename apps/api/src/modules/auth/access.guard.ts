import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission, TenantPermission } from '@daliz/shared';
import type { Request, Response } from 'express';
import { ENV, type Env } from '../../config/env.js';
import { Errors } from '../../common/errors.js';
import { META } from '../../common/http/decorators.js';
import { RequestContext } from '../../common/request-context.js';
import { RATE_LIMITS, RateLimiter, type RateLimitRule } from '../../infra/redis.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiKeysService } from '../integrations/api-keys.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { DomainResolver } from '../tenancy/domain-resolver.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The single global guard. Every request passes these checks in this order:
 *
 *   1. Session        cookie → live session (or 401 unless @Public)
 *   2. MFA stage      half-authenticated sessions only reach @AllowMfaPending routes
 *   3. CSRF / Origin  mutations need the session-bound CSRF token; Origin must be allowed
 *   4. Platform role  loaded for platform admins
 *   5. Maintenance    non-admins get 503 while maintenance mode is on
 *   6. Rate limit     per route rule, per account (or IP when anonymous)
 *   7. Platform perms @RequirePlatform(...) + platform host + platform MFA policy
 *   8. Tenant         @TenantScoped/@RequirePermissions: resolve tenant from the session,
 *                     enforce the tenant's session and MFA policy, support read-only mode
 *   9. Tenant perms   every listed permission must be held
 *  10. Step-up        @RequireStepUp needs a recent re-authentication
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: SessionService,
    private readonly platformAccess: PlatformAccessService,
    private readonly tenants: TenantContextService,
    private readonly domains: DomainResolver,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const store = RequestContext.require();

    const isPublic = this.meta<boolean>(META.public, ctx) ?? false;
    const allowMfaPending = this.meta<boolean>(META.allowMfaPending, ctx) ?? false;
    const tenantPerms = this.meta<TenantPermission[]>(META.tenantPermissions, ctx);
    const tenantScoped = (this.meta<boolean>(META.tenantScoped, ctx) ?? false) || !!tenantPerms;
    const platformPerms = this.meta<PlatformPermission[]>(META.platformPermissions, ctx);
    const needsStepUp = this.meta<boolean>(META.stepUp, ctx) ?? false;
    const rule = this.meta<RateLimitRule>(META.rateLimit, ctx);

    // 1. Session
    const token = (req.cookies as Record<string, string> | undefined)?.[this.sessions.cookieName];
    const loaded = token ? await this.sessions.load(token) : null;
    if (token && !loaded) this.sessions.clearCookie(res);
    if (loaded && token) {
      store.session = {
        sessionId: loaded.id,
        accountId: loaded.accountId,
        email: loaded.account.email,
        name: loaded.account.name,
        stage: loaded.stage,
        mfaEnabled: loaded.account.mfaEnabled,
        activeTenantId: loaded.activeTenantId,
        supportSessionId: loaded.supportSessionId,
        stepUpUntil: loaded.stepUpUntil ? new Date(loaded.stepUpUntil) : null,
      };
      await this.sessions.touch(loaded, token);
    }
    // Integrations authenticate with `Authorization: Bearer dz_…` instead of a cookie.
    const authz = req.headers.authorization;
    if (!store.session && typeof authz === 'string' && authz.startsWith('Bearer ')) {
      const principal = await this.apiKeys.authenticate(authz.slice(7).trim());
      if (!principal) throw Errors.unauthenticated('The API key is invalid, expired or revoked.');
      store.apiKey = principal;
      if (!tenantScoped && !isPublic) throw Errors.forbidden('API keys can only call workspace data endpoints.');
    }
    if (!isPublic && !store.session && !store.apiKey) throw Errors.unauthenticated();

    // 2. MFA stage
    if (store.session?.stage === 'mfa_pending' && !allowMfaPending && !isPublic) throw Errors.mfaRequired();

    // 3. CSRF / Origin
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !(await this.domains.isAllowedOrigin(origin, this.env.CORS_EXTRA_ORIGINS))) throw Errors.csrf();
      if (store.session && !isPublic) {
        const presented = req.headers['x-csrf-token'];
        if (!this.sessions.verifyCsrf(store.session.sessionId, typeof presented === 'string' ? presented : undefined)) {
          throw Errors.csrf();
        }
      }
    }

    // 4. Platform role
    store.platform =
      store.session && store.session.stage === 'active' ? await this.platformAccess.principal(store.session.accountId) : null;

    // 5. Maintenance
    if (!isPublic && !store.platform) {
      const settings = await this.platformAccess.settings();
      if (settings.maintenanceMode) throw Errors.maintenance(settings.maintenanceMessage);
    }

    // 6. Rate limit
    const effectiveRule = rule ?? (store.session || store.apiKey ? RATE_LIMITS.apiDefault : RATE_LIMITS.apiAnonymous);
    await this.limiter.enforce(effectiveRule, store.apiKey ? `key:${store.apiKey.keyId}` : (store.session?.accountId ?? store.ip ?? 'unknown'));

    // 7. Platform permissions
    if (platformPerms) {
      if (!this.domains.isPlatformHost(store.host)) throw Errors.notFound();
      const principal = store.platform;
      if (!principal) throw Errors.forbidden();
      const settings = await this.platformAccess.settings();
      if (settings.requireMfaForPlatformAdmins && !store.session!.mfaEnabled) throw Errors.mfaEnrollmentRequired();
      const missing = platformPerms.filter((p) => !principal.permissions.has(p));
      if (missing.length) {
        await this.audit.platformEvent({ action: 'access.denied', outcome: 'denied', metadata: { missing, route: req.route?.path } });
        throw Errors.forbidden();
      }
    }

    // 8. Tenant
    if (tenantScoped) {
      const session = store.session;
      const resolved = store.apiKey
        ? await this.tenants.resolveApiKey(store.apiKey, store.domainTenantId)
        : await this.tenants.resolve(session!, store.platform ?? null, store.domainTenantId);
      store.tenant = resolved.context;
      const actor = resolved.context.actor;

      if (actor.type === 'user' && session) {
        if (Date.now() - new Date(loaded!.createdAt).getTime() > resolved.security.sessionMaxHours * 3600_000) {
          await this.sessions.revoke(session.sessionId, 'tenant_max_age');
          this.sessions.clearCookie(res);
          throw Errors.unauthenticated('Your session expired. Sign in again.');
        }
        if (Date.now() - new Date(loaded!.lastSeenAt).getTime() > resolved.security.sessionIdleMinutes * 60_000) {
          await this.sessions.revoke(session.sessionId, 'tenant_idle');
          this.sessions.clearCookie(res);
          throw Errors.unauthenticated('You were signed out after a period of inactivity.');
        }
        const allowWithoutMfa = this.meta<boolean>(META.allowWithoutMfaEnrollment, ctx) ?? false;
        if (resolved.security.requireMfa && !session.mfaEnabled && !allowWithoutMfa) throw Errors.mfaEnrollmentRequired();
      } else if (actor.type === 'support' && !actor.allowWrite && !SAFE_METHODS.has(req.method)) {
        throw Errors.supportReadOnly();
      }

      // 9. Tenant permissions
      if (tenantPerms?.length) {
        const missing = tenantPerms.filter((p) => !resolved.context.permissions.has(p));
        if (missing.length) {
          await this.audit.tenantEvent({ action: 'access.denied', outcome: 'denied', metadata: { missing, route: req.route?.path, method: req.method } });
          throw Errors.forbidden();
        }
      }
    }

    // 10. Step-up
    if (needsStepUp) {
      const until = store.session?.stepUpUntil;
      if (!until || until.getTime() < Date.now()) throw Errors.stepUpRequired();
    }

    return true;
  }
}
