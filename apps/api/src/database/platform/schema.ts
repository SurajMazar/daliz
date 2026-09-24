/**
 * CENTRAL PLATFORM DATABASE
 *
 * Holds identities, organizations, tenant metadata, provisioning state, platform RBAC,
 * sessions and platform-level audit/security events. It never holds tenant business data;
 * that lives in each tenant's own database (see ../tenant/schema.ts).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored lower-cased. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** Null until the account holder accepts an invitation and sets a password. */
    passwordHash: text('password_hash'),
    status: text('status', { enum: ['pending', 'active', 'disabled'] })
      .notNull()
      .default('pending'),
    emailVerifiedAt: ts('email_verified_at'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** AES-256-GCM ciphertext (see EncryptionService). Never stored in plaintext. */
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaPendingSecretEnc: text('mfa_pending_secret_enc'),
    mfaEnabledAt: ts('mfa_enabled_at'),
    /** Last accepted TOTP time-step, to reject replay of a code within its window. */
    mfaLastUsedStep: integer('mfa_last_used_step'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    passwordChangedAt: ts('password_changed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('accounts_email_uq').on(t.email)],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('recovery_codes_account_idx').on(t.accountId)],
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify_email', 'reset_password'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('email_tokens_hash_uq').on(t.tokenHash), index('email_tokens_account_idx').on(t.accountId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** HMAC-SHA256 of the opaque cookie token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    stage: text('stage', { enum: ['mfa_pending', 'active'] }).notNull(),
    activeTenantId: uuid('active_tenant_id'),
    supportSessionId: uuid('support_session_id'),
    mfaVerifiedAt: ts('mfa_verified_at'),
    stepUpUntil: ts('step_up_until'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    clientPlatform: text('client_platform'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    idleExpiresAt: ts('idle_expires_at').notNull(),
    absoluteExpiresAt: ts('absolute_expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_account_idx').on(t.accountId),
  ],
);

export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull(),
    accountId: uuid('account_id'),
    email: text('email'),
    tenantId: uuid('tenant_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('security_events_created_idx').on(t.createdAt),
    index('security_events_account_idx').on(t.accountId),
  ],
);

// ---------------------------------------------------------------------------
// Platform RBAC
// ---------------------------------------------------------------------------

export const platformPermissions = pgTable('platform_permissions', {
  key: text('key').primaryKey(),
  group: text('group').notNull(),
  description: text('description').notNull(),
});

export const platformRoles = pgTable('platform_roles', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
});

export const platformRolePermissions = pgTable(
  'platform_role_permissions',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => platformRoles.key, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => platformPermissions.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

export const platformAdmins = pgTable('platform_admins', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  roleKey: text('role_key')
    .notNull()
    .references(() => platformRoles.key),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Organizations & tenants
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    contactEmail: text('contact_email').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('organizations_slug_uq').on(t.slug)],
);

export const TENANT_STATUSES = [
  'provisioning',
  'provisioning_failed',
  'active',
  'suspended',
  'decommissioning',
  'decommissioned',
] as const;

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('provisioning'),
    statusReason: text('status_reason'),
    plan: text('plan').notNull().default('business'),
    maxUsers: integer('max_users').notNull(),
    storageQuotaMb: integer('storage_quota_mb').notNull(),
    locale: text('locale').notNull(),
    timezone: text('timezone').notNull(),
    currency: text('currency').notNull(),
    primaryAdminAccountId: uuid('primary_admin_account_id').references(() => accounts.id),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    suspendedAt: ts('suspended_at'),
    decommissionedAt: ts('decommissioned_at'),
    lastActivityAt: ts('last_activity_at'),
  },
  (t) => [
    uniqueIndex('tenants_slug_uq').on(t.slug),
    index('tenants_org_idx').on(t.organizationId),
    index('tenants_status_idx').on(t.status),
  ],
);

export const tenantDatabases = pgTable(
  'tenant_databases',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    dbName: text('db_name').notNull(),
    dbHost: text('db_host').notNull(),
    dbPort: integer('db_port').notNull(),
    dbUser: text('db_user').notNull(),
    /** Encrypted with EncryptionService; decrypted only inside the connection manager. */
    dbPasswordEnc: text('db_password_enc').notNull(),
    status: text('status', {
      enum: ['pending', 'creating', 'migrating', 'ready', 'failed', 'dropped'],
    })
      .notNull()
      .default('pending'),
    schemaVersion: text('schema_version'),
    migratedAt: ts('migrated_at'),
    lastMigrationError: text('last_migration_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tenant_databases_name_uq').on(t.dbName)],
);

export const tenantDomains = pgTable(
  'tenant_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    domain: text('domain').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    verificationToken: text('verification_token').notNull(),
    verifiedAt: ts('verified_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tenant_domains_domain_uq').on(t.domain), index('tenant_domains_tenant_idx').on(t.tenantId)],
);

/**
 * Which accounts may enter which tenant. The tenant database's `users` table is the
 * authority for roles and permissions inside the tenant; this table only gates entry and
 * lets an account pick between tenants.
 */
export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status', { enum: ['invited', 'active', 'disabled'] }).notNull(),
    isTenantAdmin: boolean('is_tenant_admin').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.tenantId] }), index('tenant_memberships_tenant_idx').on(t.tenantId)],
);

export interface ProvisioningStepState {
  key: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export const tenantProvisioningJobs = pgTable(
  'tenant_provisioning_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: ['provision', 'decommission', 'migrate'] })
      .notNull()
      .default('provision'),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    steps: jsonb('steps').$type<ProvisioningStepState[]>().notNull().default([]),
    /** Admin details carried to the "create tenant admin" step. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    lastError: text('last_error'),
    requestedBy: uuid('requested_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tenant_provisioning_jobs_tenant_idx').on(t.tenantId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    kind: text('kind', { enum: ['tenant_user', 'tenant_admin', 'platform_admin'] }).notNull(),
    invitedBy: uuid('invited_by'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invitations_token_hash_uq').on(t.tokenHash), index('invitations_account_idx').on(t.accountId)],
);

export const supportSessions = pgTable(
  'support_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    reason: text('reason').notNull(),
    allowWrite: boolean('allow_write').notNull().default(false),
    startedAt: ts('started_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    endedAt: ts('ended_at'),
    endedReason: text('ended_reason'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (t) => [index('support_sessions_tenant_idx').on(t.tenantId), index('support_sessions_account_idx').on(t.accountId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    /** Public, non-secret prefix shown in the UI and used for lookup. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid('created_by').notNull(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_prefix_uq').on(t.prefix), index('api_keys_tenant_idx').on(t.tenantId)],
);

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  description: text('description').notNull().default(''),
  enabled: boolean('enabled').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenantFeatureFlags = pgTable(
  'tenant_feature_flags',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    flagKey: text('flag_key')
      .notNull()
      .references(() => featureFlags.key, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.flagKey] })],
);

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

/**
 * Append-only. A trigger (see migrations) rejects UPDATE and DELETE so application code
 * cannot rewrite history even if it tries.
 */
export const platformAuditLogs = pgTable(
  'platform_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorType: text('actor_type', {
      enum: ['user', 'platform_admin', 'support', 'system', 'anonymous', 'api_key'],
    }).notNull(),
    actorId: uuid('actor_id'),
    actorEmail: text('actor_email'),
    tenantId: uuid('tenant_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    outcome: text('outcome', { enum: ['success', 'failure', 'denied'] }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('platform_audit_logs_occurred_idx').on(t.occurredAt),
    index('platform_audit_logs_tenant_idx').on(t.tenantId),
    index('platform_audit_logs_action_idx').on(t.action),
  ],
);
