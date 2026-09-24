import {
  DEFAULT_THEME,
  SYSTEM_ROLES,
  TENANT_PERMISSIONS,
  TENANT_PERMISSION_KEYS,
  type TenantSecurityPolicy,
  type TenantSettings,
  type ThemeInput,
} from '@daliz/shared';
import type { AccountingSettings } from '@daliz/shared';
import { and, count, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { ledgerAccounts, numberSequences, permissions, rolePermissions, roles, settings } from './schema.js';
import type { TenantDb } from './tenant-db.js';

export interface BrandingSettings {
  theme: ThemeInput;
  activeLogoId: string | null;
  loginMessage: string | null;
  /** Bumped whenever branding changes, used for cache busting. */
  revision: number;
}

export const DEFAULT_SECURITY_POLICY: TenantSecurityPolicy = {
  requireMfa: false,
  sessionIdleMinutes: 120,
  sessionMaxHours: 168,
  lockScreenMinutes: 15,
};

export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  lockDate: null,
  requireApproval: true,
  segregationOfDuties: false,
};

type SeedAccount = Pick<typeof ledgerAccounts.$inferInsert, 'code' | 'name' | 'type' | 'subtype' | 'isSystem'>;

/** A conventional small-business chart of accounts; tenants extend or rename it. */
export const DEFAULT_CHART_OF_ACCOUNTS: SeedAccount[] = [
  { code: '1000', name: 'Cash on hand', type: 'asset', subtype: 'cash' },
  { code: '1010', name: 'Operating bank account', type: 'asset', subtype: 'bank' },
  { code: '1020', name: 'Savings account', type: 'asset', subtype: 'bank' },
  { code: '1100', name: 'Accounts receivable', type: 'asset', subtype: 'receivable', isSystem: true },
  { code: '1200', name: 'Inventory', type: 'asset', subtype: 'inventory' },
  { code: '1300', name: 'Prepaid expenses', type: 'asset', subtype: 'other' },
  { code: '1500', name: 'Equipment', type: 'asset', subtype: 'fixed_asset' },
  { code: '2000', name: 'Accounts payable', type: 'liability', subtype: 'payable', isSystem: true },
  { code: '2100', name: 'Sales tax payable', type: 'liability', subtype: 'tax' },
  { code: '2200', name: 'Accrued liabilities', type: 'liability', subtype: 'other' },
  { code: '2500', name: 'Loans payable', type: 'liability', subtype: 'other' },
  { code: '3000', name: "Owner's equity", type: 'equity', subtype: 'other' },
  { code: '3100', name: 'Retained earnings', type: 'equity', subtype: 'retained_earnings', isSystem: true },
  { code: '4000', name: 'Sales revenue', type: 'income', subtype: 'other' },
  { code: '4100', name: 'Service revenue', type: 'income', subtype: 'other' },
  { code: '4900', name: 'Other income', type: 'income', subtype: 'other' },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', subtype: 'other' },
  { code: '6000', name: 'Salaries and wages', type: 'expense', subtype: 'other' },
  { code: '6100', name: 'Rent', type: 'expense', subtype: 'other' },
  { code: '6200', name: 'Utilities', type: 'expense', subtype: 'other' },
  { code: '6300', name: 'Office supplies', type: 'expense', subtype: 'other' },
  { code: '6400', name: 'Software and subscriptions', type: 'expense', subtype: 'other' },
  { code: '6500', name: 'Travel', type: 'expense', subtype: 'other' },
  { code: '6600', name: 'Bank fees', type: 'expense', subtype: 'other' },
  { code: '6700', name: 'Professional services', type: 'expense', subtype: 'other' },
  { code: '6900', name: 'Other expenses', type: 'expense', subtype: 'other' },
];

export const DEFAULT_BRANDING: BrandingSettings = {
  theme: DEFAULT_THEME,
  activeLogoId: null,
  loginMessage: null,
  revision: 1,
};

/**
 * Brings a tenant database's reference data up to date with the current code. Safe to run
 * repeatedly: provisioning runs it once, and every tenant migration runs it again so newly
 * added permissions appear in existing tenants.
 */
export async function syncTenantReferenceData(db: TenantDb, general?: TenantSettings): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Permission catalog.
    for (const p of TENANT_PERMISSIONS) {
      await tx
        .insert(permissions)
        .values({ key: p.key, group: p.group, description: p.description })
        .onConflictDoUpdate({
          target: permissions.key,
          set: { group: p.group, description: p.description },
        });
    }
    await tx.delete(permissions).where(notInArray(permissions.key, [...TENANT_PERMISSION_KEYS]));

    // 2. System roles. Only created if missing; tenants may customise them afterwards,
    //    except the immutable Owner role, which always has every permission.
    for (const def of SYSTEM_ROLES) {
      const [existing] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, def.key));
      let roleId = existing?.id;
      if (!roleId) {
        const [created] = await tx
          .insert(roles)
          .values({
            key: def.key,
            name: def.name,
            description: def.description,
            isSystem: true,
            immutable: def.immutable,
          })
          .returning({ id: roles.id });
        roleId = created!.id;
        await tx
          .insert(rolePermissions)
          .values(def.permissions.map((permissionKey) => ({ roleId: roleId!, permissionKey })));
      } else if (def.immutable) {
        const have = await tx
          .select({ key: rolePermissions.permissionKey })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, roleId));
        const missing = def.permissions.filter((k) => !have.some((h) => h.key === k));
        if (missing.length) {
          await tx.insert(rolePermissions).values(missing.map((permissionKey) => ({ roleId: roleId!, permissionKey })));
        }
        await tx
          .delete(rolePermissions)
          .where(and(eq(rolePermissions.roleId, roleId), notInArray(rolePermissions.permissionKey, [...def.permissions])));
      }
    }

    // 3. Default settings (never overwrite existing values).
    const defaults: { key: string; value: Record<string, unknown> }[] = [
      { key: 'security', value: { ...DEFAULT_SECURITY_POLICY } },
      { key: 'branding', value: { ...DEFAULT_BRANDING } },
      { key: 'accounting', value: { ...DEFAULT_ACCOUNTING_SETTINGS } },
    ];
    if (general) defaults.push({ key: 'general', value: { ...general } });
    for (const d of defaults) {
      await tx.insert(settings).values(d).onConflictDoNothing({ target: settings.key });
    }

    // 4. Accounting: default chart of accounts for new tenants, and document number sequences.
    const [existing] = await tx.select({ n: count() }).from(ledgerAccounts);
    if (Number(existing?.n ?? 0) === 0) {
      await tx.insert(ledgerAccounts).values(DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({ ...a, isSystem: a.isSystem ?? false })));
    }
    await tx
      .insert(numberSequences)
      .values([{ key: 'journal_entry', prefix: 'JE-' }])
      .onConflictDoNothing({ target: numberSequences.key });
  });
}

export async function getRoleIdsByKey(db: TenantDb, keys: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(inArray(roles.key, keys));
  return new Map(rows.map((r) => [r.key!, r.id]));
}

export async function countRows(db: TenantDb, table: 'users'): Promise<number> {
  const result = await db.execute<{ count: string }>(sql.raw(`select count(*)::text as count from ${table}`));
  return Number(result.rows[0]?.count ?? 0);
}
