import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@daliz/shared';

/**
 * The only exception type business code should throw. `message` is safe to show to users;
 * anything sensitive goes in `internal`, which is logged but never returned.
 */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: { path: string; message: string }[],
    readonly internal?: unknown,
  ) {
    super(message, status);
  }
}

export const Errors = {
  badRequest: (message = 'The request is invalid.') =>
    new AppError('BAD_REQUEST', message, HttpStatus.BAD_REQUEST),
  validation: (details: { path: string; message: string }[]) =>
    new AppError('VALIDATION_FAILED', 'Some fields are invalid.', HttpStatus.UNPROCESSABLE_ENTITY, details),
  unauthenticated: (message = 'Sign in to continue.') =>
    new AppError('UNAUTHENTICATED', message, HttpStatus.UNAUTHORIZED),
  invalidCredentials: () =>
    new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', HttpStatus.UNAUTHORIZED),
  accountLocked: () =>
    new AppError(
      'ACCOUNT_LOCKED',
      'Too many failed attempts. Try again later or reset your password.',
      HttpStatus.TOO_MANY_REQUESTS,
    ),
  mfaRequired: () =>
    new AppError('MFA_REQUIRED', 'Enter your authentication code to continue.', HttpStatus.UNAUTHORIZED),
  mfaEnrollmentRequired: () =>
    new AppError(
      'MFA_ENROLLMENT_REQUIRED',
      'This workspace requires two-factor authentication. Set it up to continue.',
      HttpStatus.FORBIDDEN,
    ),
  stepUpRequired: () =>
    new AppError('STEP_UP_REQUIRED', 'Confirm your identity to continue.', HttpStatus.FORBIDDEN),
  forbidden: (message = 'You do not have permission to do that.') =>
    new AppError('FORBIDDEN', message, HttpStatus.FORBIDDEN),
  tenantRequired: () =>
    new AppError('TENANT_REQUIRED', 'Choose a workspace to continue.', HttpStatus.FORBIDDEN),
  tenantUnavailable: () =>
    new AppError('TENANT_UNAVAILABLE', 'This workspace is not available.', HttpStatus.FORBIDDEN),
  tenantDomainMismatch: () =>
    new AppError(
      'TENANT_DOMAIN_MISMATCH',
      'Your session belongs to a different workspace. Sign in on this workspace’s address.',
      HttpStatus.FORBIDDEN,
    ),
  supportReadOnly: () =>
    new AppError(
      'SUPPORT_SESSION_READ_ONLY',
      'This support session is read-only.',
      HttpStatus.FORBIDDEN,
    ),
  notFound: (message = 'The requested resource could not be found.') =>
    new AppError('RESOURCE_NOT_FOUND', message, HttpStatus.NOT_FOUND),
  conflict: (message: string) => new AppError('CONFLICT', message, HttpStatus.CONFLICT),
  versionConflict: () =>
    new AppError(
      'VERSION_CONFLICT',
      'Someone else changed this since you opened it. Reload and try again.',
      HttpStatus.CONFLICT,
    ),
  idempotencyConflict: () =>
    new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used with a different request.',
      HttpStatus.CONFLICT,
    ),
  csrf: () => new AppError('CSRF_FAILED', 'Your session could not be verified. Reload the page.', HttpStatus.FORBIDDEN),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      'RATE_LIMITED',
      `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      HttpStatus.TOO_MANY_REQUESTS,
    ),
  invalidToken: (message = 'This link is invalid or has expired.') =>
    new AppError('INVALID_TOKEN', message, HttpStatus.BAD_REQUEST),
  payloadTooLarge: (message = 'The upload is too large.') =>
    new AppError('PAYLOAD_TOO_LARGE', message, HttpStatus.PAYLOAD_TOO_LARGE),
  unsupportedMedia: (message: string) =>
    new AppError('UNSUPPORTED_MEDIA_TYPE', message, HttpStatus.UNSUPPORTED_MEDIA_TYPE),
  quotaExceeded: (message: string) => new AppError('QUOTA_EXCEEDED', message, HttpStatus.FORBIDDEN),
  maintenance: (message: string) => new AppError('MAINTENANCE_MODE', message, HttpStatus.SERVICE_UNAVAILABLE),
  unavailable: (message = 'The service is temporarily unavailable.', internal?: unknown) =>
    new AppError('SERVICE_UNAVAILABLE', message, HttpStatus.SERVICE_UNAVAILABLE, undefined, internal),
};
