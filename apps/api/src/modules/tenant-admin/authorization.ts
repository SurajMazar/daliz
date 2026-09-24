import { TENANT_PERMISSION_KEYS, type TenantPermission } from '@daliz/shared';
import { eq, inArray } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import type { TenantContext } from '../../common/request-context.js';
import { rolePermissions, roles, userRoles } from '../../database/tenant/schema.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';

/** True when the actor holds the immutable Owner role in this tenant. */
export async function actorIsOwner(ctx: TenantContext, db: TenantDb = ctx.db): Promise<boolean> {
  if (ctx.actor.type !== 'user') return false;
  const rows = await db
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, ctx.actor.userId));
  return rows.some((r) => r.key === 'owner');
}

/**
 * Privilege-escalation guard: nobody can grant a permission they don't hold themselves,
 * and only Owners can hand out the Owner role.
 */
export async function assertCanGrantRoles(ctx: TenantContext, db: TenantDb, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return;
  const target = await db
    .select({ id: roles.id, key: roles.key, permission: rolePermissions.permissionKey })
    .from(roles)
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(inArray(roles.id, roleIds));
  const foundIds = new Set(target.map((t) => t.id));
  if (roleIds.some((id) => !foundIds.has(id))) throw Errors.badRequest('One or more roles do not exist.');
  if (target.some((t) => t.key === 'owner') && !(await actorIsOwner(ctx, db))) {
    throw Errors.forbidden('Only an Owner can assign the Owner role.');
  }
  assertCanGrantPermissions(ctx, target.map((t) => t.permission).filter((p): p is string => !!p));
}

export function assertCanGrantPermissions(ctx: TenantContext, permissions: string[]): void {
  const missing = [...new Set(permissions)].filter((p) => !ctx.permissions.has(p as TenantPermission));
  if (missing.length) {
    throw Errors.forbidden(`You can't grant permissions you don't have: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  }
}

export function allPermissions(): readonly TenantPermission[] {
  return TENANT_PERMISSION_KEYS;
}
