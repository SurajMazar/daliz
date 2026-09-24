# Backup & restore

> Status: the design below is settled; the operator runbook works today with standard tools. The console-driven per-tenant backup/restore jobs (API, UI, metadata table) are scheduled for the backup slice and are **not implemented yet**.

## What needs protecting

| Data | Where | Method |
| --- | --- | --- |
| Platform database | `daliz_platform` | cluster-level continuous backup (below) + nightly logical dump |
| Tenant databases | `daliz_tenant_*` | cluster-level continuous backup + per-tenant logical dumps |
| Files and logos | object storage `tenants/<id>/…` | bucket versioning + replication to a second region |
| Secrets (encryption keyring) | secret manager | secret manager's own versioning; **without the keyring, encrypted tenant DB passwords and TOTP secrets can't be read** |

## Cluster level: point-in-time recovery

Run WAL archiving with pgBackRest or WAL-G (or the managed equivalent: RDS/Aurora automated backups, Cloud SQL PITR) to encrypted object storage: weekly full, daily differential, continuous WAL, 30-day retention. This covers every database in the cluster, platform and tenants alike, and lets you restore the whole cluster to any second in the window.

## Tenant level: logical dumps

Because every tenant has its own database, one tenant can be backed up and restored without touching the others:

```bash
# Backup (runs as the tenant's own role; credentials from the platform DB via the API's CLI)
pg_dump --format=custom --no-owner --no-privileges --dbname "$TENANT_URL" --file "$TENANT_ID-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Encrypt and upload
age -r "$BACKUP_PUBLIC_KEY" … | aws s3 cp - "s3://daliz-backups/tenants/$TENANT_ID/…"
```

Restore without overwriting live data:

1. Suspend the tenant (revokes sessions, closes pools).
2. Create a scratch database owned by the tenant role and `pg_restore --no-owner --role=<tenant role>` into it.
3. Verify: `select schema version`, row counts, checksum of key tables.
4. Swap names (`ALTER DATABASE … RENAME`) during the maintenance window and keep the old database for the retention period.
5. Update `tenant_databases.schema_version`, run `pnpm db:migrate` if the dump predates current migrations, reactivate, and record everything in the platform audit log.

Point-in-time restore of **one** tenant: restore the cluster backup to a temporary instance at the target time, `pg_dump` that tenant's database from it, then follow the restore steps above.

## Planned in-product workflow (backup slice)

- `tenant_backups` metadata (id, tenant, kind, status, size, SHA-256, storage key, started/finished, requested by, verified at).
- Worker jobs `backup-tenant` / `restore-tenant` with the tenant id in the payload, a lifecycle lock per tenant (shared with provisioning), and verification by test-restoring into a scratch database.
- Super Admin only, with step-up and a reason. Tenant admins can request a backup export of their own tenant but never restore, and never touch another tenant.
- Decommissioning takes a final backup before `drop_database`.
