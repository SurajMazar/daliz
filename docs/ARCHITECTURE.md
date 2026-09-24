# Architecture

## Components

```
           Browser / PWA / Desktop (one React app)
                         │ HTTPS, same origin (/api proxied)
                ┌────────▼────────┐
                │ Reverse proxy   │  TLS, static web assets, security headers
                └────────┬────────┘
                ┌────────▼────────┐         ┌──────────────┐
                │  API (NestJS)   │────────►│    Redis     │ sessions cache, rate limits,
                │  stateless, N×  │         │              │ locks, BullMQ queues
                └───┬─────────┬───┘         └──────▲───────┘
                    │         │                    │
     platform pool  │         │ tenant pools       │ jobs
                    ▼         ▼                    │
          ┌────────────┐  ┌──────────────┐  ┌──────┴───────┐
          │ platform DB│  │ tenant DBs … │◄─│   Worker     │ provisioning, migrations,
          └────────────┘  └──────────────┘  │  (NestJS)    │ email, maintenance
                                            └──────┬───────┘
                          ┌─────────────────┐      │
                          │ Object storage  │◄─────┘  logos, files (S3/MinIO)
                          └─────────────────┘
```

The API and the worker are one codebase (`apps/api`) with two entry points (`dist/main.js`, `dist/worker.js`) that share `CoreModule`, built into one container image. They scale independently.

## Repository

```
apps/
  api/                 NestJS API + worker + CLI (migrate, seed)
    src/
      config/          environment schema (validated at boot)
      common/          request context (AsyncLocalStorage), errors, crypto, HTTP plumbing
      database/
        platform/      platform schema + pool
        tenant/        tenant schema, connection manager, migrator, reference-data sync
      infra/           redis + rate limiter, queues, object storage, mail
      modules/
        auth/          sessions, login/MFA/step-up, invitations, AccessGuard
        tenancy/       domain resolver, tenant directory, tenant context
        platform/      Super Admin API, provisioning/lifecycle, platform RBAC
        tenant-admin/  users, roles, settings, security policy, audit
        branding/      logo pipeline (Color Thief), theme persistence, public branding
        audit/         platform + tenant audit, security events
        health/
      worker/          BullMQ processors and maintenance
      cli/             migrate, seed
      test/            integration & security suite
    migrations/{platform,tenant}
  web/                 React app (web + PWA; wrapped by the desktop app)
packages/
  shared/              permission catalog, Zod schemas, API types, theme engine (used by api + web)
infra/                 compose init scripts, reverse proxy config
docs/
```

## Key design decisions

- **Database per tenant.** Strongest practical isolation: a bug in a query can't read another tenant's rows, because those rows are in a database the connection can't reach. The cost is operational (migrations fan out, connection pooling needs care, backups are per tenant), handled by the migrator, connection manager and per-tenant backup design.
- **Central identities.** One account can belong to several tenants and authenticate once. Authorization data (roles, permissions) lives in the tenant, where the tenant controls it.
- **Tenant context via AsyncLocalStorage.** `RequestContext.tenant()` is the only way services reach a tenant database, and it throws if no tenant was resolved. Jobs create their own scope with an explicit tenant id.
- **Shared contract package.** Zod schemas validate on the server (authoritative) and drive forms on the client, and response types are shared, so drift between API and UI shows up as a compile error.
- **One guard, fixed order.** Security checks live in one place (`AccessGuard`), in a documented order, instead of scattered per-controller logic.
- **Server-derived theme tokens.** Tenants supply five hex colours. Every CSS variable is derived and WCAG-checked by shared code, so tenant input never becomes CSS.
- **ESM throughout.** NestJS 12 is ESM-only, and so are the shared package and the web app.

## Observability

- Structured JSON logs (pino) with request ids (`X-Request-Id`, generated or accepted if well-formed). Cookies, authorization/CSRF headers and query strings are redacted.
- Health: `/api/v1/health/live` (process), `/api/v1/health/ready` (platform DB + Redis). A detailed report (DB/Redis/storage latency, tenant pool usage, queue depth, version, uptime) is available to platform admins at `/platform/health` and on the console dashboard.
- Every job logs failures with queue, job id and attempt number. Provisioning steps keep their own timing and errors.
- Error monitoring: 5xx errors are logged with request id and stack. Ship logs to your aggregator, and add Sentry/OpenTelemetry exporters at the logger/interceptor level (hook points: `AllExceptionsFilter`, `loggerModule`).
