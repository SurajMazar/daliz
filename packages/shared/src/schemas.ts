/**
 * Request schemas shared by the API (server-side validation, the authoritative check) and
 * the web app (form validation, for fast feedback only).
 */
import { z } from 'zod';
import { PLATFORM_ROLE_KEYS, TENANT_PERMISSION_KEYS } from './permissions.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const emailSchema = z.string().trim().toLowerCase().max(254).email('Enter a valid email');

export const uuidSchema = z.string().uuid();

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'At least 3 characters')
  .max(40, 'At most 40 characters')
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'Lowercase letters, numbers and hyphens; start with a letter');

export const personNameSchema = z.string().trim().min(1, 'Required').max(120);

/** A small blocklist of passwords that satisfy length rules but are still trivially guessed. */
const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'iloveyou1234',
  'administrator',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'qwerty123456',
  'aaaaaaaaaaaa',
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'This password is too common')
  .refine((v) => new Set(v).size >= 5, 'Use a more varied password');

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

export const localeSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/, 'Use a locale such as en-US');

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Use an ISO 4217 code such as USD');

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  // Login never applies the password policy — only length bounds — so old passwords still work.
  password: z.string().min(1, 'Required').max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{5}-[a-z0-9]{5}$/, 'Recovery codes look like abcde-12345');

export const mfaChallengeSchema = z.union([
  z.object({ code: totpCodeSchema }),
  z.object({ recoveryCode: recoveryCodeSchema }),
]);
export type MfaChallengeInput = z.infer<typeof mfaChallengeSchema>;

export const mfaEnableSchema = z.object({ code: totpCodeSchema });

export const stepUpSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: totpCodeSchema.optional(),
});
export type StepUpInput = z.infer<typeof stepUpSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: personNameSchema,
  password: passwordSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: personNameSchema,
});

export const selectTenantSchema = z.object({ tenantId: uuidSchema });

// ---------------------------------------------------------------------------
// Platform (Super Admin)
// ---------------------------------------------------------------------------

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  contactEmail: emailSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = createOrganizationSchema.partial().extend({
  status: z.enum(['active', 'suspended']).optional(),
});

export const tenantLimitsSchema = z.object({
  maxUsers: z.coerce.number().int().min(1).max(100_000),
  storageQuotaMb: z.coerce.number().int().min(100).max(10_000_000),
});
export type TenantLimits = z.infer<typeof tenantLimitsSchema>;

export const PLAN_KEYS = ['starter', 'business', 'enterprise'] as const;
export const planSchema = z.enum(PLAN_KEYS);

export const createTenantSchema = z.object({
  organizationId: uuidSchema,
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  plan: planSchema,
  limits: tenantLimitsSchema,
  locale: localeSchema,
  timezone: timezoneSchema,
  currency: currencySchema,
  admin: z.object({
    email: emailSchema,
    name: personNameSchema,
  }),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  plan: planSchema.optional(),
  limits: tenantLimitsSchema.optional(),
});

export const tenantStatusChangeSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (5+ characters)').max(500),
});

export const decommissionTenantSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  /** The operator must type the tenant slug to confirm. */
  confirmSlug: slugSchema,
});

const hostnameRegex = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(hostnameRegex, 'Enter a hostname such as finance.acme.com');

export const addTenantDomainSchema = z.object({ domain: domainSchema });

export const addTenantAdminSchema = z.object({
  email: emailSchema,
  name: personNameSchema,
});

export const supportAccessSchema = z.object({
  reason: z.string().trim().min(10, 'Describe why you need access (10+ characters)').max(1000),
  durationMinutes: z.coerce.number().int().min(5).max(240),
  allowWrite: z.boolean().default(false),
});
export type SupportAccessInput = z.infer<typeof supportAccessSchema>;

export const createPlatformAdminSchema = z.object({
  email: emailSchema,
  name: personNameSchema,
  role: z.enum(PLATFORM_ROLE_KEYS),
});

export const updatePlatformAdminSchema = z.object({
  role: z.enum(PLATFORM_ROLE_KEYS).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const platformSettingsSchema = z.object({
  maintenanceMode: z.boolean(),
  maintenanceMessage: z.string().trim().max(300),
  requireMfaForPlatformAdmins: z.boolean(),
  allowTenantSelfBranding: z.boolean(),
  defaultStorageQuotaMb: z.coerce.number().int().min(100).max(10_000_000),
  defaultMaxUsers: z.coerce.number().int().min(1).max(100_000),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const featureFlagSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  description: z.string().trim().max(300),
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Tenant administration
// ---------------------------------------------------------------------------

export const permissionKeySchema = z.enum(TENANT_PERMISSION_KEYS as [string, ...string[]]);

export const inviteUserSchema = z.object({
  email: emailSchema,
  name: personNameSchema,
  roleIds: z.array(uuidSchema).min(1, 'Choose at least one role').max(20),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const updateTenantUserSchema = z.object({
  name: personNameSchema.optional(),
  roleIds: z.array(uuidSchema).min(1).max(20).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  /** Optimistic concurrency: the version the editor last saw. */
  version: z.number().int().min(1),
});

export const roleInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(''),
  permissions: z.array(permissionKeySchema).max(TENANT_PERMISSION_KEYS.length),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const updateRoleSchema = roleInputSchema.extend({
  version: z.number().int().min(1),
});

export const DATE_FORMATS = ['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy', 'dd.MM.yyyy'] as const;

export const tenantSettingsSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  locale: localeSchema,
  timezone: timezoneSchema,
  currency: currencySchema,
  dateFormat: z.enum(DATE_FORMATS),
  weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const tenantSecurityPolicySchema = z.object({
  requireMfa: z.boolean(),
  sessionIdleMinutes: z.coerce.number().int().min(5).max(24 * 60),
  sessionMaxHours: z.coerce.number().int().min(1).max(24 * 30),
  lockScreenMinutes: z.coerce.number().int().min(1).max(240),
});
export type TenantSecurityPolicy = z.infer<typeof tenantSecurityPolicySchema>;

export const auditQuerySchema = paginationQuerySchema.extend({
  action: z.string().trim().max(100).optional(),
  actorId: uuidSchema.optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
// API keys (integrations)
// ---------------------------------------------------------------------------

/** What an integration may be granted. Administration and approvals stay human-only. */
export const API_KEY_SCOPES = [
  ...TENANT_PERMISSION_KEYS.filter((k) => k.endsWith('.read')),
  'planner.create',
  'planner.update',
  'daybook.create',
  'events.create',
  'files.upload',
  'accounting.create',
] as const;

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z
    .array(z.enum(API_KEY_SCOPES as unknown as [string, ...string[]]))
    .min(1, 'Choose at least one scope')
    .max(API_KEY_SCOPES.length),
  expiresInDays: z.coerce.number().int().min(1).max(365),
});
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;
