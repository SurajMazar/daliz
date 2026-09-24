/**
 * Permission catalog. This is the single source of truth for every permission key the
 * backend enforces. Tenant databases are seeded from TENANT_PERMISSIONS; the platform
 * database is seeded from PLATFORM_PERMISSIONS.
 */

export interface PermissionDefinition {
  key: string;
  group: string;
  description: string;
}

const tenant = (group: string, entries: Record<string, string>): PermissionDefinition[] =>
  Object.entries(entries).map(([action, description]) => ({
    key: `${group}.${action}`,
    group,
    description,
  }));

export const TENANT_PERMISSIONS = [
  ...tenant('users', {
    read: 'View users in this workspace',
    create: 'Invite and create users',
    update: 'Edit user profiles and role assignments',
    delete: 'Disable, re-enable and remove users',
  }),
  ...tenant('roles', {
    read: 'View roles and their permissions',
    create: 'Create custom roles',
    update: 'Edit roles and their permissions',
    delete: 'Delete custom roles',
  }),
  ...tenant('finance', {
    read: 'View finance records',
    create: 'Create finance records',
    update: 'Edit draft finance records',
    delete: 'Delete draft finance records',
    approve: 'Approve and post finance records',
  }),
  ...tenant('accounting', {
    read: 'View chart of accounts, journals and reports',
    create: 'Create journal entries and accounts',
    update: 'Edit draft journal entries and accounts',
    delete: 'Delete draft journal entries',
    approve: 'Approve, post and reverse journal entries',
  }),
  ...tenant('daybook', {
    read: 'View the daybook',
    create: 'Record daybook entries',
    update: 'Edit draft daybook entries',
    delete: 'Delete draft daybook entries',
  }),
  ...tenant('files', {
    read: 'View and download files',
    upload: 'Upload files and create folders',
    update: 'Rename, move and version files',
    delete: 'Delete and restore files',
    share: 'Share files and manage file permissions',
  }),
  ...tenant('planner', {
    read: 'View workspaces, projects and tasks',
    create: 'Create projects and tasks',
    update: 'Edit projects and tasks',
    delete: 'Delete projects and tasks',
  }),
  ...tenant('events', {
    read: 'View events and reminders',
    create: 'Create events and reminders',
    update: 'Edit events and reminders',
    delete: 'Delete events and reminders',
  }),
  ...tenant('branding', {
    read: 'View branding settings',
    update: 'Change logo, colors and theme',
  }),
  ...tenant('settings', {
    read: 'View workspace settings',
    update: 'Change workspace settings',
  }),
  ...tenant('security', {
    read: 'View workspace security policy',
    update: 'Change workspace security policy',
  }),
  ...tenant('audit', {
    read: 'View the audit log',
  }),
  ...tenant('exports', {
    create: 'Export workspace data',
  }),
] as const satisfies readonly PermissionDefinition[];

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number]['key'];

export const TENANT_PERMISSION_KEYS: readonly TenantPermission[] = TENANT_PERMISSIONS.map(
  (p) => p.key,
);

export const TENANT_PERMISSION_GROUPS: readonly string[] = [
  ...new Set(TENANT_PERMISSIONS.map((p) => p.group)),
];

export function isTenantPermission(value: string): value is TenantPermission {
  return (TENANT_PERMISSION_KEYS as readonly string[]).includes(value);
}

const all = (...groups: string[]): TenantPermission[] =>
  TENANT_PERMISSION_KEYS.filter((k) => groups.includes(k.split('.')[0]!));
const pick = (...keys: TenantPermission[]): TenantPermission[] => keys;

export const SYSTEM_ROLE_KEYS = [
  'owner',
  'admin',
  'accountant',
  'manager',
  'employee',
  'viewer',
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: readonly TenantPermission[];
  /** Owner's permission set can never be edited and always equals the full catalog. */
  immutable: boolean;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control of the workspace, including ownership and security policy.',
    permissions: TENANT_PERMISSION_KEYS,
    immutable: true,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Manages users, roles, branding and settings.',
    permissions: TENANT_PERMISSION_KEYS,
    immutable: false,
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Works in finance, daybook and accounting, including approvals.',
    permissions: [
      ...all('finance', 'accounting', 'daybook'),
      ...pick('files.read', 'files.upload', 'planner.read', 'events.read', 'events.create'),
    ],
    immutable: false,
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs projects and events and reviews finance.',
    permissions: [
      ...all('planner', 'events'),
      ...pick(
        'users.read',
        'finance.read',
        'accounting.read',
        'daybook.read',
        'files.read',
        'files.upload',
        'files.update',
        'files.share',
      ),
    ],
    immutable: false,
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Everyday work: tasks, events, files and daybook entries.',
    permissions: pick(
      'planner.read',
      'planner.create',
      'planner.update',
      'events.read',
      'events.create',
      'events.update',
      'files.read',
      'files.upload',
      'daybook.read',
      'daybook.create',
    ),
    immutable: false,
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to business modules.',
    // Business modules and the people directory only; no administration areas.
    permissions: TENANT_PERMISSION_KEYS.filter(
      (k) => k.endsWith('.read') && !['audit.', 'security.', 'roles.', 'branding.', 'settings.'].some((p) => k.startsWith(p)),
    ),
    immutable: false,
  },
];

/** Permissions a support/impersonation session receives unless write access is granted. */
export const SUPPORT_READ_ONLY_PERMISSIONS: readonly TenantPermission[] =
  TENANT_PERMISSION_KEYS.filter((k) => k.endsWith('.read'));

// ---------------------------------------------------------------------------
// Platform permissions (Super Admin console)
// ---------------------------------------------------------------------------

export const PLATFORM_PERMISSIONS = [
  { key: 'platform.dashboard.read', group: 'dashboard', description: 'View platform dashboard' },
  { key: 'platform.organizations.read', group: 'organizations', description: 'View organizations' },
  {
    key: 'platform.organizations.manage',
    group: 'organizations',
    description: 'Create and edit organizations',
  },
  { key: 'platform.tenants.read', group: 'tenants', description: 'View tenants' },
  { key: 'platform.tenants.create', group: 'tenants', description: 'Create and provision tenants' },
  {
    key: 'platform.tenants.update',
    group: 'tenants',
    description: 'Edit tenants, limits, domains and admins',
  },
  {
    key: 'platform.tenants.suspend',
    group: 'tenants',
    description: 'Suspend and reactivate tenants',
  },
  {
    key: 'platform.tenants.decommission',
    group: 'tenants',
    description: 'Decommission and delete tenants',
  },
  {
    key: 'platform.tenants.migrate',
    group: 'tenants',
    description: 'Run tenant database migrations',
  },
  {
    key: 'platform.support_access',
    group: 'support',
    description: 'Open audited support sessions inside a tenant',
  },
  { key: 'platform.audit.read', group: 'audit', description: 'View platform audit and security events' },
  { key: 'platform.admins.manage', group: 'admins', description: 'Manage platform administrators' },
  { key: 'platform.settings.manage', group: 'settings', description: 'Change platform settings' },
  { key: 'platform.health.read', group: 'health', description: 'View system health' },
] as const satisfies readonly PermissionDefinition[];

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number]['key'];
export const PLATFORM_PERMISSION_KEYS: readonly PlatformPermission[] = PLATFORM_PERMISSIONS.map(
  (p) => p.key,
);

export const PLATFORM_ROLE_KEYS = ['super_admin', 'operator', 'support', 'auditor'] as const;
export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];

export const PLATFORM_ROLES: readonly {
  key: PlatformRoleKey;
  name: string;
  description: string;
  permissions: readonly PlatformPermission[];
}[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Full control of the platform.',
    permissions: PLATFORM_PERMISSION_KEYS,
  },
  {
    key: 'operator',
    name: 'Operator',
    description: 'Provisions and operates tenants. Cannot manage platform admins.',
    permissions: PLATFORM_PERMISSION_KEYS.filter(
      (k) => k !== 'platform.admins.manage' && k !== 'platform.tenants.decommission',
    ),
  },
  {
    key: 'support',
    name: 'Support',
    description: 'Views tenants and opens audited support sessions.',
    permissions: [
      'platform.dashboard.read',
      'platform.organizations.read',
      'platform.tenants.read',
      'platform.support_access',
      'platform.health.read',
    ],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to platform data and audit logs.',
    permissions: PLATFORM_PERMISSION_KEYS.filter(
      (k) => k.endsWith('.read'),
    ),
  },
];
