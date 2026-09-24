import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { HealthReport } from '@daliz/shared';
import { PlatformDb } from '../../database/platform/platform-db.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import { QueueService } from '../../infra/queue.js';
import { RedisService } from '../../infra/redis.js';
import { StorageService } from '../../infra/storage.js';

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

async function timed(name: string, fn: () => Promise<number>) {
  try {
    const latencyMs = await Promise.race([
      fn(),
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return { name, status: 'ok' as const, latencyMs };
  } catch (err) {
    return { name, status: 'down' as const, latencyMs: null, detail: (err as Error).message.slice(0, 120) };
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
    private readonly connections: TenantConnectionManager,
  ) {}

  async report(): Promise<HealthReport> {
    const checks = await Promise.all([
      timed('platform_database', () => this.platform.ping()),
      timed('redis', () => this.redis.ping()),
      timed('object_storage', () => this.storage.ping()),
    ]);
    const queues = await this.queues.counts().catch(() => []);
    const critical = checks.filter((c) => c.name !== 'object_storage');
    const status = critical.some((c) => c.status === 'down') ? 'down' : checks.some((c) => c.status === 'down') ? 'degraded' : 'ok';
    return {
      status,
      checks,
      tenantPools: this.connections.stats(),
      queues,
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async ready(): Promise<boolean> {
    const [db, redis] = await Promise.all([timed('db', () => this.platform.ping()), timed('redis', () => this.redis.ping())]);
    return db.status === 'ok' && redis.status === 'ok';
  }
}
