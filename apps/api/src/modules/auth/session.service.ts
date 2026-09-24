import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { CookieOptions, Response } from 'express';
import { ENV, type Env } from '../../config/env.js';
import { TokenService } from '../../common/crypto.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import { accounts, sessions } from '../../database/platform/schema.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';

export interface LoadedSession {
  id: string;
  accountId: string;
  stage: 'mfa_pending' | 'active';
  activeTenantId: string | null;
  supportSessionId: string | null;
  mfaVerifiedAt: string | null;
  stepUpUntil: string | null;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  account: {
    email: string;
    name: string;
    status: 'pending' | 'active' | 'disabled';
    mfaEnabled: boolean;
    emailVerified: boolean;
  };
}

const CACHE_TTL_SECONDS = 30;
const TOUCH_INTERVAL_MS = 60_000;
const TOKEN_PURPOSE = 'session';

@Injectable()
export class SessionService {
  readonly cookieName: string;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
  ) {
    // __Host- cookies must be Secure, host-only and Path=/, which pins them to one origin.
    this.cookieName = env.NODE_ENV === 'production' ? `__Host-${env.SESSION_COOKIE_NAME}` : env.SESSION_COOKIE_NAME;
  }

  async create(input: {
    accountId: string;
    stage: 'mfa_pending' | 'active';
    activeTenantId: string | null;
    ip: string | null;
    userAgent: string | null;
    clientPlatform?: string | null;
  }): Promise<{ token: string; sessionId: string; absoluteExpiresAt: Date }> {
    const token = this.tokens.generate(32);
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + this.env.SESSION_MAX_HOURS * 3600_000);
    const [row] = await this.platform.db
      .insert(sessions)
      .values({
        tokenHash: this.tokens.hash(token, TOKEN_PURPOSE),
        accountId: input.accountId,
        stage: input.stage,
        activeTenantId: input.activeTenantId,
        ipAddress: input.ip,
        userAgent: input.userAgent?.slice(0, 400) ?? null,
        clientPlatform: input.clientPlatform ?? null,
        idleExpiresAt: new Date(now + this.env.SESSION_IDLE_MINUTES * 60_000),
        absoluteExpiresAt,
      })
      .returning({ id: sessions.id });
    return { token, sessionId: row!.id, absoluteExpiresAt };
  }

  /** Resolves a cookie token to a live session, or null if unknown/expired/revoked. */
  async load(token: string): Promise<LoadedSession | null> {
    if (!token || token.length > 100) return null;
    const tokenHash = this.tokens.hash(token, TOKEN_PURPOSE);
    const cacheKey = RedisKeys.session(tokenHash);
    let session = await this.redis.getJson<LoadedSession>(cacheKey);
    if (!session) {
      const [row] = await this.platform.db
        .select({ s: sessions, a: accounts })
        .from(sessions)
        .innerJoin(accounts, eq(accounts.id, sessions.accountId))
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
        .limit(1);
      if (!row) return null;
      session = {
        id: row.s.id,
        accountId: row.s.accountId,
        stage: row.s.stage,
        activeTenantId: row.s.activeTenantId,
        supportSessionId: row.s.supportSessionId,
        mfaVerifiedAt: row.s.mfaVerifiedAt?.toISOString() ?? null,
        stepUpUntil: row.s.stepUpUntil?.toISOString() ?? null,
        createdAt: row.s.createdAt.toISOString(),
        lastSeenAt: row.s.lastSeenAt.toISOString(),
        idleExpiresAt: row.s.idleExpiresAt.toISOString(),
        absoluteExpiresAt: row.s.absoluteExpiresAt.toISOString(),
        account: {
          email: row.a.email,
          name: row.a.name,
          status: row.a.status,
          mfaEnabled: row.a.mfaEnabled,
          emailVerified: !!row.a.emailVerifiedAt,
        },
      };
      await this.redis.setJson(cacheKey, session, CACHE_TTL_SECONDS);
    }
    const now = Date.now();
    if (new Date(session.idleExpiresAt).getTime() < now || new Date(session.absoluteExpiresAt).getTime() < now) {
      await this.revoke(session.id, 'expired');
      return null;
    }
    if (session.account.status !== 'active') {
      await this.revoke(session.id, 'account_inactive');
      return null;
    }
    return session;
  }

  /** Extends the idle timeout, at most once a minute per session. */
  async touch(session: LoadedSession, token: string): Promise<void> {
    if (Date.now() - new Date(session.lastSeenAt).getTime() < TOUCH_INTERVAL_MS) return;
    const now = new Date();
    await this.platform.db
      .update(sessions)
      .set({ lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + this.env.SESSION_IDLE_MINUTES * 60_000) })
      .where(eq(sessions.id, session.id));
    await this.redis.del(RedisKeys.session(this.tokens.hash(token, TOKEN_PURPOSE)));
  }

  async update(
    sessionId: string,
    patch: Partial<Pick<typeof sessions.$inferInsert, 'stage' | 'activeTenantId' | 'supportSessionId' | 'mfaVerifiedAt' | 'stepUpUntil'>>,
  ): Promise<void> {
    await this.platform.db.update(sessions).set(patch).where(eq(sessions.id, sessionId));
    await this.invalidate(sessionId);
  }

  /**
   * Issues a new token for an existing session (after MFA, tenant switch into support
   * mode, etc.) so a token captured before the privilege change stops working.
   */
  async rotate(sessionId: string): Promise<{ token: string; absoluteExpiresAt: Date }> {
    await this.invalidate(sessionId);
    const token = this.tokens.generate(32);
    const [row] = await this.platform.db
      .update(sessions)
      .set({ tokenHash: this.tokens.hash(token, TOKEN_PURPOSE) })
      .where(eq(sessions.id, sessionId))
      .returning({ absoluteExpiresAt: sessions.absoluteExpiresAt });
    return { token, absoluteExpiresAt: row!.absoluteExpiresAt };
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.invalidate(sessionId);
    await this.platform.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async revokeAllForAccount(accountId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const rows = await this.platform.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(sessions.accountId, accountId),
          isNull(sessions.revokedAt),
          exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
        ),
      )
      .returning({ tokenHash: sessions.tokenHash });
    await this.redis.del(...rows.map((r) => RedisKeys.session(r.tokenHash)));
    return rows.length;
  }

  /** Revokes every session currently inside a tenant (used when a tenant is suspended). */
  async revokeAllForTenant(tenantId: string, reason: string): Promise<number> {
    const rows = await this.platform.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.activeTenantId, tenantId), isNull(sessions.revokedAt)))
      .returning({ tokenHash: sessions.tokenHash });
    await this.redis.del(...rows.map((r) => RedisKeys.session(r.tokenHash)));
    return rows.length;
  }

  async listForAccount(accountId: string) {
    return this.platform.db
      .select({
        id: sessions.id,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(50);
  }

  /** IPs used by the account's other sessions in the last 90 days. */
  async recentIps(accountId: string, excludeSessionId: string): Promise<Set<string>> {
    const rows = await this.platform.db
      .select({ ip: sessions.ipAddress })
      .from(sessions)
      .where(
        and(
          eq(sessions.accountId, accountId),
          ne(sessions.id, excludeSessionId),
          gt(sessions.createdAt, new Date(Date.now() - 90 * 86400_000)),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(200);
    return new Set(rows.map((r) => r.ip).filter((ip): ip is string => !!ip));
  }

  private async invalidate(sessionId: string): Promise<void> {
    const [row] = await this.platform.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (row) await this.redis.del(RedisKeys.session(row.tokenHash));
  }

  /** CSRF token bound to the session; derived, so nothing extra is stored. */
  csrfToken(sessionId: string): string {
    return this.tokens.sign(`csrf:${sessionId}`);
  }

  verifyCsrf(sessionId: string, presented: string | undefined): boolean {
    return !!presented && this.tokens.verifySignature(`csrf:${sessionId}`, presented);
  }

  cookieOptions(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires,
    };
  }

  setCookie(res: Response, token: string, expires: Date): void {
    res.cookie(this.cookieName, token, this.cookieOptions(expires));
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cookieName, this.cookieOptions());
  }
}
