import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as tenantSchema from './schema.js';

/** A Drizzle handle bound to exactly one tenant's database. */
export type TenantDb = NodePgDatabase<typeof tenantSchema>;
