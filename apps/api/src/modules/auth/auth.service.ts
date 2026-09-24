import { Inject, Injectable } from '@nestjs/common';
import {
  tenantSettingsSchema,
  type AcceptInvitationInput,
  type LoginInput,
  type MeResponse,
  type MfaChallengeInput,
  type StepUpInput,
  type TenantMembershipSummary,
  type TenantPermission,
} from '@daliz/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ENV, type Env } from '../../config/env.js';
import { PasswordService } from '../../common/crypto.js';
import { Errors } from '../../common/errors.js';
import { RequestContext, type SessionPrincipal } from '../../common/request-context.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import {
  accounts,
  invitations,
  organizations,
  platformAdmins,
  supportSessions,
  tenantMemberships,
  tenants,
} from '../../database/platform/schema.js';
import { roles, settings, userRoles, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import { QueueService } from '../../infra/queue.js';
import { RATE_LIMITS, RateLimiter } from '../../infra/redis.js';
import { AuditService } from '../audit/audit.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';
import { AccountsService } from './accounts.service.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  sessionId: string;
  stage: 'mfa_pending' | 'active';
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly accountsService: AccountsService,
    private readonly mfa: MfaService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly platformAccess: PlatformAccessService,
    private readonly tenantContext: TenantContextService,
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnectionManager,
  ) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(input: LoginInput, clientPlatform: string | null): Promise<IssuedSession> {
    const ctx = RequestContext.require();
    await this.limiter.enforce(RATE_LIMITS.loginIp, ctx.ip ?? 'unknown');
    // Keyed by email whether or not the account exists, so lockout can't reveal existence.
    const perAccount = await this.limiter.hit(RATE_LIMITS.loginAccount, input.email);
    if (!perAccount.allowed) {
      await this.audit.securityEvent({ type: 'login.throttled', severity: 'warning', email: input.email });
      throw Errors.accountLocked();
    }

    const account = await this.accountsService.findByEmail(input.email);
    const passwordOk = await this.passwords.verify(account?.passwordHash, input.password);
    if (!account || !passwordOk || account.status !== 'active') {
      if (account) {
        await this.platform.db
          .update(accounts)
          .set({ failedLoginCount: account.failedLoginCount + 1 })
          .where(eq(accounts.id, account.id));
      }
      await this.audit.securityEvent({
        type: 'login.failed',
        severity: (account?.failedLoginCount ?? 0) >= 4 ? 'warning' : 'info',
        accountId: account?.id ?? null,
        email: input.email,
        metadata: { reason: !account ? 'unknown_account' : account.status !== 'active' ? `account_${account.status}` : 'bad_password' },
      });
      throw Errors.invalidCredentials();
    }

    const activeTenantId = await this.initialTenant(account.id, ctx.domainTenantId ?? null);
    const stage = account.mfaEnabled ? 'mfa_pending' : 'active';
    const issued = await this.sessions.create({
      accountId: account.id,
      stage,
      activeTenantId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      clientPlatform,
    });
    await this.limiter.reset(RATE_LIMITS.loginAccount, input.email);

    if (stage === 'active') await this.onFullyAuthenticated(account.id, account.email, issued.sessionId);
    else await this.audit.securityEvent({ type: 'login.password_ok_mfa_pending', severity: 'info', accountId: account.id, email: account.email });

    return { token: issued.token, expiresAt: issued.absoluteExpiresAt, sessionId: issued.sessionId, stage };
  }

  /**
   * Picks the tenant a new session starts in. On a tenant host the host decides (and the
   * account must belong to it); elsewhere, an account with exactly one workspace lands in it.
   */
  private async initialTenant(accountId: string, domainTenantId: string | null): Promise<string | null> {
    const memberships = await this.platform.db
      .select({ tenantId: tenantMemberships.tenantId, status: tenants.status })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.accountId, accountId), eq(tenantMemberships.status, 'active')));
    if (domainTenantId) {
      if (!memberships.some((m) => m.tenantId === domainTenantId)) {
        throw Errors.forbidden('Your account doesn’t have access to this workspace.');
      }
      return domainTenantId;
    }
    const active = memberships.filter((m) => m.status === 'active');
    return active.length === 1 ? active[0]!.tenantId : null;
  }

  private async onFullyAuthenticated(accountId: string, email: string, sessionId: string): Promise<void> {
    const ctx = RequestContext.get();
    const [prior] = await this.platform.db.select({ lastLoginAt: accounts.lastLoginAt }).from(accounts).where(eq(accounts.id, accountId));
    await this.platform.db
      .update(accounts)
      .set({ lastLoginAt: new Date(), failedLoginCount: 0 })
      .where(eq(accounts.id, accountId));
    await this.audit.securityEvent({ type: 'login.success', severity: 'info', accountId, email, metadata: { sessionId } });
    await this.audit.platformEvent({
      action: 'auth.login',
      resourceType: 'session',
      resourceId: sessionId,
      actor: { type: 'user', id: accountId, email },
    });
    // New-device detection: an established account signing in from an IP it hasn't used in 90 days.
    if (!prior?.lastLoginAt || !ctx?.ip) return;
    const knownIps = await this.sessions.recentIps(accountId, sessionId);
    if (knownIps.size > 0 && !knownIps.has(ctx.ip)) {
      await this.audit.securityEvent({ type: 'login.new_ip', severity: 'warning', accountId, email, metadata: { ip: ctx.ip } });
      await this.queue.enqueueEmail({
        tenantId: null,
        to: email,
        template: 'new_login',
        data: { email, when: new Date().toUTCString(), ip: ctx.ip, userAgent: ctx.userAgent ?? '' },
      });
    }
  }

  async verifyMfa(session: SessionPrincipal, input: MfaChallengeInput): Promise<{ token: string; absoluteExpiresAt: Date }> {
    await this.limiter.enforce(RATE_LIMITS.mfaSession, session.sessionId);
    const ok =
      'code' in input
        ? await this.mfa.verifyCode(session.accountId, input.code)
        : await this.mfa.useRecoveryCode(session.accountId, input.recoveryCode);
    if (!ok) {
      await this.audit.securityEvent({
        type: 'mfa.failed',
        severity: 'warning',
        accountId: session.accountId,
        email: session.email,
        metadata: { method: 'code' in input ? 'totp' : 'recovery_code' },
      });
      throw Errors.badRequest('That code is not valid.');
    }
    await this.sessions.update(session.sessionId, { stage: 'active', mfaVerifiedAt: new Date() });
    const rotated = await this.sessions.rotate(session.sessionId);
    if ('recoveryCode' in input) {
      const remaining = await this.mfa.remainingRecoveryCodes(session.accountId);
      await this.audit.securityEvent({
        type: 'mfa.recovery_code_used',
        severity: 'warning',
        accountId: session.accountId,
        email: session.email,
        metadata: { remaining },
      });
    }
    await this.onFullyAuthenticated(session.accountId, session.email, session.sessionId);
    return rotated;
  }

  async logout(session: SessionPrincipal): Promise<void> {
    await this.endSupportIfAny(session, 'logout');
    await this.sessions.revoke(session.sessionId, 'logout');
    await this.audit.platformEvent({ action: 'auth.logout', resourceType: 'session', resourceId: session.sessionId });
  }

  async logoutEverywhere(session: SessionPrincipal): Promise<number> {
    await this.endSupportIfAny(session, 'logout_all');
    const count = await this.sessions.revokeAllForAccount(session.accountId, 'logout_all');
    await this.audit.platformEvent({ action: 'auth.logout_all', metadata: { revoked: count } });
    return count;
  }

  private async endSupportIfAny(session: SessionPrincipal, reason: string): Promise<void> {
    if (!session.supportSessionId) return;
    await this.platform.db
      .update(supportSessions)
      .set({ endedAt: new Date(), endedReason: reason })
      .where(eq(supportSessions.id, session.supportSessionId));
  }

  async selectTenant(session: SessionPrincipal, tenantId: string): Promise<void> {
    const ctx = RequestContext.require();
    if (ctx.domainTenantId && ctx.domainTenantId !== tenantId) throw Errors.tenantDomainMismatch();
    const [membership] = await this.platform.db
      .select({ status: tenantMemberships.status })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.accountId, session.accountId), eq(tenantMemberships.tenantId, tenantId)));
    const tenant = await this.directory.get(tenantId);
    // Same error whether the tenant doesn't exist or the caller isn't a member (no IDOR oracle).
    if (membership?.status !== 'active' || !tenant || tenant.status !== 'active') throw Errors.notFound();
    await this.endSupportIfAny(session, 'tenant_switch');
    await this.sessions.update(session.sessionId, { activeTenantId: tenantId, supportSessionId: null });
    await this.audit.platformEvent({ action: 'auth.tenant_selected', tenantId, resourceType: 'tenant', resourceId: tenantId });
  }

  // -------------------------------------------------------------------------
  // Password reset & email verification
  // -------------------------------------------------------------------------

  async requestPasswordReset(email: string): Promise<void> {
    const ctx = RequestContext.require();
    await this.limiter.enforce(RATE_LIMITS.passwordReset, `ip:${ctx.ip}`);
    const perEmail = await this.limiter.hit(RATE_LIMITS.passwordReset, `email:${email}`);
    const account = await this.accountsService.findByEmail(email);
    // Always respond the same way; only send if the account exists and is active.
    if (!perEmail.allowed || !account || account.status !== 'active') {
      await this.audit.securityEvent({ type: 'password_reset.requested_ignored', severity: 'info', email });
      return;
    }
    const token = await this.accountsService.issueEmailToken(account.id, 'reset_password');
    await this.queue.enqueueEmail({
      tenantId: null,
      to: account.email,
      template: 'password_reset',
      data: { url: `${this.env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}` },
    });
    await this.audit.securityEvent({ type: 'password_reset.requested', severity: 'info', accountId: account.id, email });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const hash = await this.passwords.hash(password);
    const accountId = await this.platform.db.transaction(async (tx) => {
      const id = await this.accountsService.consumeEmailToken(token, 'reset_password', tx);
      if (!id) throw Errors.invalidToken();
      await tx
        .update(accounts)
        .set({ passwordHash: hash, passwordChangedAt: new Date(), failedLoginCount: 0, updatedAt: new Date() })
        .where(eq(accounts.id, id));
      return id;
    });
    const account = (await this.accountsService.findById(accountId))!;
    await this.sessions.revokeAllForAccount(accountId, 'password_reset');
    await this.audit.securityEvent({ type: 'password.reset', severity: 'warning', accountId, email: account.email });
    await this.audit.platformEvent({ action: 'auth.password_reset', actor: { type: 'user', id: accountId, email: account.email } });
    await this.queue.enqueueEmail({
      tenantId: null,
      to: account.email,
      template: 'password_changed',
      data: { email: account.email, when: new Date().toUTCString() },
    });
  }

  async sendVerificationEmail(session: SessionPrincipal): Promise<void> {
    await this.limiter.enforce(RATE_LIMITS.passwordReset, `verify:${session.accountId}`);
    const token = await this.accountsService.issueEmailToken(session.accountId, 'verify_email');
    await this.queue.enqueueEmail({
      tenantId: null,
      to: session.email,
      template: 'email_verification',
      data: { url: `${this.env.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}` },
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const accountId = await this.accountsService.consumeEmailToken(token, 'verify_email');
    if (!accountId) throw Errors.invalidToken();
    await this.platform.db.update(accounts).set({ emailVerifiedAt: new Date() }).where(eq(accounts.id, accountId));
    await this.audit.platformEvent({ action: 'auth.email_verified', actor: { type: 'user', id: accountId, email: null } });
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  async describeInvitation(token: string) {
    await this.limiter.enforce(RATE_LIMITS.invitationAccept, RequestContext.require().ip ?? 'unknown');
    const invitation = await this.accountsService.findValidInvitation(token);
    if (!invitation) throw Errors.invalidToken();
    const account = (await this.accountsService.findById(invitation.accountId))!;
    const tenant = invitation.tenantId ? await this.directory.get(invitation.tenantId) : null;
    return {
      email: account.email,
      name: account.name,
      workspaceName: tenant?.name ?? 'Daliz Platform',
      kind: invitation.kind,
      accountExists: account.status === 'active',
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * New accounts set their name and password here. An account that already has a password
   * (invited to an additional workspace) must be signed in as that account to accept.
   */
  async acceptInvitation(
    input: AcceptInvitationInput | { token: string },
    session: SessionPrincipal | undefined,
  ): Promise<{ accountId: string; tenantId: string | null; kind: string }> {
    await this.limiter.enforce(RATE_LIMITS.invitationAccept, RequestContext.require().ip ?? 'unknown');
    const invitation = await this.accountsService.findValidInvitation(input.token);
    if (!invitation) throw Errors.invalidToken();
    const account = (await this.accountsService.findById(invitation.accountId))!;

    if (account.status === 'active') {
      if (!session || session.accountId !== account.id) {
        throw Errors.forbidden('Sign in as the invited account to accept this invitation.');
      }
    } else if (!('password' in input)) {
      throw Errors.badRequest('Choose a password to finish setting up your account.');
    }
    const passwordHash = 'password' in input && account.status !== 'active' ? await this.passwords.hash(input.password) : null;

    await this.platform.db.transaction(async (tx) => {
      // Conditional update makes acceptance single-use under concurrency.
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invitations.id, invitation.id), eq(invitations.tokenHash, invitation.tokenHash)))
        .returning({ id: invitations.id });
      if (!claimed.length) throw Errors.invalidToken();
      if (passwordHash && 'name' in input) {
        await tx
          .update(accounts)
          .set({
            name: input.name,
            passwordHash,
            status: 'active',
            // Receiving the invitation email proves control of the address.
            emailVerifiedAt: account.emailVerifiedAt ?? new Date(),
            passwordChangedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, account.id));
      }
      if (invitation.tenantId) {
        await tx
          .update(tenantMemberships)
          .set({ status: 'active', updatedAt: new Date() })
          .where(and(eq(tenantMemberships.accountId, account.id), eq(tenantMemberships.tenantId, invitation.tenantId)));
      }
      if (invitation.kind === 'platform_admin') {
        await tx.update(platformAdmins).set({ status: 'active' }).where(eq(platformAdmins.accountId, account.id));
      }
    });

    if (invitation.tenantId) {
      const db = await this.connections.get(invitation.tenantId);
      await db
        .update(users)
        .set({
          status: 'active',
          name: 'name' in input ? input.name : account.name,
          updatedAt: new Date(),
        })
        .where(and(eq(users.accountId, account.id), eq(users.status, 'invited')));
    }
    if (invitation.kind === 'platform_admin') await this.platformAccess.invalidate(account.id);
    await this.audit.platformEvent({
      action: 'auth.invitation_accepted',
      tenantId: invitation.tenantId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      actor: { type: 'user', id: account.id, email: account.email },
    });
    return { accountId: account.id, tenantId: invitation.tenantId, kind: invitation.kind };
  }

  async createSessionAfterInvitation(accountId: string, tenantId: string | null): Promise<IssuedSession> {
    const ctx = RequestContext.require();
    const account = (await this.accountsService.findById(accountId))!;
    const stage = account.mfaEnabled ? 'mfa_pending' : 'active';
    const issued = await this.sessions.create({ accountId, stage, activeTenantId: tenantId, ip: ctx.ip, userAgent: ctx.userAgent });
    if (stage === 'active') await this.onFullyAuthenticated(accountId, account.email, issued.sessionId);
    return { token: issued.token, expiresAt: issued.absoluteExpiresAt, sessionId: issued.sessionId, stage };
  }

  // -------------------------------------------------------------------------
  // Account security
  // -------------------------------------------------------------------------

  async changePassword(session: SessionPrincipal, currentPassword: string, newPassword: string): Promise<void> {
    const account = (await this.accountsService.findById(session.accountId))!;
    if (!(await this.passwords.verify(account.passwordHash, currentPassword))) {
      await this.audit.securityEvent({ type: 'password.change_failed', severity: 'warning', accountId: account.id, email: account.email });
      throw Errors.badRequest('Your current password is incorrect.');
    }
    if (await this.passwords.verify(account.passwordHash, newPassword)) {
      throw Errors.badRequest('Choose a password you haven’t used for this account.');
    }
    await this.platform.db
      .update(accounts)
      .set({ passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: new Date(), updatedAt: new Date() })
      .where(eq(accounts.id, account.id));
    const revoked = await this.sessions.revokeAllForAccount(account.id, 'password_changed', session.sessionId);
    await this.audit.securityEvent({ type: 'password.changed', severity: 'info', accountId: account.id, email: account.email, metadata: { revokedSessions: revoked } });
    await this.audit.platformEvent({ action: 'auth.password_changed' });
    await this.queue.enqueueEmail({
      tenantId: null,
      to: account.email,
      template: 'password_changed',
      data: { email: account.email, when: new Date().toUTCString() },
    });
  }

  async updateProfile(session: SessionPrincipal, name: string): Promise<void> {
    await this.platform.db.update(accounts).set({ name, updatedAt: new Date() }).where(eq(accounts.id, session.accountId));
    await this.sessions.update(session.sessionId, {});
    await this.audit.platformEvent({ action: 'account.profile_updated' });
  }

  async stepUp(session: SessionPrincipal, input: StepUpInput): Promise<Date> {
    await this.limiter.enforce(RATE_LIMITS.stepUp, session.accountId);
    const account = (await this.accountsService.findById(session.accountId))!;
    const passwordOk = await this.passwords.verify(account.passwordHash, input.password);
    const codeOk = !account.mfaEnabled || (!!input.code && (await this.mfa.verifyCode(account.id, input.code)));
    if (!passwordOk || !codeOk) {
      await this.audit.securityEvent({ type: 'step_up.failed', severity: 'warning', accountId: account.id, email: account.email });
      throw Errors.badRequest(account.mfaEnabled ? 'Password or code is incorrect.' : 'Password is incorrect.');
    }
    const until = new Date(Date.now() + this.env.STEP_UP_MINUTES * 60_000);
    await this.sessions.update(session.sessionId, { stepUpUntil: until });
    await this.audit.securityEvent({ type: 'step_up.success', severity: 'info', accountId: account.id, email: account.email });
    return until;
  }

  async notifyMfaChange(session: SessionPrincipal, change: 'enabled' | 'disabled'): Promise<void> {
    await this.audit.securityEvent({
      type: `mfa.${change}`,
      severity: change === 'disabled' ? 'warning' : 'info',
      accountId: session.accountId,
      email: session.email,
    });
    await this.audit.platformEvent({ action: `auth.mfa_${change}` });
    await this.queue.enqueueEmail({
      tenantId: null,
      to: session.email,
      template: 'mfa_changed',
      data: { email: session.email, change, when: new Date().toUTCString() },
    });
  }

  // -------------------------------------------------------------------------
  // Session description
  // -------------------------------------------------------------------------

  async memberships(accountId: string): Promise<TenantMembershipSummary[]> {
    const rows = await this.platform.db
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        organizationName: organizations.name,
        status: tenants.status,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .innerJoin(organizations, eq(organizations.id, tenants.organizationId))
      .where(
        and(
          eq(tenantMemberships.accountId, accountId),
          eq(tenantMemberships.status, 'active'),
          inArray(tenants.status, ['active', 'suspended']),
        ),
      )
      .orderBy(asc(tenants.name));
    return rows.map((r) => ({ ...r, status: r.status as TenantMembershipSummary['status'] }));
  }

  async me(session: SessionPrincipal): Promise<MeResponse> {
    const store = RequestContext.require();
    const account = (await this.accountsService.findById(session.accountId))!;
    const base: MeResponse = {
      stage: session.stage,
      csrfToken: this.sessions.csrfToken(session.sessionId),
      account: {
        id: account.id,
        email: account.email,
        name: account.name,
        emailVerified: !!account.emailVerifiedAt,
        mfaEnabled: account.mfaEnabled,
      },
      platform: null,
      memberships: [],
      tenant: null,
      support: null,
      mustEnrollMfa: false,
      stepUpUntil: session.stepUpUntil && session.stepUpUntil > new Date() ? session.stepUpUntil.toISOString() : null,
    };
    if (session.stage !== 'active') return base;

    const platformPrincipal = store.platform ?? (await this.platformAccess.principal(session.accountId));
    if (platformPrincipal) {
      base.platform = { role: platformPrincipal.role, permissions: [...platformPrincipal.permissions] };
      const settings = await this.platformAccess.settings();
      if (settings.requireMfaForPlatformAdmins && !account.mfaEnabled) base.mustEnrollMfa = true;
    }
    base.memberships = await this.memberships(session.accountId);

    if (session.activeTenantId || session.supportSessionId) {
      try {
        const resolved = await this.tenantContext.resolve(session, platformPrincipal, store.domainTenantId);
        const t = resolved.context;
        const [generalRow] = await t.db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'general'));
        const summary = (await this.directory.get(t.tenantId))!;
        const general = tenantSettingsSchema.safeParse(generalRow?.value);
        let roleList: { id: string; name: string }[] = [];
        if (t.actor.type === 'user') {
          roleList = await t.db
            .select({ id: roles.id, name: roles.name })
            .from(userRoles)
            .innerJoin(roles, eq(roles.id, userRoles.roleId))
            .where(eq(userRoles.userId, t.actor.userId));
        }
        base.tenant = {
          id: t.tenantId,
          name: t.name,
          slug: t.slug,
          userId: t.actor.type === 'user' ? t.actor.userId : null,
          roles: roleList,
          permissions: [...t.permissions] as TenantPermission[],
          settings: general.success
            ? general.data
            : { displayName: t.name, locale: summary.locale, timezone: summary.timezone, currency: summary.currency, dateFormat: 'yyyy-MM-dd', weekStartsOn: 1 },
          security: resolved.security,
        };
        if (resolved.security.requireMfa && !account.mfaEnabled && t.actor.type === 'user') base.mustEnrollMfa = true;
        if (t.actor.type === 'support') {
          const [s] = await this.platform.db.select().from(supportSessions).where(eq(supportSessions.id, t.actor.supportSessionId));
          base.support = {
            tenantId: t.tenantId,
            tenantName: t.name,
            reason: s!.reason,
            allowWrite: s!.allowWrite,
            expiresAt: s!.expiresAt.toISOString(),
          };
        }
      } catch {
        // The selected tenant became unavailable (suspended, access removed, support expired).
        // Drop it from the session so the client can pick again.
        await this.sessions.update(session.sessionId, { activeTenantId: null, supportSessionId: null });
      }
    }
    return base;
  }
}
