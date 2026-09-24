import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ENV, type Env } from '../../config/env.js';
import { TokenService } from '../../common/crypto.js';
import { PlatformDb, type PlatformDatabase } from '../../database/platform/platform-db.js';
import { accounts, emailTokens, invitations } from '../../database/platform/schema.js';
import { QueueService } from '../../infra/queue.js';

export const INVITATION_TTL_DAYS = 7;
const RESET_TTL_MINUTES = 30;
const VERIFY_TTL_HOURS = 48;

export interface EmailBranding {
  brandName: string;
  primaryColor: string;
  logoUrl: string;
}

/** Account records, invitations and single-use email tokens in the platform database. */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly tokens: TokenService,
    private readonly queue: QueueService,
  ) {}

  async findByEmail(email: string) {
    const [row] = await this.platform.db.select().from(accounts).where(eq(accounts.email, email.toLowerCase())).limit(1);
    return row ?? null;
  }

  async findById(id: string, tx?: PlatformDatabase) {
    const [row] = await (tx ?? this.platform.db).select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return row ?? null;
  }

  /** Returns an existing account for the email or creates a pending one (no password yet). */
  async findOrCreatePending(email: string, name: string, tx?: PlatformDatabase): Promise<{ id: string; created: boolean; status: string }> {
    const db = tx ?? this.platform.db;
    const normalized = email.toLowerCase();
    const inserted = await db
      .insert(accounts)
      .values({ email: normalized, name, status: 'pending' })
      .onConflictDoNothing({ target: accounts.email })
      .returning({ id: accounts.id, status: accounts.status });
    if (inserted[0]) return { ...inserted[0], created: true };
    const [existing] = await db.select({ id: accounts.id, status: accounts.status }).from(accounts).where(eq(accounts.email, normalized));
    return { ...existing!, created: false };
  }

  async createInvitation(
    input: {
      accountId: string;
      email: string;
      tenantId: string | null;
      kind: 'tenant_user' | 'tenant_admin' | 'platform_admin';
      invitedBy: string | null;
      inviterName: string;
      workspaceName: string;
      branding?: EmailBranding;
    },
    tx?: PlatformDatabase,
  ): Promise<{ invitationId: string }> {
    const db = tx ?? this.platform.db;
    const token = this.tokens.generate(32);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86400_000);
    // Any earlier, unaccepted invitation for the same account+tenant is superseded.
    await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.accountId, input.accountId),
          input.tenantId ? eq(invitations.tenantId, input.tenantId) : isNull(invitations.tenantId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    const [row] = await db
      .insert(invitations)
      .values({
        tokenHash: this.tokens.hash(token, 'invitation'),
        accountId: input.accountId,
        tenantId: input.tenantId,
        kind: input.kind,
        invitedBy: input.invitedBy,
        expiresAt,
      })
      .returning({ id: invitations.id });
    await this.queue.enqueueEmail({
      tenantId: input.tenantId,
      to: input.email,
      template: 'invitation',
      data: {
        url: `${this.env.APP_BASE_URL}/accept-invite?token=${encodeURIComponent(token)}`,
        workspaceName: input.workspaceName,
        inviterName: input.inviterName,
        expiresAt: expiresAt.toUTCString(),
        ...(input.branding ?? {}),
      },
    });
    return { invitationId: row!.id };
  }

  async findValidInvitation(token: string) {
    const [row] = await this.platform.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, this.tokens.hash(token, 'invitation')),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async issueEmailToken(accountId: string, purpose: 'verify_email' | 'reset_password'): Promise<string> {
    const token = this.tokens.generate(32);
    const ttl = purpose === 'reset_password' ? RESET_TTL_MINUTES * 60_000 : VERIFY_TTL_HOURS * 3600_000;
    await this.platform.db.transaction(async (tx) => {
      // Only the newest token of a purpose is valid.
      await tx
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(emailTokens.accountId, accountId), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)));
      await tx.insert(emailTokens).values({
        accountId,
        purpose,
        tokenHash: this.tokens.hash(token, purpose),
        expiresAt: new Date(Date.now() + ttl),
      });
    });
    return token;
  }

  /** Atomically consumes a token. Returns the account id, or null if invalid/used/expired. */
  async consumeEmailToken(token: string, purpose: 'verify_email' | 'reset_password', tx?: PlatformDatabase): Promise<string | null> {
    const [row] = await (tx ?? this.platform.db)
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailTokens.tokenHash, this.tokens.hash(token, purpose)),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, new Date()),
        ),
      )
      .returning({ accountId: emailTokens.accountId });
    return row?.accountId ?? null;
  }
}
