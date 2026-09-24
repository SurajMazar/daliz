/**
 * Response contracts between the API and its clients (web, PWA, desktop).
 */
import type { PlatformPermission, PlatformRoleKey, TenantPermission } from './permissions.js';
import type { ThemeInput } from './theme.js';
import type { TenantSecurityPolicy, TenantSettings } from './schemas.js';

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'MFA_ENROLLMENT_REQUIRED',
  'STEP_UP_REQUIRED',
  'FORBIDDEN',
  'TENANT_REQUIRED',
  'TENANT_UNAVAILABLE',
  'TENANT_DOMAIN_MISMATCH',
  'SUPPORT_SESSION_READ_ONLY',
  'RESOURCE_NOT_FOUND',
  'CONFLICT',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'CSRF_FAILED',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'INVALID_TOKEN',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'QUOTA_EXCEEDED',
  'MAINTENANCE_MODE',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: { path: string; message: string }[];
  };
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

// ---------------------------------------------------------------------------
// Session / identity
// ---------------------------------------------------------------------------

export type SessionStage = 'mfa_pending' | 'active';

export const TENANT_STATUSES_PUBLIC = [
  'provisioning',
  'provisioning_failed',
  'active',
  'suspended',
  'decommissioning',
  'decommissioned',
] as const;

export interface TenantMembershipSummary {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  organizationName: string;
  status: (typeof TENANT_STATUSES_PUBLIC)[number];
}

export interface SupportSessionInfo {
  tenantId: string;
  tenantName: string;
  reason: string;
  allowWrite: boolean;
  expiresAt: string;
}

export interface MeResponse {
  stage: SessionStage;
  csrfToken: string;
  account: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    mfaEnabled: boolean;
  };
  platform: null | {
    role: PlatformRoleKey;
    permissions: PlatformPermission[];
  };
  memberships: TenantMembershipSummary[];
  /** Resolved server-side from the session; never chosen by the client per request. */
  tenant: null | {
    id: string;
    name: string;
    slug: string;
    userId: string | null;
    roles: { id: string; name: string }[];
    permissions: TenantPermission[];
    settings: TenantSettings;
    security: TenantSecurityPolicy;
  };
  support: SupportSessionInfo | null;
  /** True when the tenant's policy requires MFA and this account hasn't enrolled yet. */
  mustEnrollMfa: boolean;
  stepUpUntil: string | null;
}

export interface LoginResponse {
  stage: SessionStage;
  csrfToken: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface MfaSetupResponse {
  otpauthUrl: string;
  qrCodeDataUrl: string;
  secret: string;
}

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

export const LOGO_VARIANTS = [
  'header',
  'sidebar',
  'login',
  'email',
  'mobile',
  'favicon-16',
  'favicon-32',
  'favicon-48',
  'icon-180',
  'icon-192',
  'icon-512',
] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];

export interface PublicBranding {
  tenantId: string | null;
  name: string;
  theme: ThemeInput;
  logo: null | {
    version: string;
    width: number;
    height: number;
    urls: Record<LogoVariant, string>;
  };
  loginMessage: string | null;
}

export interface TenantBranding extends PublicBranding {
  /** Id of the active logo asset, to send back unchanged in PUT /branding. */
  logoAssetId: string | null;
  version: number;
  contrast: import('./theme.js').ContrastCheck[];
}

export interface AssignableRole {
  id: string;
  key: string | null;
  name: string;
  description: string;
}

export interface LogoAnalysis {
  uploadId: string;
  width: number;
  height: number;
  format: string;
  aspectRatio: number;
  hasTransparency: boolean;
  palette: [number, number, number][];
  dominant: [number, number, number];
  suggestedTheme: ThemeInput;
  warnings: string[];
  previewUrls: Partial<Record<LogoVariant, string>>;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export type TenantStatus = TenantMembershipSummary['status'];

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  contactEmail: string;
  status: 'active' | 'suspended';
  tenantCount: number;
  createdAt: string;
}

export interface TenantRow {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
  databaseStatus: 'pending' | 'creating' | 'migrating' | 'ready' | 'failed' | 'dropped';
  schemaVersion: string | null;
  primaryAdminEmail: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

export interface ProvisioningStep {
  key: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface TenantDetail extends TenantRow {
  limits: { maxUsers: number; storageQuotaMb: number };
  locale: string;
  timezone: string;
  currency: string;
  domains: {
    id: string;
    domain: string;
    verified: boolean;
    isPrimary: boolean;
    /** DNS TXT record to create; present until the domain is verified. */
    verificationRecord: { name: string; value: string } | null;
  }[];
  admins: { accountId: string; email: string; name: string; status: string }[];
  database: { name: string; host: string; status: TenantRow['databaseStatus']; schemaVersion: string | null };
  provisioning: null | {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    attempts: number;
    steps: ProvisioningStep[];
    lastError: string | null;
    updatedAt: string;
  };
  statusReason: string | null;
  userCount: number | null;
}

export interface PlatformDashboard {
  organizations: number;
  tenants: { total: number; active: number; suspended: number; provisioning: number; failed: number };
  accounts: number;
  recentSecurityEvents: SecurityEventRow[];
  health: HealthReport;
}

export interface SecurityEventRow {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  accountId: string | null;
  email: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: { name: string; status: 'ok' | 'down'; latencyMs: number | null; detail?: string }[];
  tenantPools: { open: number; max: number };
  queues: { name: string; waiting: number; active: number; failed: number; delayed: number }[];
  version: string;
  uptimeSeconds: number;
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actorType: 'user' | 'platform_admin' | 'support' | 'system' | 'anonymous' | 'api_key';
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: 'success' | 'failure' | 'denied';
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export interface PlatformAdminRow {
  accountId: string;
  email: string;
  name: string;
  role: PlatformRoleKey;
  status: 'active' | 'disabled';
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

// ---------------------------------------------------------------------------
// Tenant administration
// ---------------------------------------------------------------------------

export interface TenantUserRow {
  id: string;
  accountId: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'disabled';
  roles: { id: string; name: string; key: string | null }[];
  mfaEnabled: boolean;
  lastActiveAt: string | null;
  createdAt: string;
  version: number;
}

export interface RoleRow {
  id: string;
  key: string | null;
  name: string;
  description: string;
  isSystem: boolean;
  immutable: boolean;
  permissions: TenantPermission[];
  userCount: number;
  version: number;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface ApiKeyCreated extends ApiKeyRow {
  /** Shown exactly once. Only a keyed hash is stored. */
  secret: string;
}
