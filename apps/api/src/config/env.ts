import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const base64Key = (minBytes: number) =>
  z.string().refine((v) => Buffer.from(v, 'base64').length >= minBytes, {
    message: `must be base64 encoding at least ${minBytes} bytes`,
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_PORT: z.coerce.number().int().default(3000),
  APP_BASE_URL: z.string().url(),
  CORS_EXTRA_ORIGINS: csv,
  TENANT_BASE_DOMAIN: z.string().min(1).default('localhost'),
  PLATFORM_ADMIN_HOSTS: csv,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  PLATFORM_DB_HOST: z.string().min(1),
  PLATFORM_DB_PORT: z.coerce.number().int(),
  PLATFORM_DB_NAME: z.string().min(1),
  PLATFORM_DB_USER: z.string().min(1),
  PLATFORM_DB_PASSWORD: z.string().min(1),
  PLATFORM_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  PROVISIONER_DB_USER: z.string().min(1),
  PROVISIONER_DB_PASSWORD: z.string().min(1),
  TENANT_DB_HOST: z.string().min(1),
  TENANT_DB_PORT: z.coerce.number().int(),
  TENANT_DB_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,20}$/)
    .default('daliz_tenant_'),
  TENANT_POOL_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(50).default(5),
  TENANT_POOL_MAX_POOLS: z.coerce.number().int().min(1).max(10_000).default(200),
  TENANT_POOL_IDLE_TTL_SECONDS: z.coerce.number().int().min(10).default(300),
  TENANT_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  /** Hours between scheduling a decommission and actually dropping the tenant database. */
  TENANT_DECOMMISSION_GRACE_HOURS: z.coerce.number().min(0).max(24 * 90).default(72),

  REDIS_URL: z.string().min(1),

  ENCRYPTION_KEYS: z
    .string()
    .min(1)
    .transform((v, ctx) => {
      const keys = v.split(',').map((entry) => {
        const [id, key] = entry.trim().split(':');
        const buf = Buffer.from(key ?? '', 'base64');
        if (!id || buf.length !== 32) {
          ctx.addIssue({ code: 'custom', message: `invalid key "${id ?? ''}" (need id:base64 32 bytes)` });
        }
        return { id: id ?? '', key: buf };
      });
      return keys;
    }),
  TOKEN_HMAC_KEY: base64Key(32),

  SESSION_COOKIE_NAME: z.string().regex(/^[a-z_]+$/).default('daliz_sid'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(120),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).default(168),
  STEP_UP_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(false),

  FILE_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(50),
  /** clamd host for malware scanning. Unset = built-in heuristic scanner (development). */
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  /** Web Push (VAPID). Unset = push notifications disabled. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@daliz.local'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int(),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(3),

  SEED_SUPERADMIN_EMAIL: z.string().email().optional(),
  SEED_SUPERADMIN_PASSWORD: z.string().optional(),
  SEED_DEFAULT_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const DEV_ONLY_MARKER = /dev_only|dev-only|ZGV2LW9ubHkt/;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    // Refuse to boot production with development secrets.
    const secrets = {
      PLATFORM_DB_PASSWORD: env.PLATFORM_DB_PASSWORD,
      PROVISIONER_DB_PASSWORD: env.PROVISIONER_DB_PASSWORD,
      ENCRYPTION_KEYS: source.ENCRYPTION_KEYS ?? '',
      TOKEN_HMAC_KEY: env.TOKEN_HMAC_KEY,
      S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
      REDIS_URL: env.REDIS_URL,
    };
    const weak = Object.entries(secrets)
      .filter(([, v]) => DEV_ONLY_MARKER.test(v))
      .map(([k]) => k);
    if (weak.length) throw new Error(`Development secrets used in production: ${weak.join(', ')}`);
    if (!env.APP_BASE_URL.startsWith('https://')) {
      throw new Error('APP_BASE_URL must use https in production');
    }
  }
  if (source === process.env) cached = env;
  return env;
}

export const ENV = Symbol('ENV');
