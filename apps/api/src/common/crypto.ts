import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { ENV, type Env } from '../config/env.js';

/**
 * Envelope-style symmetric encryption for secrets at rest (tenant DB passwords, TOTP
 * secrets). AES-256-GCM via Node's crypto; no custom primitives. Ciphertexts carry the key
 * id, so keys can be rotated: the first key in ENCRYPTION_KEYS encrypts, all keys decrypt.
 *
 * Format: v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */
@Injectable()
export class EncryptionService {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(@Inject(ENV) env: Env) {
    this.keys = new Map(env.ENCRYPTION_KEYS.map((k) => [k.id, k.key]));
    this.activeKeyId = env.ENCRYPTION_KEYS[0]!.id;
  }

  encrypt(plaintext: string, aad = ''): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.activeKeyId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string, aad = ''): string {
    const [version, keyId, iv, tag, ct] = payload.split('.');
    if (version !== 'v1' || !keyId || !iv || !tag || ct === undefined) throw new Error('Malformed ciphertext');
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key id ${keyId}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** Opaque random tokens (sessions, invitations, resets) and their keyed hashes. */
@Injectable()
export class TokenService {
  private readonly hmacKey: Buffer;

  constructor(@Inject(ENV) env: Env) {
    this.hmacKey = Buffer.from(env.TOKEN_HMAC_KEY, 'base64');
  }

  generate(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Keyed hash so a leaked database alone cannot be used to forge lookups. */
  hash(token: string, purpose: string): string {
    return createHmac('sha256', this.hmacKey).update(`${purpose}:${token}`).digest('base64url');
  }

  sign(value: string): string {
    return createHmac('sha256', this.hmacKey).update(`sig:${value}`).digest('base64url');
  }

  verifySignature(value: string, signature: string): boolean {
    return safeEqual(this.sign(value), signature);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1).
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, algorithm: 2 as const };

@Injectable()
export class PasswordService {
  /** Hash computed once so unknown-email logins spend the same time as real ones. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argonHash(password, ARGON_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= argonHash('not-a-real-password-for-timing', ARGON_OPTIONS);
      await argonVerify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await argonVerify(hash, password);
    } catch {
      return false;
    }
  }
}
