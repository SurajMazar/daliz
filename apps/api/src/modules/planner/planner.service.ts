import { Injectable } from '@nestjs/common';
import { TASK_STATUSES, type LabelRow, type ProjectRow, type TaskStatus, type WorkspaceRow } from '@daliz/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import { qcol } from '../../common/sql.js';
import { RequestContext, type TenantContext } from '../../common/request-context.js';
import { labels, projects, tasks, users, workspaceMembers, workspaces } from '../../database/tenant/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { PlannerAccessService } from './planner-access.js';

const uid = (ctx: TenantContext) => (ctx.actor.type === 'user' ? ctx.actor.userId : null);

@Injectable()
export class PlannerService {
  constructor(
    private readonly access: PlannerAccessService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  async listWorkspaces(): Promise<WorkspaceRow[]> {
    const ctx = RequestContext.tenant();
    const visible = await this.access.visibleWorkspaceIds(ctx);
    if (!visible.length) return [];
    const rows = await ctx.db
      .select({
        ws: workspaces,
        projectCount: sql<number>`(select count(*)::int from ${projects} p where p.workspace_id = ${qcol(workspaces.id)} and p.status <> 'archived')`,
        openTaskCount: sql<number>`(select count(*)::int from ${tasks} t join ${projects} p on p.id = t.project_id where p.workspace_id = ${qcol(workspaces.id)} and t.deleted_at is null and t.status not in ('done','cancelled'))`,
      })
      .from(workspaces)
      .where(inArray(workspaces.id, visible))
      .orderBy(asc(sql`lower(${workspaces.name})`));
    const userId = uid(ctx);
    const roles = userId
      ? new Map((await ctx.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId))).map((m) => [m.workspaceId, m.role]))
      : new Map<string, 'owner' | 'editor' | 'viewer'>();
    return rows.map(({ ws, projectCount, openTaskCount }) => {
      const role = roles.get(ws.id) ?? null;
      return {
        id: ws.id,
        name: ws.name,
        description: ws.description,
        color: ws.color,
        visibility: ws.visibility,
        myRole: role,
        canEdit: role !== 'viewer' && (ws.visibility === 'workspace' || !!role),
        projectCount: Number(projectCount),
        openTaskCount: Number(openTaskCount),
        createdAt: ws.createdAt.toISOString(),
        version: ws.version,
      };
    });
  }

  async createWorkspace(input: { name: string; description: string; color: string; visibility: 'workspace' | 'private' }): Promise<{ id: string }> {
    const ctx = RequestContext.tenant();
    const userId = uid(ctx);
    const id = await ctx.db.transaction(async (tx) => {
      const [ws] = await tx.insert(workspaces).values({ ...input, createdBy: userId }).onConflictDoNothing().returning({ id: workspaces.id });
      if (!ws) throw Errors.conflict(`A workspace named “${input.name}” already exists.`);
      if (userId) await tx.insert(workspaceMembers).values({ workspaceId: ws.id, userId, role: 'owner' });
      return ws.id;
    });
    await this.audit.tenantEvent({ action: 'planner.workspace_created', resourceType: 'workspace', resourceId: id, metadata: { name: input.name, visibility: input.visibility } });
    return { id };
  }

  private async assertCanManage(ctx: TenantContext, workspaceId: string) {
    const { role, workspace } = await this.access.require(ctx, workspaceId, 'view');
    if (role !== 'owner' && !ctx.permissions.has('planner.delete')) throw Errors.forbidden('Only workspace owners can change workspace settings.');
    return workspace;
  }

  async updateWorkspace(id: string, patch: { name?: string; description?: string; color?: string; visibility?: 'workspace' | 'private'; version: number }): Promise<void> {
    const ctx = RequestContext.tenant();
    const ws = await this.assertCanManage(ctx, id);
    const { version, ...fields } = patch;
    const updated = await ctx.db
      .update(workspaces)
      .set({ ...fields, version: ws.version + 1, updatedAt: new Date() })
      .where(and(eq(workspaces.id, id), eq(workspaces.version, version)))
      .returning({ id: workspaces.id });
    if (!updated.length) throw Errors.versionConflict();
    await this.audit.tenantEvent({ action: 'planner.workspace_updated', resourceType: 'workspace', resourceId: id, metadata: fields });
  }

  async archiveWorkspace(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    await this.assertCanManage(ctx, id);
    await ctx.db.update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, id));
    await this.audit.tenantEvent({ action: 'planner.workspace_archived', resourceType: 'workspace', resourceId: id });
  }

  async members(id: string) {
    const ctx = RequestContext.tenant();
    await this.access.require(ctx, id, 'view');
    return ctx.db
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, name: users.name, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(asc(users.name));
  }

  async setMembers(id: string, members: { userId: string; role: 'owner' | 'editor' | 'viewer' }[]): Promise<void> {
    const ctx = RequestContext.tenant();
    await this.assertCanManage(ctx, id);
    if (!members.some((m) => m.role === 'owner')) throw Errors.badRequest('A workspace needs at least one owner.');
    const ids = [...new Set(members.map((m) => m.userId))];
    const valid = await ctx.db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, 'active')));
    if (valid.length !== ids.length) throw Errors.badRequest('Every member must be an active user in this workspace.');
    await ctx.db.transaction(async (tx) => {
      await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, id));
      await tx.insert(workspaceMembers).values(members.map((m) => ({ workspaceId: id, ...m })));
    });
    await this.audit.tenantEvent({ action: 'planner.workspace_members_updated', resourceType: 'workspace', resourceId: id, metadata: { members: members.length } });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(workspaceId?: string): Promise<ProjectRow[]> {
    const ctx = RequestContext.tenant();
    const visible = await this.access.visibleWorkspaceIds(ctx);
    const scope = workspaceId ? visible.filter((v) => v === workspaceId) : visible;
    if (workspaceId && !scope.length) throw Errors.notFound();
    if (!scope.length) return [];
    const rows = await ctx.db
      .select({ project: projects, ownerName: users.name })
      .from(projects)
      .leftJoin(users, eq(users.id, projects.ownerId))
      .where(inArray(projects.workspaceId, scope))
      .orderBy(asc(sql`lower(${projects.name})`));
    const counts = rows.length
      ? await ctx.db
          .select({ projectId: tasks.projectId, status: tasks.status, n: count() })
          .from(tasks)
          .where(and(inArray(tasks.projectId, rows.map((r) => r.project.id)), isNull(tasks.deletedAt), isNull(tasks.parentTaskId)))
          .groupBy(tasks.projectId, tasks.status)
      : [];
    const editable = new Set<string>();
    for (const ws of new Set(rows.map((r) => r.project.workspaceId))) {
      if ((await this.access.workspaceAccess(ctx, ws)).access === 'edit') editable.add(ws);
    }
    return rows.map(({ project: p, ownerName }) => {
      const taskCounts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
      for (const c of counts.filter((c) => c.projectId === p.id)) taskCounts[c.status] = Number(c.n);
      return {
        id: p.id,
        workspaceId: p.workspaceId,
        key: p.key,
        name: p.name,
        description: p.description,
        status: p.status,
        owner: p.ownerId ? { id: p.ownerId, name: ownerName ?? '' } : null,
        startDate: p.startDate,
        dueDate: p.dueDate,
        color: p.color,
        taskCounts,
        canEdit: editable.has(p.workspaceId),
        createdAt: p.createdAt.toISOString(),
        version: p.version,
      };
    });
  }

  async getProject(id: string): Promise<ProjectRow> {
    const ctx = RequestContext.tenant();
    const { project } = await this.access.requireProject(ctx, id, 'view');
    const row = (await this.listProjects(project.workspaceId)).find((p) => p.id === id);
    if (!row) throw Errors.notFound();
    return row;
  }

  async createProject(input: { workspaceId: string; key: string; name: string; description: string; status: ProjectRow['status']; ownerId: string | null; startDate: string | null; dueDate: string | null; color: string }): Promise<ProjectRow> {
    const ctx = RequestContext.tenant();
    await this.access.require(ctx, input.workspaceId, 'edit');
    if (input.ownerId) await this.assertActiveUser(ctx, input.ownerId);
    const [row] = await ctx.db
      .insert(projects)
      .values({ ...input, createdBy: uid(ctx) })
      .onConflictDoNothing()
      .returning({ id: projects.id });
    if (!row) throw Errors.conflict(`Project key ${input.key} is already in use.`);
    await this.audit.tenantEvent({ action: 'planner.project_created', resourceType: 'project', resourceId: row.id, metadata: { key: input.key, name: input.name } });
    return this.getProject(row.id);
  }

  async updateProject(id: string, patch: Partial<Omit<ProjectRow, 'owner' | 'taskCounts' | 'canEdit' | 'createdAt' | 'version' | 'id' | 'workspaceId' | 'key'>> & { ownerId?: string | null; version: number }): Promise<ProjectRow> {
    const ctx = RequestContext.tenant();
    const { project } = await this.access.requireProject(ctx, id, 'edit');
    if (patch.ownerId) await this.assertActiveUser(ctx, patch.ownerId);
    const { version, ...fields } = patch;
    const start = fields.startDate !== undefined ? fields.startDate : project.startDate;
    const due = fields.dueDate !== undefined ? fields.dueDate : project.dueDate;
    if (start && due && start > due) throw Errors.badRequest('Due date must be after the start date.');
    const updated = await ctx.db
      .update(projects)
      .set({ ...fields, version: project.version + 1, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.version, version)))
      .returning({ id: projects.id });
    if (!updated.length) throw Errors.versionConflict();
    await this.audit.tenantEvent({ action: 'planner.project_updated', resourceType: 'project', resourceId: id, metadata: fields });
    return this.getProject(id);
  }

  async assertActiveUser(ctx: TenantContext, userId: string): Promise<void> {
    const [u] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.status, 'active')));
    if (!u) throw Errors.badRequest('That person isn’t an active member of this workspace.');
  }

  /** Minimal directory for assignee/member pickers (planner users may lack users.read). */
  async people(): Promise<{ id: string; name: string; email: string }[]> {
    const { db } = RequestContext.tenant();
    return db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.status, 'active')).orderBy(asc(users.name));
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async listLabels(): Promise<LabelRow[]> {
    const { db } = RequestContext.tenant();
    return db.select({ id: labels.id, name: labels.name, color: labels.color }).from(labels).orderBy(asc(sql`lower(${labels.name})`));
  }

  async createLabel(input: { name: string; color: string }): Promise<LabelRow> {
    const ctx = RequestContext.tenant();
    const [row] = await ctx.db.insert(labels).values(input).onConflictDoNothing().returning({ id: labels.id, name: labels.name, color: labels.color });
    if (!row) throw Errors.conflict(`A label named “${input.name}” already exists.`);
    await this.audit.tenantEvent({ action: 'planner.label_created', resourceType: 'label', resourceId: row.id, metadata: input });
    return row;
  }

  async deleteLabel(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const removed = await ctx.db.delete(labels).where(eq(labels.id, id)).returning({ id: labels.id });
    if (!removed.length) throw Errors.notFound();
    await this.audit.tenantEvent({ action: 'planner.label_deleted', resourceType: 'label', resourceId: id });
  }
}
