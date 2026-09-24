/**
 * Migrates the platform database, syncs the platform RBAC catalog, then migrates every
 * tenant database. Safe to run repeatedly; used by deployments before rolling out the API.
 *
 *   pnpm db:migrate               # platform + all tenants
 *   pnpm db:migrate --platform    # platform only
 */
import { PlatformDb } from '../database/platform/platform-db.js';
import { TenantMigrator } from '../database/tenant/tenant-migrator.js';
import { StorageService } from '../infra/storage.js';
import { PlatformAccessService } from '../modules/platform/platform-access.service.js';
import { cliContext } from './context.js';

const app = await cliContext();
try {
  await app.get(PlatformDb).migrate();
  await app.get(PlatformAccessService).syncCatalog();
  console.log('✔ platform database migrated');
  await app.get(StorageService).ensureBucket();
  if (!process.argv.includes('--platform')) {
    const results = await app.get(TenantMigrator).migrateAll(Number(process.env.MIGRATION_CONCURRENCY ?? 4));
    for (const r of results) console.log(`${r.ok ? '✔' : '✘'} tenant ${r.tenantId} ${r.ok ? r.schemaVersion : r.error}`);
    console.log(`tenants: ${results.filter((r) => r.ok).length} migrated, ${results.filter((r) => !r.ok).length} failed`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  }
} finally {
  await app.close();
}
