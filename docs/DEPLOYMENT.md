# Deployment

## Artifacts

| Image | Built from | Runs |
| --- | --- | --- |
| `daliz-api` | `apps/api/Dockerfile` | `dist/main.js` (HTTP + WebSocket API), `dist/worker.js` (background jobs), `dist/cli/migrate.js` (migrations) |
| `daliz-web` | `infra/docker/web.Dockerfile` | nginx serving the React app (web + PWA) and reverse-proxying `/api` (including WebSocket upgrades) |
| Desktop builds | `apps/desktop` (Neutralino) | signed per-platform bundles published by CI |

Both images run as non-root users with read-only root filesystems (see `compose.prod.yaml` for the hardening flags).

## Topology

```
Internet ─► TLS load balancer / ingress ─► daliz-web (nginx, N replicas)
                                               │  /api/*  (HTTP + WS upgrade)
                                               ▼
                                          daliz-api (N replicas, stateless)
                                               │
          ┌───────────────┬────────────────────┼────────────────────┐
          ▼               ▼                    ▼                    ▼
   Postgres cluster    Redis              Object storage        daliz-worker (M replicas)
   (platform DB +      (sessions cache,   (S3 / GCS / R2 /       provisioning, email,
    tenant DBs,        rate limits,       MinIO, versioned,      notifications, reminders,
    PgBouncer)         queues, pub/sub)   encrypted)             file scanning, maintenance
                                                                 ▼
                                                               ClamAV (clamd)
```

- API instances are stateless: sessions live in Postgres (cached in Redis), real-time fan-out goes through Redis pub/sub, and rate limits are in Redis. Scale horizontally behind the load balancer; WebSockets need sticky sessions only if you enable the long-polling transport.
- The worker can run several replicas. Lifecycle jobs take per-tenant Redis locks, and reminders are claimed atomically.
- Postgres: tenant databases can share a cluster or be spread across several (`tenant_databases.db_host/db_port` are per tenant). Put PgBouncer (transaction pooling) in front, and size `max_connections ≥ api_instances × TENANT_POOL_MAX_POOLS × TENANT_POOL_MAX_CONNECTIONS + platform pools`.

## Configuration

All configuration comes from environment variables, validated at boot (`apps/api/src/config/env.ts`); `.env.example` documents each one. Production specifics:

- `NODE_ENV=production`, `APP_BASE_URL=https://app.example.com` (must be HTTPS), `TENANT_BASE_DOMAIN=example.com` (tenants at `<slug>.example.com`; point a wildcard DNS record and certificate at the load balancer), `PLATFORM_ADMIN_HOSTS=admin.example.com` (the Super Admin API only answers there), `TRUST_PROXY_HOPS` = number of proxies in front of the API (nginx + load balancer = 2).
- Database: `PLATFORM_DB_*` for the platform role, `PROVISIONER_DB_*` for the CREATEDB/CREATEROLE role, used by the worker and migrator only (the API process needs it only if you run migrations from it), and `TENANT_DB_HOST/PORT` for where new tenant databases are created. Use TLS to Postgres.
- `REDIS_URL` (use `rediss://` with auth), `S3_*`, `SMTP_*`, `MAIL_FROM`.
- `CLAMAV_HOST` / `CLAMAV_PORT`. **Required in production**; without it uploads only get the heuristic check.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` for web push (`npx web-push generate-vapid-keys`).
- `S3_PUBLIC_ORIGIN` for the web image: the origin browsers use for signed file URLs (added to the CSP).

### Secrets

Keep secrets in a secret manager (AWS Secrets Manager, GCP Secret Manager, Vault, Doppler) and inject them as environment variables at runtime; never bake them into images or commit them. The API refuses to start in production with any development default. Rotate:

- `ENCRYPTION_KEYS`: prepend a new `id:key`, deploy, then re-encrypt tenant database passwords and TOTP secrets. Ciphertexts carry their key id, so old keys keep decrypting until removed.
- `TOKEN_HMAC_KEY`: rotating it invalidates all sessions, invitations and reset links, so plan a sign-out.
- Tenant database passwords are generated per tenant. To rotate one, re-run the `create_role` provisioning step with a new encrypted password, then evict pools.

## Rollout

1. CI builds and tests, then produces images tagged with the commit SHA (`.github/workflows/ci.yml`).
2. Run the **migrate** job with the new image: `node dist/cli/migrate.js`. It migrates the platform database, then every tenant database with bounded concurrency, and exits non-zero if any tenant fails. Migrations are expand/contract (see TENANCY.md), so the old version keeps working during the rollout.
3. Roll the API and worker deployments (health gate: `/api/v1/health/ready`).
4. Roll the web image. The PWA's service worker picks up the new build on the user's next navigation and asks before reloading.

**Rollback:** redeploy the previous image tags. Because migrations are backwards compatible, no down-migration is needed. If a tenant migration failed, the console shows it (`last_migration_error`); fix and re-run per tenant from **Tenants → Migrate**.

## Health and monitoring

- Liveness `/api/v1/health/live`, readiness `/api/v1/health/ready` (platform DB + Redis).
- Detailed status for operators: Super Admin → System health (dependency latency, tenant pool usage, queue depths, version).
- Ship JSON logs to your aggregator and alert on 5xx rate, `unhandled error` logs, failed jobs (`job failed`), `tenant lifecycle job failed`, `malware quarantined`, and critical security events (support sessions, admin access resets).
- Watch queue depth (`waiting`, `failed`) for `provisioning`, `email`, `notifications`, `files`, `reminders`.

## Local production smoke test

```bash
docker build -f apps/api/Dockerfile -t daliz-api:latest .
docker build -f infra/docker/web.Dockerfile -t daliz-web:latest .
cp .env.example .env.production   # then replace every *_dev_only value and set NODE_ENV=production
S3_PUBLIC_ORIGIN=https://storage.example.com docker compose -f compose.prod.yaml --env-file .env.production up -d
```
