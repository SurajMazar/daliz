import { Injectable } from '@nestjs/common';
import type { AssignableRole, InviteUserInput, Paginated, TenantPermission, TenantUserRow } from '@daliz/shared';
import { and, count, desc, eq, ilike, inArray, isNull, ne, or } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import { RequestContext } from '../../common/request-context.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import { accounts, invitations, sessions, tenantMemberships, tenants } from '../../database/platform/schema.js';
import { auditLogs, rolePermissions, roles, userRoles, users } from '../../database/tenant/schema.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { BrandingService } from '../branding/branding.service.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';
import { actorIsOwner, assertCanGrantRoles } from './authorization.js';

@Injectable()
export class TenantUsersService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    private readonly directory: TenantDirectory,
    private readonly branding: BrandingService,
    private readonly redis: RedisService,
  ) {}

  async list(q: { page: number; pageSize: number; q?: string; status?: string }): Promise<Paginated<TenantUserRow>> {
    const { db } = RequestContext.tenant();
    const where = and(
      q.q ? or(ilike(users.name, `%${q.q}%`), ilike(users.email, `%${q.q}%`)) : undefined,
      q.status ? eq(users.status, q.status as TenantUserRow['status']) : undefined,
    );
    const [total] = await db.select({ n: count() }).from(users).where(where);
    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(users.name)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items: await this.decorate(rows), meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) } };
  }

  async get(id: string): Promise<TenantUserRow> {
    const { db } = RequestContext.tenant();
    const [row] = await db.select().from(users).where(eq(users.id, id));
    if (!row) throw Errors.notFound();
    return (await this.decorate([row]))[0]!;
  }

  private async decorate(rows: (typeof users.$inferSelect)[]): Promise<TenantUserRow[]> {
    if (rows.length === 0) return [];
    const { db } = RequestContext.tenant();
    const ids = rows.map((r) => r.id);
    const roleRows = await db
      .select({ userId: userRoles.userId, id: roles.id, name: roles.name, key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, ids));
    const mfa = await this.platform.db
      .select({ id: accounts.id, mfaEnabled: accounts.mfaEnabled })
      .from(accounts)
      .where(inArray(accounts.id, rows.map((r) => r.accountId)));
    const mfaById = new Map(mfa.map((m) => [m.id, m.mfaEnabled]));
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      email: r.email,
      name: r.name,
      status: r.status,
      roles: roleRows.filter((x) => x.userId === r.id).map(({ id, name, key }) => ({ id, name, key })),
      mfaEnabled: mfaById.get(r.accountId) ?? false,
      lastActiveAt: r.lastActiveAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      version: r.version,
    }));
  }

  async invite(input: InviteUserInput): Promise<{ id: string }> {
    const ctx = RequestContext.tenant();
    const { db, tenantId } = ctx;
    const tenant = (await this.directory.get(tenantId))!;
    const [active] = await db.select({ n: count() }).from(users).where(ne(users.status, 'disabled'));
    if (Number(active?.n ?? 0) >= tenant.maxUsers) {
      throw Errors.quotaExceeded(`This workspace is limited to ${tenant.maxUsers} users. Contact your provider to raise the limit.`);
    }
    await assertCanGrantRoles(ctx, db, input.roleIds);

    const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (existingUser) throw Errors.conflict('That person is already a member of this workspace.');

    const account = await this.platform.db.transaction(async (tx) => {
      const acct = await this.accounts.findOrCreatePending(input.email, input.name, tx);
      await tx
        .insert(tenantMemberships)
        .values({ accountId: acct.id, tenantId, status: 'invited', isTenantAdmin: false })
        .onConflictDoUpdate({ target: [tenantMemberships.accountId, tenantMemberships.tenantId], set: { status: 'invited', updatedAt: new Date() } });
      return acct;
    });

    const userId = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          accountId: account.id,
          email: input.email,
          name: input.name,
          status: 'invited',
          createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        })
        .returning({ id: users.id });
      await tx.insert(userRoles).values(
        input.roleIds.map((roleId) => ({ userId: u!.id, roleId, assignedBy: ctx.actor.type === 'user' ? ctx.actor.userId : null })),
      );
      return u!.id;
    });

    await this.sendInvitation(account.id, input.email);
    await this.audit.tenantEvent({ action: 'user.invited', resourceType: 'user', resourceId: userId, metadata: { email: input.email, roleIds: input.roleIds } });
    return { id: userId };
  }

  private async sendInvitation(accountId: string, email: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const session = RequestContext.session();
    await this.accounts.createInvitation({
      accountId,
      email,
      tenantId: ctx.tenantId,
      kind: 'tenant_user',
      invitedBy: session.accountId,
      inviterName: session.name,
      workspaceName: ctx.name,
      branding: await this.branding.emailBranding(ctx.tenantId, ctx.db),
    });
  }

  async resendInvitation(id: string): Promise<void> {
    const { db } = RequestContext.tenant();
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw Errors.notFound();
    if (user.status !== 'invited') throw Errors.conflict('Only pending invitations can be resent.');
    await this.sendInvitation(user.accountId, user.email);
    await this.audit.tenantEvent({ action: 'user.invitation_resent', resourceType: 'user', resourceId: id });
  }

  async update(id: string, patch: { name?: string; roleIds?: string[]; status?: 'active' | 'disabled'; version: number }): Promise<TenantUserRow> {
    const ctx = RequestContext.tenant();
    const { db, tenantId } = ctx;
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw Errors.notFound();
    if (patch.status && !ctx.permissions.has('users.delete')) throw Errors.forbidden('Disabling or re-enabling users needs the users.delete permission.');
    const isSelf = ctx.actor.type === 'user' && ctx.actor.userId === id;
    if (isSelf && (patch.roleIds || patch.status)) throw Errors.forbidden('You can’t change your own roles or status.');
    if (patch.status === 'active' && user.status === 'invited') throw Errors.conflict('Invited users become active when they accept.');

    const currentRoles = await db
      .select({ id: roles.id, key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, id));
    const targetIsOwner = currentRoles.some((r) => r.key === 'owner');
    if (targetIsOwner && !(await actorIsOwner(ctx, db))) throw Errors.forbidden('Only an Owner can change another Owner.');
    if (patch.roleIds) await assertCanGrantRoles(ctx, db, patch.roleIds);

    const losingOwner =
      targetIsOwner &&
      (patch.status === 'disabled' ||
        (patch.roleIds && !(await db.select({ key: roles.key }).from(roles).where(inArray(roles.id, patch.roleIds))).some((r) => r.key === 'owner')));
    if (losingOwner) await this.assertAnotherActiveOwner(id);

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.status ? { status: patch.status } : {}),
          version: user.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, id), eq(users.version, patch.version)))
        .returning({ id: users.id });
      if (!updated.length) throw Errors.versionConflict();
      if (patch.roleIds) {
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await tx.insert(userRoles).values(
          patch.roleIds.map((roleId) => ({ userId: id, roleId, assignedBy: ctx.actor.type === 'user' ? ctx.actor.userId : null })),
        );
      }
    });

    if (patch.status) {
      await this.platform.db
        .update(tenantMemberships)
        .set({ status: patch.status === 'disabled' ? 'disabled' : 'active', updatedAt: new Date() })
        .where(and(eq(tenantMemberships.accountId, user.accountId), eq(tenantMemberships.tenantId, tenantId)));
      if (patch.status === 'disabled') await this.revokeTenantSessions(user.accountId, tenantId);
    }
    if (patch.roleIds || patch.status) await this.tenantContext.invalidatePermissions(tenantId, id);

    await this.audit.tenantEvent({
      action: patch.roleIds ? 'user.roles_changed' : patch.status ? `user.${patch.status === 'disabled' ? 'disabled' : 'enabled'}` : 'user.updated',
      resourceType: 'user',
      resourceId: id,
      metadata: {
        ...(patch.roleIds ? { from: currentRoles.map((r) => r.id), to: patch.roleIds } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.name ? { nameChanged: true } : {}),
      },
    });
    return this.get(id);
  }

  /** Removes a pending invitation. Active users are disabled instead, preserving history. */
  async removeInvited(id: string): Promise<void> {
    const { db, tenantId } = RequestContext.tenant();
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw Errors.notFound();
    if (user.status !== 'invited') throw Errors.conflict('Disable active users instead of deleting them.');
    await db.delete(users).where(and(eq(users.id, id), eq(users.status, 'invited')));
    await this.platform.db
      .delete(tenantMemberships)
      .where(and(eq(tenantMemberships.accountId, user.accountId), eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.status, 'invited')));
    await this.platform.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.accountId, user.accountId), eq(invitations.tenantId, tenantId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    await this.audit.tenantEvent({ action: 'user.invitation_revoked', resourceType: 'user', resourceId: id, metadata: { email: user.email } });
  }

  private async assertAnotherActiveOwner(excludingUserId: string): Promise<void> {
    const { db } = RequestContext.tenant();
    const owners = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(roles.key, 'owner'), eq(users.status, 'active'), ne(users.id, excludingUserId)));
    if (owners.length === 0) throw Errors.conflict('A workspace must keep at least one active Owner.');
  }

  private async revokeTenantSessions(accountId: string, tenantId: string): Promise<void> {
    const rows = await this.platform.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'tenant_user_disabled' })
      .where(and(eq(sessions.accountId, accountId), eq(sessions.activeTenantId, tenantId), isNull(sessions.revokedAt)))
      .returning({ tokenHash: sessions.tokenHash });
    await this.redis.del(...rows.map((r) => RedisKeys.session(r.tokenHash)));
  }

  /** Roles the caller may hand out: nothing beyond their own permissions, Owner only for Owners. */
  async assignableRoles(): Promise<AssignableRole[]> {
    const ctx = RequestContext.tenant();
    if (!ctx.permissions.has('users.create') && !ctx.permissions.has('users.update')) throw Errors.forbidden();
    const all = await ctx.db
      .select({ id: roles.id, key: roles.key, name: roles.name, description: roles.description, permission: rolePermissions.permissionKey })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .orderBy(roles.name);
    const owner = await actorIsOwner(ctx, ctx.db);
    const byRole = new Map<string, { role: AssignableRole; perms: string[] }>();
    for (const r of all) {
      const entry = byRole.get(r.id) ?? { role: { id: r.id, key: r.key, name: r.name, description: r.description }, perms: [] };
      if (r.permission) entry.perms.push(r.permission);
      byRole.set(r.id, entry);
    }
    return [...byRole.values()]
      .filter(({ role, perms }) => (role.key !== 'owner' || owner) && perms.every((p) => ctx.permissions.has(p as TenantPermission)))
      .map(({ role }) => role);
  }

  async dashboard() {
    const ctx = RequestContext.tenant();
    const { db } = ctx;
    const statusCounts = await db.select({ status: users.status, n: count() }).from(users).groupBy(users.status);
    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, Number(s.n)]));
    const [roleCount] = await db.select({ n: count() }).from(roles);
    const tenant = (await this.directory.get(ctx.tenantId))!;
    return {
      users: { active: byStatus.active ?? 0, invited: byStatus.invited ?? 0, disabled: byStatus.disabled ?? 0, limit: tenant.maxUsers },
      roles: Number(roleCount?.n ?? 0),
      storageQuotaMb: tenant.storageQuotaMb,
      plan: (await this.planOf(ctx.tenantId)) ?? 'business',
      recentActivity: ctx.permissions.has('audit.read') ? await this.recentActivity() : null,
    };
  }

  private async planOf(tenantId: string): Promise<string | null> {
    const [row] = await this.platform.db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId));
    return row?.plan ?? null;
  }

  private async recentActivity() {
    const { db } = RequestContext.tenant();
    const rows = await db.select().from(auditLogs).orderBy(desc(auditLogs.occurredAt)).limit(8);
    return rows.map((r) => ({ id: r.id, action: r.action, actorEmail: r.actorEmail, actorType: r.actorType, occurredAt: r.occurredAt.toISOString(), outcome: r.outcome }));
  }
}
