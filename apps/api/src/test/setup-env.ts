/**
 * Test environment: same infrastructure as development, but a separate platform database,
 * tenant database prefix, Redis logical database and storage bucket, so tests never touch
 * development data.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const redis = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0');
redis.pathname = '/1';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.TEST_LOGS === '1' ? 'error' : 'silent',
  PLATFORM_DB_NAME: `${(process.env.PLATFORM_DB_NAME ?? 'daliz_platform').replace(/_test$/, '')}_test`,
  TENANT_DB_PREFIX: 'daliz_test_',
  S3_BUCKET: 'daliz-test',
  REDIS_URL: redis.toString(),
  TENANT_DECOMMISSION_GRACE_HOURS: '0',
  APP_BASE_URL: 'http://localhost:5173',
  CORS_EXTRA_ORIGINS: '',
  TENANT_BASE_DOMAIN: 'localhost',
  PLATFORM_ADMIN_HOSTS: '',
});
