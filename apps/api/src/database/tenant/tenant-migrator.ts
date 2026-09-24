import { Injectable, Logger } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PlatformDb } from '../platform/platform-db.js';
import { tenantDatabases, tenants } from '../platform/schema.js';
import { MIGRATIONS, latestMigrationTag } from '../paths.js';
import * as tenantSchema from './schema.js';
import { TenantConnectionManager } from './tenant-connection-manager.js';
import { syncTenantReferenceData } from './tenant-seed.js';
import type { TenantSettings } from '@daliz/shared';

/**
 * Locks a tenant database down to its own role. Must run as the database OWNER: a
 * non-owner's REVOKE on a database is silently a no-op in PostgreSQL. Runs on every
 * migration so existing tenants are re-hardened too.
 */
export async function hardenTenantDatabase(pool: pg.Pool, database: string): Promise<void> {
  const client = await pool.connect();
  try {
    const db = client.escapeIdentifier(database);
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(`ALTER DATABASE ${db} SET timezone TO 'UTC'`);
    const { rows } = await client.query<{ datacl: string | null }>('select datacl::text from pg_database where datname = current_database()');
    const acl = rows[0]?.datacl ?? '';
    // "=c/..." (an empty grantee) would mean PUBLIC can still connect.
    if (!acl || /(^|[{,])=[^,}]*c/.test(acl)) throw new Error(`Tenant database ${database} is still connectable by PUBLIC`);
  } finally {
    client.release();
  }
}

export interface TenantMigrationResult {
  tenantId: string;
  ok: boolean;
  schemaVersion?: string;
  error?: string;
}

/**
 * Applies the tenant schema to tenant databases. Migrations run as the tenant's own role so
 * the objects they create are owned by it. Never assumes there is only one database.
 */
@Injectable()
export class TenantMigrator {
  private readonly logger = new Logger(TenantMigrator.name);

  constructor(
    private readonly platform: PlatformDb,
    private readonly connections: TenantConnectionManager,
  ) {}

  latestVersion(): string {
    return latestMigrationTag(MIGRATIONS.tenant);
  }

  async migrateTenant(tenantId: string, general?: TenantSettings): Promise<string> {
    const creds = await this.connections.credentials(tenantId, { requireReady: false });
    const pool = this.connections.createPool(creds, 'daliz-migrator', 1);
    try {
      await this.platform.db
        .update(tenantDatabases)
        .set({ status: 'migrating', updatedAt: new Date() })
        .where(eq(tenantDatabases.tenantId, tenantId));
      await hardenTenantDatabase(pool, creds.database);
      const db = drizzle({ client: pool, schema: tenantSchema });
      await migrate(db, { migrationsFolder: MIGRATIONS.tenant });
      await syncTenantReferenceData(db, general);
      const version = this.latestVersion();
      await this.platform.db
        .update(tenantDatabases)
        .set({
          status: 'ready',
          schemaVersion: version,
          migratedAt: new Date(),
          lastMigrationError: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantDatabases.tenantId, tenantId));
      return version;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.platform.db
        .update(tenantDatabases)
        .set({ status: 'failed', lastMigrationError: message.slice(0, 1000), updatedAt: new Date() })
        .where(eq(tenantDatabases.tenantId, tenantId));
      throw err;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  /** Migrates every live tenant database with bounded concurrency. */
  async migrateAll(concurrency = 4): Promise<TenantMigrationResult[]> {
    const rows = await this.platform.db
      .select({ tenantId: tenants.id })
      .from(tenants)
      .innerJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
      .where(inArray(tenantDatabases.status, ['ready', 'failed', 'migrating']));
    const queue = rows.map((r) => r.tenantId);
    const results: TenantMigrationResult[] = [];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const schemaVersion = await this.migrateTenant(id);
          results.push({ tenantId: id, ok: true, schemaVersion });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.logger.error({ tenantId: id, error }, 'tenant migration failed');
          results.push({ tenantId: id, ok: false, error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return results;
  }
}
