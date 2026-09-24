import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { ENV, type Env } from '../../config/env.js';
import { EncryptionService } from '../../common/crypto.js';
import { Errors } from '../../common/errors.js';
import { PlatformDb } from '../platform/platform-db.js';
import { tenantDatabases } from '../platform/schema.js';
import * as tenantSchema from './schema.js';
import type { TenantDb } from './tenant-db.js';

interface PoolEntry {
  tenantId: string;
  pool: pg.Pool;
  db: TenantDb;
  lastUsedAt: number;
}

export interface TenantDbCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * Owns every connection pool to tenant databases.
 *
 * With one database per tenant, naive "one pool per tenant forever" exhausts Postgres at a
 * few hundred tenants. This manager:
 *  - creates pools lazily on first use,
 *  - caps connections per pool (TENANT_POOL_MAX_CONNECTIONS),
 *  - caps the number of open pools (TENANT_POOL_MAX_POOLS) and evicts least-recently-used,
 *  - closes pools idle longer than TENANT_POOL_IDLE_TTL_SECONDS,
 *  - applies statement and idle-in-transaction timeouts to every connection,
 *  - de-duplicates concurrent pool creation for the same tenant,
 *  - drains everything on shutdown.
 */
@Injectable()
export class TenantConnectionManager implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TenantConnectionManager.name);
  private readonly pools = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<PoolEntry>>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly encryption: EncryptionService,
  ) {}

  onModuleInit(): void {
    const interval = Math.min(60_000, this.env.TENANT_POOL_IDLE_TTL_SECONDS * 500);
    this.sweepTimer = setInterval(() => void this.sweepIdle(), interval);
    this.sweepTimer.unref();
  }

  async get(tenantId: string): Promise<TenantDb> {
    const existing = this.pools.get(tenantId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // Re-insert to keep Map iteration order == LRU order.
      this.pools.delete(tenantId);
      this.pools.set(tenantId, existing);
      return existing.db;
    }
    let inflight = this.pending.get(tenantId);
    if (!inflight) {
      inflight = this.open(tenantId).finally(() => this.pending.delete(tenantId));
      this.pending.set(tenantId, inflight);
    }
    return (await inflight).db;
  }

  /** Loads and decrypts a tenant's database credentials from the platform database. */
  async credentials(tenantId: string, opts: { requireReady?: boolean } = {}): Promise<TenantDbCredentials> {
    const [row] = await this.platform.db
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.tenantId, tenantId))
      .limit(1);
    if (!row) throw Errors.tenantUnavailable();
    if ((opts.requireReady ?? true) && row.status !== 'ready') throw Errors.tenantUnavailable();
    return {
      host: row.dbHost,
      port: row.dbPort,
      database: row.dbName,
      user: row.dbUser,
      password: this.encryption.decrypt(row.dbPasswordEnc, `tenant-db:${tenantId}`),
    };
  }

  /** Creates a standalone pool (used by the migrator/provisioner, not cached). */
  createPool(creds: TenantDbCredentials, applicationName: string, max = 2): pg.Pool {
    const pool = new pg.Pool({
      ...creds,
      max,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: this.env.TENANT_DB_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: 30_000,
      application_name: applicationName,
    });
    pool.on('error', (err) => this.logger.warn({ err: err.message }, 'tenant pool client error'));
    return pool;
  }

  private async open(tenantId: string): Promise<PoolEntry> {
    const creds = await this.credentials(tenantId);
    while (this.pools.size >= this.env.TENANT_POOL_MAX_POOLS) {
      const lru = this.pools.keys().next().value as string | undefined;
      if (!lru) break;
      await this.evict(lru, 'capacity');
    }
    const pool = this.createPool(creds, `daliz-tenant`, this.env.TENANT_POOL_MAX_CONNECTIONS);
    const entry: PoolEntry = {
      tenantId,
      pool,
      db: drizzle({ client: pool, schema: tenantSchema }),
      lastUsedAt: Date.now(),
    };
    this.pools.set(tenantId, entry);
    this.logger.debug({ tenantId, open: this.pools.size }, 'tenant pool opened');
    return entry;
  }

  /** Closes a tenant's pool, e.g. on suspension, decommission or credential rotation. */
  async evict(tenantId: string, reason: string): Promise<void> {
    const entry = this.pools.get(tenantId);
    if (!entry) return;
    this.pools.delete(tenantId);
    await entry.pool.end().catch(() => undefined);
    this.logger.debug({ tenantId, reason }, 'tenant pool closed');
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.env.TENANT_POOL_IDLE_TTL_SECONDS * 1000;
    for (const [tenantId, entry] of this.pools) {
      if (entry.lastUsedAt < cutoff && entry.pool.waitingCount === 0 && entry.pool.idleCount === entry.pool.totalCount) {
        await this.evict(tenantId, 'idle');
      }
    }
  }

  stats(): { open: number; max: number } {
    return { open: this.pools.size, max: this.env.TENANT_POOL_MAX_POOLS };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all([...this.pools.keys()].map((id) => this.evict(id, 'shutdown')));
  }
}
