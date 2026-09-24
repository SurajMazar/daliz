import { Injectable } from '@nestjs/common';
import type { RealtimeMessage } from '@daliz/shared';
import { RedisService } from './redis.js';

export const REALTIME_CHANNEL = 'daliz:realtime';

export interface RealtimeEnvelope {
  tenantId: string;
  /** Specific tenant users, or everyone connected to the tenant. */
  userIds: string[] | 'all';
  message: RealtimeMessage;
}

/**
 * Publishes real-time messages through Redis so any API instance (and the worker) can reach
 * a user's sockets, wherever they're connected. Every message names its tenant; the gateway
 * only delivers to sockets that authenticated into that tenant.
 */
@Injectable()
export class RealtimePublisher {
  constructor(private readonly redis: RedisService) {}

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    await this.redis.client.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
  }
}
