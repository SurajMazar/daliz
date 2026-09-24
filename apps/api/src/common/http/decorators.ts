import { SetMetadata } from '@nestjs/common';
import type { PlatformPermission, TenantPermission } from '@daliz/shared';
import type { RateLimitRule } from '../../infra/redis.js';

export const META = {
  public: 'daliz:public',
  allowMfaPending: 'daliz:allowMfaPending',
  allowWithoutMfaEnrollment: 'daliz:allowWithoutMfaEnrollment',
  tenantScoped: 'daliz:tenantScoped',
  tenantPermissions: 'daliz:tenantPermissions',
  platformPermissions: 'daliz:platformPermissions',
  stepUp: 'daliz:stepUp',
  rateLimit: 'daliz:rateLimit',
  rawResponse: 'daliz:rawResponse',
  supportWriteAllowed: 'daliz:supportWriteAllowed',
  idempotent: 'daliz:idempotent',
} as const;

/** No session required. CSRF is replaced by an Origin allow-list check on mutations. */
export const Public = () => SetMetadata(META.public, true);

/** Reachable while the session is waiting for the second factor. */
export const AllowMfaPending = () => SetMetadata(META.allowMfaPending, true);

/** Reachable even when the tenant requires MFA and the account hasn't enrolled yet. */
export const AllowWithoutMfaEnrollment = () => SetMetadata(META.allowWithoutMfaEnrollment, true);

/**
 * Resolves the tenant from the session (never from request input), opens that tenant's
 * database and loads the caller's permissions before the handler runs.
 */
export const TenantScoped = () => SetMetadata(META.tenantScoped, true);

/** All listed tenant permissions are required. Implies @TenantScoped(). */
export const RequirePermissions = (...permissions: TenantPermission[]) =>
  SetMetadata(META.tenantPermissions, permissions);

/** All listed platform permissions are required (Super Admin console). */
export const RequirePlatform = (...permissions: PlatformPermission[]) =>
  SetMetadata(META.platformPermissions, permissions);

/** Requires a recent re-authentication (password, plus TOTP when enrolled). */
export const RequireStepUp = () => SetMetadata(META.stepUp, true);

export const RateLimit = (rule: RateLimitRule) => SetMetadata(META.rateLimit, rule);

/** Skip the { success, data } envelope (streams, redirects, files). */
export const RawResponse = () => SetMetadata(META.rawResponse, true);

/**
 * Honors an `Idempotency-Key` header: a retried request with the same key and body returns
 * the original response instead of running twice. Use on important creates (financial).
 */
export const Idempotent = () => SetMetadata(META.idempotent, true);
