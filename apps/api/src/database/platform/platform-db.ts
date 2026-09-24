import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { ENV, type Env } from '../../config/env.js';
import { MIGRATIONS } from '../paths.js';
import * as schema from './schema.js';

export type PlatformDatabase = NodePgDatabase<typeof schema>;

@Injectable()
export class PlatformDb implements OnApplicationShutdown {
  readonly pool: pg.Pool;
  readonly db: PlatformDatabase;
  private readonly logger = new Logger(PlatformDb.name);

  constructor(@Inject(ENV) env: Env) {
    this.pool = new pg.Pool({
      host: env.PLATFORM_DB_HOST,
      port: env.PLATFORM_DB_PORT,
      database: env.PLATFORM_DB_NAME,
      user: env.PLATFORM_DB_USER,
      password: env.PLATFORM_DB_PASSWORD,
      max: env.PLATFORM_DB_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'daliz-platform',
    });
    this.pool.on('error', (err) => this.logger.error({ err: err.message }, 'platform pool error'));
    this.db = drizzle({ client: this.pool, schema });
  }

  async migrate(): Promise<void> {
    await migrate(this.db, { migrationsFolder: MIGRATIONS.platform });
  }

  async ping(): Promise<number> {
    const start = performance.now();
    await this.pool.query('select 1');
    return Math.round(performance.now() - start);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
