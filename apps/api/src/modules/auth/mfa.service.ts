import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { EncryptionService, TokenService } from '../../common/crypto.js';
import { PlatformDb, type PlatformDatabase } from '../../database/platform/platform-db.js';
import { accounts, recoveryCodes } from '../../database/platform/schema.js';

const PERIOD = 30;
const RECOVERY_CODE_COUNT = 10;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function recoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
}

/**
 * TOTP (RFC 6238) enrolment and verification. Secrets are encrypted at rest; a code's time
 * step is recorded on use so the same code can't be replayed inside its validity window.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
  ) {}

  private totp(secretBase32: string, email: string): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: 'Daliz',
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: PERIOD,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
  }

  async beginEnrollment(accountId: string, email: string) {
    const secret = new OTPAuth.Secret({ size: 20 });
    await this.platform.db
      .update(accounts)
      .set({ mfaPendingSecretEnc: this.encryption.encrypt(secret.base32, `mfa:${accountId}`), updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
    const otpauthUrl = this.totp(secret.base32, email).toString();
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    return { otpauthUrl, qrCodeDataUrl, secret: secret.base32 };
  }

  /** Confirms the pending secret with a code and switches MFA on. Returns recovery codes. */
  async completeEnrollment(accountId: string, email: string, code: string): Promise<string[] | null> {
    const [acct] = await this.platform.db
      .select({ pending: accounts.mfaPendingSecretEnc })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!acct?.pending) return null;
    const secret = this.encryption.decrypt(acct.pending, `mfa:${accountId}`);
    const step = this.validate(secret, email, code);
    if (step === null) return null;
    return this.platform.db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({
          mfaEnabled: true,
          mfaSecretEnc: acct.pending,
          mfaPendingSecretEnc: null,
          mfaEnabledAt: new Date(),
          mfaLastUsedStep: step,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
      return this.replaceRecoveryCodes(accountId, tx);
    });
  }

  async disable(accountId: string): Promise<void> {
    await this.platform.db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({ mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaEnabledAt: null, mfaLastUsedStep: null, updatedAt: new Date() })
        .where(eq(accounts.id, accountId));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId));
    });
  }

  /** Verifies a TOTP code for an enrolled account, with replay protection. */
  async verifyCode(accountId: string, code: string): Promise<boolean> {
    const [acct] = await this.platform.db
      .select({ secret: accounts.mfaSecretEnc, email: accounts.email, lastStep: accounts.mfaLastUsedStep, enabled: accounts.mfaEnabled })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!acct?.enabled || !acct.secret) return false;
    const step = this.validate(this.encryption.decrypt(acct.secret, `mfa:${accountId}`), acct.email, code);
    if (step === null || (acct.lastStep !== null && step <= acct.lastStep)) return false;
    // Conditional update: two concurrent requests can't both consume the same step.
    const updated = await this.platform.db
      .update(accounts)
      .set({ mfaLastUsedStep: step })
      .where(and(eq(accounts.id, accountId), acct.lastStep === null ? isNull(accounts.mfaLastUsedStep) : eq(accounts.mfaLastUsedStep, acct.lastStep)))
      .returning({ id: accounts.id });
    return updated.length === 1;
  }

  async useRecoveryCode(accountId: string, code: string): Promise<boolean> {
    const hash = this.tokens.hash(code.toLowerCase(), 'recovery');
    const used = await this.platform.db
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(recoveryCodes.accountId, accountId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id });
    return used.length === 1;
  }

  async remainingRecoveryCodes(accountId: string): Promise<number> {
    const rows = await this.platform.db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.accountId, accountId), isNull(recoveryCodes.usedAt)));
    return rows.length;
  }

  async replaceRecoveryCodes(accountId: string, tx?: PlatformDatabase): Promise<string[]> {
    const db = tx ?? this.platform.db;
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    await db.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId));
    await db.insert(recoveryCodes).values(codes.map((c) => ({ accountId, codeHash: this.tokens.hash(c, 'recovery') })));
    return codes;
  }

  /** Returns the matched time step, or null. Accepts ±1 step of clock drift. */
  private validate(secretBase32: string, email: string, code: string): number | null {
    const delta = this.totp(secretBase32, email).validate({ token: code, window: 1 });
    if (delta === null) return null;
    return Math.floor(Date.now() / 1000 / PERIOD) + delta;
  }
}
