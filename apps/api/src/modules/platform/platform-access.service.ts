import { Injectable } from '@nestjs/common';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  platformSettingsSchema,
  type PlatformPermission,
  type PlatformRoleKey,
  type PlatformSettings,
} from '@daliz/shared';
import { and, eq, notInArray } from 'drizzle-orm';
import type { PlatformPrincipal } from '../../common/request-context.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import {
  platformAdmins,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
  platformSettings,
} from '../../database/platform/schema.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  maintenanceMode: false,
  maintenanceMessage: 'Daliz is undergoing scheduled maintenance. Please try again shortly.',
  requireMfaForPlatformAdmins: true,
  allowTenantSelfBranding: true,
  defaultStorageQuotaMb: 10_240,
  defaultMaxUsers: 50,
};

@Injectable()
export class PlatformAccessService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly redis: RedisService,
  ) {}

  /** Platform role + permissions for an account, or null if it isn't an active platform admin. */
  async principal(accountId: string): Promise<PlatformPrincipal | null> {
    const key = RedisKeys.platformKey('admin', accountId);
    const cached = await this.redis.getJson<{ role: PlatformRoleKey; permissions: PlatformPermission[] } | { none: true }>(key);
    if (cached) {
      return 'none' in cached ? null : { role: cached.role, permissions: new Set(cached.permissions) };
    }
    const rows = await this.platform.db
      .select({ role: platformAdmins.roleKey, permission: platformRolePermissions.permissionKey })
      .from(platformAdmins)
      .leftJoin(platformRolePermissions, eq(platformRolePermissions.roleKey, platformAdmins.roleKey))
      .where(and(eq(platformAdmins.accountId, accountId), eq(platformAdmins.status, 'active')));
    if (rows.length === 0) {
      await this.redis.setJson(key, { none: true }, 60);
      return null;
    }
    const role = rows[0]!.role as PlatformRoleKey;
    const permissions = rows.map((r) => r.permission).filter((p): p is PlatformPermission => !!p);
    await this.redis.setJson(key, { role, permissions }, 60);
    return { role, permissions: new Set(permissions) };
  }

  async invalidate(accountId: string): Promise<void> {
    await this.redis.del(RedisKeys.platformKey('admin', accountId));
  }

  async settings(): Promise<PlatformSettings> {
    const key = RedisKeys.platformKey('settings');
    const cached = await this.redis.getJson<PlatformSettings>(key);
    if (cached) return cached;
    const [row] = await this.platform.db.select().from(platformSettings).where(eq(platformSettings.key, 'global'));
    const parsed = platformSettingsSchema.safeParse({ ...DEFAULT_PLATFORM_SETTINGS, ...(row?.value ?? {}) });
    const value = parsed.success ? parsed.data : DEFAULT_PLATFORM_SETTINGS;
    await this.redis.setJson(key, value, 30);
    return value;
  }

  async updateSettings(value: PlatformSettings, updatedBy: string): Promise<void> {
    await this.platform.db
      .insert(platformSettings)
      .values({ key: 'global', value, updatedBy })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy, updatedAt: new Date() } });
    await this.redis.del(RedisKeys.platformKey('settings'));
  }

  /** Syncs the platform RBAC catalog from code into the platform database. */
  async syncCatalog(): Promise<void> {
    await this.platform.db.transaction(async (tx) => {
      for (const p of PLATFORM_PERMISSIONS) {
        await tx
          .insert(platformPermissions)
          .values({ key: p.key, group: p.group, description: p.description })
          .onConflictDoUpdate({ target: platformPermissions.key, set: { group: p.group, description: p.description } });
      }
      for (const r of PLATFORM_ROLES) {
        await tx
          .insert(platformRoles)
          .values({ key: r.key, name: r.name, description: r.description })
          .onConflictDoUpdate({ target: platformRoles.key, set: { name: r.name, description: r.description } });
        await tx.delete(platformRolePermissions).where(eq(platformRolePermissions.roleKey, r.key));
        await tx.insert(platformRolePermissions).values(r.permissions.map((permissionKey) => ({ roleKey: r.key, permissionKey })));
      }
      await tx.delete(platformPermissions).where(
        notInArray(
          platformPermissions.key,
          PLATFORM_PERMISSIONS.map((p) => p.key),
        ),
      );
    });
    await this.redis.delPattern(RedisKeys.platformKey('admin', '*'));
  }
}
