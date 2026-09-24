/**
 * TENANT DATABASE
 *
 * Every tenant gets its own PostgreSQL database with exactly this schema. Nothing here has
 * a tenant_id column: isolation is physical. A query against this schema can only ever see
 * the one tenant whose connection pool it runs on.
 */
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The platform account this tenant user belongs to (platform.accounts.id). */
    accountId: uuid('account_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['invited', 'active', 'disabled'] })
      .notNull()
      .default('invited'),
    lastActiveAt: ts('last_active_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('users_account_uq').on(t.accountId), uniqueIndex('users_email_uq').on(t.email)],
);

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  group: text('group').notNull(),
  description: text('description').notNull(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Set for built-in roles (owner, admin, ...); null for custom roles. */
    key: text('key'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isSystem: boolean('is_system').notNull().default(false),
    immutable: boolean('immutable').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('roles_key_uq').on(t.key),
    uniqueIndex('roles_name_uq').on(sql`lower(${t.name})`),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    assignedBy: uuid('assigned_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
);

/** Keyed JSON settings: 'general', 'security', 'branding'. Values are schema-validated. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
  version: integer('version').notNull().default(1),
});

export const brandingAssets = pgTable(
  'branding_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['logo'] }).notNull(),
    status: text('status', { enum: ['uploaded', 'active', 'superseded', 'discarded'] })
      .notNull()
      .default('uploaded'),
    /** Object storage prefix; variants live at `${storagePrefix}/${variant}.png`. */
    storagePrefix: text('storage_prefix').notNull(),
    originalFormat: text('original_format').notNull(),
    originalBytes: integer('original_bytes').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    hasTransparency: boolean('has_transparency').notNull(),
    palette: jsonb('palette').$type<[number, number, number][]>().notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    activatedAt: ts('activated_at'),
  },
  (t) => [index('branding_assets_status_idx').on(t.status)],
);

/** Append-only (enforced by trigger). Tenant admins can read it; nobody can rewrite it. */
export const auditLogs = pgTable(
  'tenant_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorType: text('actor_type', {
      enum: ['user', 'platform_admin', 'support', 'system', 'anonymous', 'api_key'],
    }).notNull(),
    /** Tenant user id for 'user'; platform account id for 'support'/'platform_admin'. */
    actorId: uuid('actor_id'),
    actorEmail: text('actor_email'),
    supportSessionId: uuid('support_session_id'),
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
    index('tenant_audit_logs_occurred_idx').on(t.occurredAt),
    index('tenant_audit_logs_action_idx').on(t.action),
    index('tenant_audit_logs_actor_idx').on(t.actorId),
  ],
);

/** Stores responses for idempotent endpoints, keyed per user. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    route: text('route').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    response: jsonb('response'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] }), index('idempotency_keys_expires_idx').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Accounting (double-entry)
// ---------------------------------------------------------------------------

/** Money: numeric(20,4) in the database, decimal strings in TypeScript. Never floats. */
const money = (name: string) => numeric(name, { precision: 20, scale: 4 });

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export const ACCOUNT_SUBTYPES = ['cash', 'bank', 'receivable', 'payable', 'tax', 'retained_earnings', 'inventory', 'fixed_asset', 'other'] as const;

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    subtype: text('subtype', { enum: ACCOUNT_SUBTYPES }).notNull().default('other'),
    parentId: uuid('parent_id').references((): AnyPgColumn => ledgerAccounts.id),
    description: text('description').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    /** System accounts (e.g. retained earnings) can't be deleted or retyped. */
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('ledger_accounts_code_uq').on(t.code), index('ledger_accounts_type_idx').on(t.type)],
);

/** Gapless document numbering (row-locked counter, incremented inside the posting transaction). */
export const numberSequences = pgTable('number_sequences', {
  key: text('key').primaryKey(),
  prefix: text('prefix').notNull(),
  nextValue: integer('next_value').notNull().default(1),
});

export const JOURNAL_STATUSES = ['draft', 'pending', 'approved', 'posted', 'reversed'] as const;

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Assigned at posting time from number_sequences; null for unposted entries. */
    number: text('number'),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    description: text('description').notNull(),
    reference: text('reference'),
    source: text('source', { enum: ['manual', 'daybook', 'reversal', 'opening'] }).notNull().default('manual'),
    status: text('status', { enum: JOURNAL_STATUSES }).notNull().default('draft'),
    totalAmount: money('total_amount').notNull().default('0'),
    createdBy: uuid('created_by'),
    submittedBy: uuid('submitted_by'),
    submittedAt: ts('submitted_at'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    postedBy: uuid('posted_by'),
    postedAt: ts('posted_at'),
    reversalOfId: uuid('reversal_of_id').references((): AnyPgColumn => journalEntries.id),
    reversedById: uuid('reversed_by_id').references((): AnyPgColumn => journalEntries.id),
    reversedAt: ts('reversed_at'),
    reversalReason: text('reversal_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('journal_entries_number_uq').on(t.number),
    index('journal_entries_status_idx').on(t.status),
    index('journal_entries_date_idx').on(t.entryDate),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull().default(''),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
  },
  (t) => [
    index('journal_lines_entry_idx').on(t.entryId),
    index('journal_lines_account_idx').on(t.accountId),
    check('journal_lines_amounts_ck', sql`${t.debit} >= 0 and ${t.credit} >= 0 and ((${t.debit} = 0) <> (${t.credit} = 0))`),
  ],
);

export const daybookEntries = pgTable(
  'daybook_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    kind: text('kind', { enum: ['income', 'expense', 'transfer'] }).notNull(),
    amount: money('amount').notNull(),
    /** Cash or bank account the money moved through (the source, for transfers). */
    moneyAccountId: uuid('money_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    /** Income/expense category, or the destination money account for transfers. */
    counterAccountId: uuid('counter_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    counterparty: text('counterparty'),
    description: text('description').notNull(),
    reference: text('reference'),
    status: text('status', { enum: ['pending', 'posted', 'void'] }).notNull().default('pending'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('daybook_entries_date_idx').on(t.entryDate),
    index('daybook_entries_status_idx').on(t.status),
    check('daybook_entries_amount_ck', sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Files / library
// ---------------------------------------------------------------------------

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id),
    name: text('name').notNull(),
    /** 'workspace': everyone with files.read. 'restricted': owner, file managers and explicit shares. */
    visibility: text('visibility', { enum: ['workspace', 'restricted'] }).notNull().default('workspace'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    deletedBy: uuid('deleted_by'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('folders_parent_idx').on(t.parentId),
    uniqueIndex('folders_name_uq')
      .on(sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id').references(() => folders.id),
    /** Display name only; never used to build storage keys or paths. */
    name: text('name').notNull(),
    extension: text('extension').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    currentVersionId: uuid('current_version_id'),
    versionCount: integer('version_count').notNull().default(1),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    deletedBy: uuid('deleted_by'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('files_folder_idx').on(t.folderId),
    index('files_deleted_idx').on(t.deletedAt),
    index('files_name_idx').on(sql`lower(${t.name})`),
  ],
);

export const fileVersions = pgTable(
  'file_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    mimeType: text('mime_type').notNull(),
    originalName: text('original_name').notNull(),
    scanStatus: text('scan_status', { enum: ['pending', 'clean', 'infected', 'error'] }).notNull().default('pending'),
    scanDetail: text('scan_detail'),
    scannedAt: ts('scanned_at'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('file_versions_no_uq').on(t.fileId, t.versionNo), index('file_versions_scan_idx').on(t.scanStatus)],
);

export const fileShares = pgTable(
  'file_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'role'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    access: text('access', { enum: ['view', 'edit'] }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('file_shares_folder_idx').on(t.folderId),
    index('file_shares_file_idx').on(t.fileId),
    check('file_shares_target_ck', sql`(${t.folderId} is null) <> (${t.fileId} is null)`),
  ],
);

// ---------------------------------------------------------------------------
// Planner / workspace
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;
export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color').notNull().default('#2753d7'),
    /** 'workspace': every planner user. 'private': members only. */
    visibility: text('visibility', { enum: ['workspace', 'private'] }).notNull().default('workspace'),
    createdBy: uuid('created_by'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('workspaces_name_uq').on(sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ['planned', 'active', 'on_hold', 'completed', 'archived'] }).notNull().default('active'),
    ownerId: uuid('owner_id').references(() => users.id),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    color: text('color').notNull().default('#2753d7'),
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('projects_key_uq').on(sql`upper(${t.key})`), index('projects_workspace_idx').on(t.workspaceId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
    /** Human-friendly key, e.g. OPS-42 (project key + per-project number). */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('todo'),
    priority: text('priority', { enum: TASK_PRIORITIES }).notNull().default('none'),
    assigneeId: uuid('assignee_id').references(() => users.id),
    reporterId: uuid('reporter_id').references(() => users.id),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    estimateMinutes: integer('estimate_minutes'),
    /** Ordering within a board column; midpoints between neighbours, rebalanced when dense. */
    position: numeric('position', { precision: 30, scale: 10 }).notNull().default('1000'),
    completedAt: ts('completed_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('tasks_project_number_uq').on(t.projectId, t.number),
    index('tasks_project_status_idx').on(t.projectId, t.status, t.position),
    index('tasks_assignee_idx').on(t.assigneeId),
    index('tasks_due_idx').on(t.dueDate),
    index('tasks_parent_idx').on(t.parentTaskId),
  ],
);

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('labels_name_uq').on(sql`lower(${t.name})`)],
);

export const taskLabels = pgTable(
  'task_labels',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.labelId] })],
);

export const taskComments = pgTable(
  'task_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('task_comments_task_idx').on(t.taskId, t.createdAt)],
);

export const taskAttachments = pgTable(
  'task_attachments',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.fileId] })],
);

export const taskActivity = pgTable(
  'task_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('task_activity_task_idx').on(t.taskId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Events & reminders
// ---------------------------------------------------------------------------

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    location: text('location').notNull().default(''),
    kind: text('kind', { enum: ['event', 'meeting', 'deadline'] }).notNull().default('event'),
    status: text('status', { enum: ['confirmed', 'tentative', 'cancelled'] }).notNull().default('confirmed'),
    /** First occurrence, as UTC instants. */
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    /** IANA zone the event is scheduled in; recurrences keep wall-clock time in this zone. */
    timezone: text('timezone').notNull(),
    /** RFC 5545 RRULE subset, e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10. One row per series. */
    rrule: text('rrule'),
    /** Upper bound for queries (null = open-ended series). */
    seriesEndsAt: ts('series_ends_at'),
    visibility: text('visibility', { enum: ['workspace', 'private'] }).notNull().default('workspace'),
    organizerId: uuid('organizer_id').references(() => users.id),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('calendar_events_range_idx').on(t.startsAt, t.seriesEndsAt), index('calendar_events_organizer_idx').on(t.organizerId)],
);

export const eventAttendees = pgTable(
  'event_attendees',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    response: text('response', { enum: ['pending', 'accepted', 'declined', 'tentative'] }).notNull().default('pending'),
    respondedAt: ts('responded_at'),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] }), index('event_attendees_user_idx').on(t.userId)],
);

/** A single occurrence of a series that was cancelled or moved. */
export const eventExceptions = pgTable(
  'event_exceptions',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    occurrenceStart: ts('occurrence_start').notNull(),
    cancelled: boolean('cancelled').notNull().default(false),
    startsAt: ts('starts_at'),
    endsAt: ts('ends_at'),
    title: text('title'),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.occurrenceStart] })],
);

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => calendarEvents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    /** Next time this reminder fires. */
    remindAt: ts('remind_at').notNull(),
    /** For event reminders: how long before each occurrence to fire. */
    minutesBefore: integer('minutes_before'),
    channel: text('channel', { enum: ['in_app', 'email', 'both'] }).notNull().default('in_app'),
    status: text('status', { enum: ['scheduled', 'sent', 'dismissed', 'cancelled'] }).notNull().default('scheduled'),
    lastSentAt: ts('last_sent_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('reminders_due_idx').on(t.status, t.remindAt), index('reminders_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** In-app route, e.g. /planner/p/<id>?task=<id>. Never an external URL. */
    link: text('link'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Dedupe key so retried events don't notify twice. */
    dedupeKey: text('dedupe_key'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('notifications_dedupe_uq').on(t.userId, t.dedupeKey),
  ],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    inApp: boolean('in_app').notNull(),
    email: boolean('email').notNull(),
    push: boolean('push').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['email', 'push'] }).notNull(),
    status: text('status', { enum: ['queued', 'sent', 'failed', 'skipped'] }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notification_deliveries_status_idx').on(t.status)],
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpoint)],
);
