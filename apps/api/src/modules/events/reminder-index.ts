import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis.js';

const KEY = 'platform:reminders:due';

/**
 * Platform-wide index of upcoming reminders (Redis sorted set scored by due time). The
 * scheduler reads only what's due instead of scanning every tenant database. Members carry
 * their tenant explicitly: "<tenantId>:<reminderId>". The database stays the source of truth;
 * the index is rebuilt from it periodically.
 */
@Injectable()
export class ReminderIndex {
  constructor(private readonly redis: RedisService) {}

  async schedule(tenantId: string, reminderId: string, at: Date): Promise<void> {
    await this.redis.client.zadd(KEY, at.getTime(), `${tenantId}:${reminderId}`);
  }

  async unschedule(tenantId: string, reminderId: string): Promise<void> {
    await this.redis.client.zrem(KEY, `${tenantId}:${reminderId}`);
  }

  /** Atomically claims due entries so two workers never fire the same reminder. */
  async claimDue(now: Date, limit = 200): Promise<{ tenantId: string; reminderId: string }[]> {
    const members = await this.redis.client.zrangebyscore(KEY, '-inf', now.getTime(), 'LIMIT', 0, limit);
    const claimed: { tenantId: string; reminderId: string }[] = [];
    for (const m of members) {
      if ((await this.redis.client.zrem(KEY, m)) === 1) {
        const [tenantId, reminderId] = m.split(':');
        if (tenantId && reminderId) claimed.push({ tenantId, reminderId });
      }
    }
    return claimed;
  }
}
