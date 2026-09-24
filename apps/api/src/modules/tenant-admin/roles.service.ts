import { Injectable } from '@nestjs/common';
import { isTenantPermission, type RoleInput, type RoleRow, type TenantPermission } from '@daliz/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import { qcol } from '../../common/sql.js';
import { RequestContext } from '../../common/request-context.js';
import { permissions, rolePermissions, roles, userRoles } from '../../database/tenant/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { assertCanGrantPermissions } from './authorization.js';

@Injectable()
export class TenantRolesService {
  constructor(
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(): Promise<RoleRow[]> {
    const { db } = RequestContext.tenant();
    const rows = await db
      .select({
        role: roles,
        userCount: sql<number>`(select count(*)::int from ${userRoles} ur where ur.role_id = ${qcol(roles.id)})`,
      })
      .from(roles)
      .orderBy(sql`${roles.isSystem} desc`, roles.name);
    const perms = await db.select().from(rolePermissions);
    return rows.map(({ role, userCount }) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      immutable: role.immutable,
      permissions: perms.filter((p) => p.roleId === role.id).map((p) => p.permissionKey).filter(isTenantPermission),
      userCount: Number(userCount),
      version: role.version,
    }));
  }

  async catalog() {
    const { db } = RequestContext.tenant();
    return db.select().from(permissions).orderBy(permissions.group, permissions.key);
  }

  async create(input: RoleInput): Promise<{ id: string }> {
    const ctx = RequestContext.tenant();
    assertCanGrantPermissions(ctx, input.permissions);
    const id = await ctx.db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({ name: input.name, description: input.description, isSystem: false, immutable: false })
        .returning({ id: roles.id });
      if (input.permissions.length) {
        await tx.insert(rolePermissions).values(input.permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
      }
      return role!.id;
    });
    await this.audit.tenantEvent({ action: 'role.created', resourceType: 'role', resourceId: id, metadata: { name: input.name, permissions: input.permissions } });
    return { id };
  }

  async update(id: string, input: RoleInput & { version: number }): Promise<void> {
    const ctx = RequestContext.tenant();
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw Errors.notFound();
    if (role.immutable) throw Errors.forbidden('The Owner role cannot be changed.');
    if (role.isSystem && input.name !== role.name) throw Errors.badRequest('Built-in roles cannot be renamed.');

    const before = (await ctx.db.select({ key: rolePermissions.permissionKey }).from(rolePermissions).where(eq(rolePermissions.roleId, id))).map(
      (r) => r.key,
    );
    const added = input.permissions.filter((p) => !before.includes(p));
    const removed = before.filter((p) => !input.permissions.includes(p as TenantPermission));
    // Adding or removing permissions both change who can do what; the actor must hold them.
    assertCanGrantPermissions(ctx, [...added, ...removed]);

    await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(roles)
        .set({ name: input.name, description: input.description, version: role.version + 1, updatedAt: new Date() })
        .where(and(eq(roles.id, id), eq(roles.version, input.version)))
        .returning({ id: roles.id });
      if (!updated.length) throw Errors.versionConflict();
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (input.permissions.length) {
        await tx.insert(rolePermissions).values(input.permissions.map((permissionKey) => ({ roleId: id, permissionKey })));
      }
    });
    await this.tenantContext.invalidatePermissions(ctx.tenantId);
    await this.audit.tenantEvent({ action: 'role.updated', resourceType: 'role', resourceId: id, metadata: { added, removed, name: input.name } });
  }

  async remove(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw Errors.notFound();
    if (role.isSystem) throw Errors.forbidden('Built-in roles cannot be deleted.');
    const [assigned] = await ctx.db.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, id));
    if (Number(assigned?.n ?? 0) > 0) throw Errors.conflict('Remove this role from all users before deleting it.');
    await ctx.db.delete(roles).where(eq(roles.id, id));
    await this.audit.tenantEvent({ action: 'role.deleted', resourceType: 'role', resourceId: id, metadata: { name: role.name } });
  }
}
