# Tenancy

## Model

```
Platform
 └─ Organization            (platform.organizations)
     └─ Tenant               (platform.tenants)  ──►  its own PostgreSQL database + role
         ├─ Tenant admins    (platform.tenant_memberships.is_tenant_admin)
         ├─ Users            (tenant.users, linked to platform.accounts)
         ├─ Roles/permissions (tenant.roles, tenant.role_permissions)
         └─ Business data, settings, branding, audit log
```

An organization can own several tenants. A tenant is an isolated business environment. Identities (email, password hash, MFA) live once in the platform database so a person can belong to several tenants; everything a user *does* inside a tenant lives in that tenant's database.

No tenant table has a `tenant_id` column. Isolation is physical:

| Boundary | Enforcement |
| --- | --- |
| Database | One database per tenant, owned by a dedicated role (`daliz_tenant_<slug>_owner`). `CONNECT` is revoked from `PUBLIC`, so no other tenant role — and not the platform role — can connect. Verified on every migration (`hardenTenantDatabase`). |
| Credentials | Each tenant role has a random password, stored AES-256-GCM encrypted (with the tenant id as associated data) in `platform.tenant_databases`. Only the connection manager decrypts it. |
| Cache | Tenant keys are always `tenant:{tenantId}:…` (`RedisKeys.tenantKey`). A test asserts no tenant key lacks the prefix. |
| Object storage | Keys are always `tenants/{tenantId}/…`, built from validated segments by `StorageService.tenantKey`; user file names never become keys. |
| Jobs | Every job payload carries an explicit `tenantId`; workers never infer tenant from ambient state. |
| Sessions | Cookies are host-only; a session is pinned to one tenant and cross-checked against the Host. |

## Request pipeline

```
Request
  │  RequestContextMiddleware  request id, IP, UA; Host → tenant (subdomain or verified custom domain)
  ▼
AccessGuard
  1. Session          cookie → live session (Redis-cached, revocation is immediate)
  2. MFA stage        mfa_pending sessions can only finish MFA
  3. CSRF / Origin    session-bound token on every mutation; Origin allow-list
  4. Platform role    loaded for platform admins
  5. Maintenance
  6. Rate limit       per route rule, per account or IP (Redis, shared across instances)
  7. Platform perms   @RequirePlatform
  8. Tenant           @TenantScoped / @RequirePermissions:
                        tenantId ← session.activeTenantId  (or an audited support session)
                        must equal the Host's tenant, if the Host implies one
                        tenant + organization active → membership active → tenant user active
                        tenant policy: session idle/max age, require-MFA
                        db ← TenantConnectionManager.get(tenantId)
  9. Tenant perms     every listed permission held
 10. Step-up          recent re-authentication where required
  ▼
Handler — reads RequestContext.tenant().db; there is no other way to reach a tenant database
```

**Tenant ids from clients are never trusted.** Not in the URL, query, body, headers or client storage. The only client-chosen tenant input is `POST /auth/tenant { tenantId }`, which merely *selects* among the tenants the account already belongs to (validated against `tenant_memberships`) and is refused if it contradicts the Host. Tests send `tenantId` in queries, bodies and headers and assert it is ignored.

`RequestContext.tenant()` throws when no tenant was resolved, so forgetting `@TenantScoped()` fails loudly instead of silently querying something else.

## Domains

- `<slug>.<TENANT_BASE_DOMAIN>` (e.g. `acme.daliz.com`, or `acme.localhost` in dev) maps to the tenant with that slug.
- Custom domains (`finance.acme.com`) are added by a Super Admin and verified with a DNS TXT record at `_daliz-verification.<domain>`; only verified domains resolve.
- The app host (`APP_BASE_URL`) and `PLATFORM_ADMIN_HOSTS` resolve to no tenant; users there pick a workspace.
- Resolution results (including misses) are cached in Redis for 60 s and invalidated on domain changes.

On a tenant host, sign-in only succeeds for members of that tenant, and a session created on one tenant host is rejected on another (`TENANT_DOMAIN_MISMATCH`).

## Connection manager

`TenantConnectionManager` keeps one small `pg.Pool` per *active* tenant, not per tenant:

| Setting | Default | Purpose |
| --- | --- | --- |
| `TENANT_POOL_MAX_CONNECTIONS` | 5 | connections per tenant pool |
| `TENANT_POOL_MAX_POOLS` | 200 | open pools per API instance; least-recently-used pool is closed when full |
| `TENANT_POOL_IDLE_TTL_SECONDS` | 300 | idle pools are closed by a sweeper |
| `TENANT_DB_STATEMENT_TIMEOUT_MS` | 15000 | `statement_timeout` on every tenant connection |

Pools open lazily, concurrent first requests share one creation promise, `idle_in_transaction_session_timeout` is set, pools are evicted on suspension/decommission, and everything drains on shutdown. Worst-case connections to Postgres ≈ `instances × MAX_POOLS × MAX_CONNECTIONS`; size `max_connections` (or put PgBouncer in transaction mode in front) accordingly. Thousands of tenants work because only recently active tenants hold pools.

## Provisioning

`POST /platform/tenants` validates input, writes the tenant (`provisioning`), its database metadata (with a freshly generated, encrypted password) and a provisioning job row in one transaction, then enqueues the job. The worker runs these steps, recording status, timing and a sanitised error for each:

| Step | Idempotency |
| --- | --- |
| `validate` | tenant must be `provisioning`/`provisioning_failed` |
| `create_role` | create or re-set password; grants the provisioner `SET` (not `INHERIT`) on it |
| `create_database` | skipped if it exists |
| `secure_database` | revoke `PUBLIC`, UTC timezone; runs as the owner and asserts the resulting ACL |
| `apply_migrations` | Drizzle migrator (tracks applied migrations) + reference-data sync (permissions, system roles, default settings) |
| `configure_storage` | ensure bucket, write tenant manifest |
| `create_tenant_admin` | upserts account (pending), membership, tenant user with Owner role |
| `send_invitation` | skipped if already sent (recorded in the job payload) |
| `activate` | tenant → `active` |

A Redis lock prevents two workers running lifecycle jobs for the same tenant, and BullMQ job ids equal the job row id, so double enqueueing is harmless. The tenant is unreachable until `activate`: login, tenant selection and every tenant route require `status = active`. On the final failed attempt the tenant becomes `provisioning_failed`; **Retry** creates a new job that skips completed steps and resumes at the failed one (covered by tests).

## Lifecycle

```
provisioning ──► active ◄──► suspended ──► decommissioning ──► decommissioned
      │                                        │ (grace period;
      └──► provisioning_failed ──retry──┘        cancellable → suspended)
```

- **Suspend** revokes every session in the tenant and closes its pool. Support access can still enter a suspended tenant to help.
- **Decommission** needs `platform.tenants.decommission`, a recent step-up, a reason, the tenant slug typed as confirmation, and the tenant must already be suspended. The job is delayed by `TENANT_DECOMMISSION_GRACE_HOURS` (default 72) and can be cancelled until it runs. It then revokes sessions, closes connections, drops the database (as its owner role), drops the role, deletes stored objects, disables memberships and removes domains. Take a backup first (see BACKUP.md).

## Migrations

- Platform: `migrations/platform`, applied on API start and by `pnpm db:migrate`.
- Tenant: `migrations/tenant`, applied to each tenant database as that tenant's own role, so objects are owned correctly.
- `pnpm db:migrate` migrates the platform, then every live tenant with bounded concurrency (`MIGRATION_CONCURRENCY`, default 4), reporting per-tenant results; exit code is non-zero if any tenant failed. Super Admins can also run it per tenant or for all tenants from the console (queued jobs, audited).
- `tenant_databases.schema_version` records the latest applied migration tag, and `last_migration_error` the last failure, so drift is visible in the console.
- Rollback strategy: migrations are written expand/contract (add → backfill → switch → drop in a later release), so the previous application version keeps working against the new schema and a rollback means redeploying the previous image. Destructive steps only ship after the release that stopped using the old shape.

Generate migrations after changing a schema:

```bash
pnpm --filter @daliz/api db:generate:platform --name <change>
pnpm --filter @daliz/api db:generate:tenant --name <change>
```
