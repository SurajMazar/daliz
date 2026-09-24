import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import type { TenantContext } from '../../common/request-context.js';
import { projects, workspaceMembers, workspaces } from '../../database/tenant/schema.js';

export type PlannerAccess = 'none' | 'view' | 'edit';

/**
 * Workspace-level access. Open workspaces are visible to every planner user; private ones
 * only to their members. Editing also needs the matching planner.* permission (route level).
 */
@Injectable()
export class PlannerAccessService {
  async workspaceAccess(ctx: TenantContext, workspaceId: string): Promise<{ access: PlannerAccess; role: 'owner' | 'editor' | 'viewer' | null; workspace: typeof workspaces.$inferSelect }> {
    const [ws] = await ctx.db.select().from(workspaces).where(and(eq(workspaces.id, workspaceId), isNull(workspaces.archivedAt)));
    if (!ws) throw Errors.notFound();
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const [member] = userId
      ? await ctx.db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      : [];
    const role = member?.role ?? null;
    if (ws.visibility === 'private') {
      // Support sessions may look but never gain membership-based write access.
      if (!role) return { access: ctx.actor.type === 'support' ? 'view' : 'none', role, workspace: ws };
      return { access: role === 'viewer' ? 'view' : 'edit', role, workspace: ws };
    }
    return { access: role === 'viewer' ? 'view' : 'edit', role, workspace: ws };
  }

  async require(ctx: TenantContext, workspaceId: string, needed: 'view' | 'edit') {
    const result = await this.workspaceAccess(ctx, workspaceId);
    if (result.access === 'none') throw Errors.notFound();
    if (needed === 'edit' && result.access !== 'edit') throw Errors.forbidden('You have view-only access to this workspace.');
    return result;
  }

  async requireProject(ctx: TenantContext, projectId: string, needed: 'view' | 'edit') {
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw Errors.notFound();
    const ws = await this.require(ctx, project.workspaceId, needed);
    return { project, ...ws };
  }

  /** Workspace ids the caller can see (open ones plus private ones they belong to). */
  async visibleWorkspaceIds(ctx: TenantContext): Promise<string[]> {
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const rows = await ctx.db
      .select({ id: workspaces.id, visibility: workspaces.visibility, member: workspaceMembers.userId })
      .from(workspaces)
      .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), userId ? eq(workspaceMembers.userId, userId) : isNull(workspaceMembers.userId)))
      .where(isNull(workspaces.archivedAt));
    return rows.filter((r) => r.visibility === 'workspace' || r.member || ctx.actor.type === 'support').map((r) => r.id);
  }
}
