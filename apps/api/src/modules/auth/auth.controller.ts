import { Controller, Delete, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  acceptInvitationSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaChallengeSchema,
  mfaEnableSchema,
  resetPasswordSchema,
  selectTenantSchema,
  stepUpSchema,
  updateProfileSchema,
  type LoginResponse,
  type MfaSetupResponse,
  type RecoveryCodesResponse,
  type SessionInfo,
} from '@daliz/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Errors } from '../../common/errors.js';
import {
  AllowMfaPending,
  AllowWithoutMfaEnrollment,
  Public,
  RateLimit,
  RequireStepUp,
} from '../../common/http/decorators.js';
import { IdParam, ZBody } from '../../common/http/zod.js';
import { RequestContext } from '../../common/request-context.js';
import { RATE_LIMITS } from '../../infra/redis.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';

const tokenSchema = z.object({ token: z.string().min(20).max(200) });
const CLIENTS = new Set(['web', 'pwa', 'desktop']);

function clientPlatform(req: Request): string | null {
  const v = req.headers['x-daliz-client'];
  return typeof v === 'string' && CLIENTS.has(v) ? v : null;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.authEndpoints)
  async login(@ZBody(loginSchema) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    const current = RequestContext.get()?.session;
    if (current) await this.sessions.revoke(current.sessionId, 'replaced_by_login');
    const issued = await this.auth.login(body, clientPlatform(req));
    this.sessions.setCookie(res, issued.token, issued.expiresAt);
    return { stage: issued.stage, csrfToken: this.sessions.csrfToken(issued.sessionId) };
  }

  @AllowMfaPending()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@ZBody(mfaChallengeSchema) body: z.infer<typeof mfaChallengeSchema>, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    const session = RequestContext.session();
    if (session.stage !== 'mfa_pending') throw Errors.badRequest('Two-factor verification is not pending.');
    const rotated = await this.auth.verifyMfa(session, body);
    this.sessions.setCookie(res, rotated.token, rotated.absoluteExpiresAt);
    return { stage: 'active', csrfToken: this.sessions.csrfToken(session.sessionId) };
  }

  @AllowMfaPending()
  @AllowWithoutMfaEnrollment()
  @Post('logout')
  @HttpCode(200)
  async logout(@Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    await this.auth.logout(RequestContext.session());
    this.sessions.clearCookie(res);
    return { ok: true };
  }

  @AllowWithoutMfaEnrollment()
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@Res({ passthrough: true }) res: Response): Promise<{ revoked: number }> {
    const revoked = await this.auth.logoutEverywhere(RequestContext.session());
    this.sessions.clearCookie(res);
    return { revoked };
  }

  @AllowMfaPending()
  @AllowWithoutMfaEnrollment()
  @Get('me')
  me() {
    return this.auth.me(RequestContext.session());
  }

  @AllowWithoutMfaEnrollment()
  @Post('tenant')
  @HttpCode(200)
  async selectTenant(@ZBody(selectTenantSchema) body: z.infer<typeof selectTenantSchema>) {
    await this.auth.selectTenant(RequestContext.session(), body.tenantId);
    return { ok: true };
  }

  // --- Password & email ------------------------------------------------------

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @RateLimit(RATE_LIMITS.authEndpoints)
  async forgot(@ZBody(forgotPasswordSchema) body: z.infer<typeof forgotPasswordSchema>) {
    await this.auth.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.authEndpoints)
  async reset(@ZBody(resetPasswordSchema) body: z.infer<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  @AllowWithoutMfaEnrollment()
  @Post('password/change')
  @HttpCode(200)
  async changePassword(@ZBody(changePasswordSchema) body: z.infer<typeof changePasswordSchema>) {
    await this.auth.changePassword(RequestContext.session(), body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @AllowWithoutMfaEnrollment()
  @Patch('profile')
  async updateProfile(@ZBody(updateProfileSchema) body: z.infer<typeof updateProfileSchema>) {
    await this.auth.updateProfile(RequestContext.session(), body.name);
    return { ok: true };
  }

  @AllowWithoutMfaEnrollment()
  @Post('email/verification')
  @HttpCode(202)
  async sendVerification() {
    await this.auth.sendVerificationEmail(RequestContext.session());
    return { ok: true };
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(@ZBody(tokenSchema) body: z.infer<typeof tokenSchema>) {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  // --- Invitations -------------------------------------------------------------

  /** POST so the token never appears in URLs, logs or referrers. */
  @Public()
  @Post('invitations/describe')
  @HttpCode(200)
  describeInvitation(@ZBody(tokenSchema) body: z.infer<typeof tokenSchema>) {
    return this.auth.describeInvitation(body.token);
  }

  /**
   * Two shapes:
   *  - { token, name, password }: a new account finishes setup and is signed in.
   *  - { token }: an existing account, already signed in as the invitee, joins the workspace.
   */
  @Public()
  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse | { ok: true }> {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const toValidation = (issues: z.core.$ZodIssue[]) =>
      Errors.validation(issues.map((i) => ({ path: i.path.join('.'), message: i.message })));

    if (raw.password === undefined) {
      const session = RequestContext.get()?.session;
      if (!session) throw Errors.unauthenticated('Sign in as the invited account to accept this invitation.');
      if (session.stage !== 'active') throw Errors.mfaRequired();
      const csrf = req.headers['x-csrf-token'];
      if (!this.sessions.verifyCsrf(session.sessionId, typeof csrf === 'string' ? csrf : undefined)) throw Errors.csrf();
      const parsed = tokenSchema.safeParse(raw);
      if (!parsed.success) throw toValidation(parsed.error.issues);
      const result = await this.auth.acceptInvitation(parsed.data, session);
      if (result.tenantId) await this.auth.selectTenant(session, result.tenantId);
      return { ok: true };
    }

    const parsed = acceptInvitationSchema.safeParse(raw);
    if (!parsed.success) throw toValidation(parsed.error.issues);
    const result = await this.auth.acceptInvitation(parsed.data, undefined);
    const current = RequestContext.get()?.session;
    if (current) await this.sessions.revoke(current.sessionId, 'replaced_by_invitation');
    const issued = await this.auth.createSessionAfterInvitation(result.accountId, result.tenantId);
    this.sessions.setCookie(res, issued.token, issued.expiresAt);
    return { stage: issued.stage, csrfToken: this.sessions.csrfToken(issued.sessionId) };
  }

  // --- Step-up -------------------------------------------------------------------

  @AllowWithoutMfaEnrollment()
  @Post('step-up')
  @HttpCode(200)
  async stepUp(@ZBody(stepUpSchema) body: z.infer<typeof stepUpSchema>) {
    const until = await this.auth.stepUp(RequestContext.session(), body);
    return { stepUpUntil: until.toISOString() };
  }

  // --- Sessions --------------------------------------------------------------------

  @AllowWithoutMfaEnrollment()
  @Get('sessions')
  async listSessions(): Promise<SessionInfo[]> {
    const session = RequestContext.session();
    const rows = await this.sessions.listForAccount(session.accountId);
    return rows.map((r) => ({
      id: r.id,
      current: r.id === session.sessionId,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.absoluteExpiresAt.toISOString(),
    }));
  }

  @AllowWithoutMfaEnrollment()
  @Delete('sessions/:id')
  async revokeSession(@IdParam() id: string) {
    const session = RequestContext.session();
    const mine = await this.sessions.listForAccount(session.accountId);
    // Only sessions belonging to the caller; anything else looks like it doesn't exist.
    if (!mine.some((s) => s.id === id)) throw Errors.notFound();
    await this.sessions.revoke(id, 'revoked_by_user');
    return { ok: true };
  }

  // --- MFA ---------------------------------------------------------------------------

  @AllowWithoutMfaEnrollment()
  @Post('mfa/setup')
  @HttpCode(200)
  async setupMfa(): Promise<MfaSetupResponse> {
    const session = RequestContext.session();
    if (session.mfaEnabled) throw Errors.conflict('Two-factor authentication is already enabled.');
    return this.mfa.beginEnrollment(session.accountId, session.email);
  }

  @AllowWithoutMfaEnrollment()
  @Post('mfa/enable')
  @HttpCode(200)
  async enableMfa(@ZBody(mfaEnableSchema) body: z.infer<typeof mfaEnableSchema>): Promise<RecoveryCodesResponse> {
    const session = RequestContext.session();
    const codes = await this.mfa.completeEnrollment(session.accountId, session.email, body.code);
    if (!codes) throw Errors.badRequest('That code is not valid. Check your authenticator app’s clock and try again.');
    await this.sessions.update(session.sessionId, { mfaVerifiedAt: new Date() });
    await this.auth.notifyMfaChange(session, 'enabled');
    return { recoveryCodes: codes };
  }

  @RequireStepUp()
  @Post('mfa/disable')
  @HttpCode(200)
  async disableMfa() {
    const session = RequestContext.session();
    const principal = await this.platformAccess.principal(session.accountId);
    if (principal && (await this.platformAccess.settings()).requireMfaForPlatformAdmins) {
      throw Errors.forbidden('Platform administrators must keep two-factor authentication enabled.');
    }
    await this.mfa.disable(session.accountId);
    await this.sessions.revokeAllForAccount(session.accountId, 'mfa_disabled', session.sessionId);
    await this.auth.notifyMfaChange(session, 'disabled');
    return { ok: true };
  }

  @RequireStepUp()
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  async regenerateRecoveryCodes(): Promise<RecoveryCodesResponse> {
    const session = RequestContext.session();
    if (!session.mfaEnabled) throw Errors.badRequest('Enable two-factor authentication first.');
    const recoveryCodes = await this.mfa.replaceRecoveryCodes(session.accountId);
    await this.auth.notifyMfaChange(session, 'enabled');
    return { recoveryCodes };
  }
}
