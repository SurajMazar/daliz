import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';
import { Errors } from '../common/errors.js';

/**
 * Redis key conventions. Anything tenant-scoped MUST be built with `tenantKey` so two
 * tenants can never share a cache entry.
 */
export const RedisKeys = {
  tenantKey: (tenantId: string, ...parts: string[]) => `tenant:${tenantId}:${parts.join(':')}`,
  platformKey: (...parts: string[]) => `platform:${parts.join(':')}`,
  session: (tokenHash: string) => `platform:session:${tokenHash}`,
  rateLimit: (bucket: string, subject: string) => `rl:${bucket}:${subject}`,
};

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableAutoPipelining: true,
      lazyConnect: false,
    });
    this.client.on('error', (err: Error) => this.logger.error({ err: err.message }, 'redis error'));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  /** Deletes keys matching a pattern using SCAN (never KEYS). */
  async delPattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Short-lived distributed lock (SET NX PX). Returns a release function, or null if the
   * lock is held elsewhere.
   */
  async acquireLock(key: string, ttlMs: number): Promise<null | (() => Promise<void>)> {
    const token = Math.random().toString(36).slice(2);
    const ok = await this.client.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    if (!ok) return null;
    return async () => {
      await this.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        `lock:${key}`,
        token,
      );
    };
  }

  async ping(): Promise<number> {
    const start = performance.now();
    await this.client.ping();
    return Math.round(performance.now() - start);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

export interface RateLimitRule {
  /** Logical bucket name, e.g. 'login:ip'. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Distributed fixed-window rate limiter backed by Redis, shared across API instances.
 */
@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  async hit(rule: RateLimitRule, subject: string): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
    const key = RedisKeys.rateLimit(rule.bucket, subject);
    const results = await this.redis.client
      .multi()
      .incr(key)
      .expire(key, rule.windowSeconds, 'NX')
      .ttl(key)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Math.max(1, Number(results?.[2]?.[1] ?? rule.windowSeconds));
    return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count), retryAfter: ttl };
  }

  async enforce(rule: RateLimitRule, subject: string): Promise<void> {
    const result = await this.hit(rule, subject);
    if (!result.allowed) throw Errors.rateLimited(result.retryAfter);
  }

  async reset(rule: RateLimitRule, subject: string): Promise<void> {
    await this.redis.del(RedisKeys.rateLimit(rule.bucket, subject));
  }
}

export const RATE_LIMITS = {
  // Offices share one NAT address, so the per-IP limit is generous; per-account limits do
  // the real work against guessing.
  loginIp: { bucket: 'login:ip', limit: 150, windowSeconds: 15 * 60 },
  loginAccount: { bucket: 'login:acct', limit: 10, windowSeconds: 15 * 60 },
  mfaSession: { bucket: 'mfa:session', limit: 8, windowSeconds: 15 * 60 },
  stepUp: { bucket: 'stepup:acct', limit: 8, windowSeconds: 15 * 60 },
  passwordReset: { bucket: 'pwreset', limit: 5, windowSeconds: 60 * 60 },
  invitationAccept: { bucket: 'invite:ip', limit: 20, windowSeconds: 15 * 60 },
  /** Coarse per-IP ceiling on unauthenticated auth endpoints (route-level). */
  authEndpoints: { bucket: 'auth:ip', limit: 300, windowSeconds: 15 * 60 },
  apiDefault: { bucket: 'api', limit: 600, windowSeconds: 60 },
  apiAnonymous: { bucket: 'anon', limit: 120, windowSeconds: 60 },
  upload: { bucket: 'upload', limit: 30, windowSeconds: 60 },
  admin: { bucket: 'admin', limit: 120, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;
