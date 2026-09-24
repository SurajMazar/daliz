import { createApp } from './bootstrap.js';
import { ENV, type Env } from './config/env.js';
import { PlatformDb } from './database/platform/platform-db.js';
import { StorageService } from './infra/storage.js';
import { PlatformAccessService } from './modules/platform/platform-access.service.js';

async function main() {
  const app = await createApp();
  const env = app.get<Env>(ENV);
  // Platform schema and RBAC catalog are always brought up to date before serving traffic.
  await app.get(PlatformDb).migrate();
  await app.get(PlatformAccessService).syncCatalog();
  await app.get(StorageService).ensureBucket().catch((err: Error) => {
    console.warn(`Object storage unavailable at startup: ${err.message}`);
  });
  await app.listen(env.API_PORT, '0.0.0.0');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
