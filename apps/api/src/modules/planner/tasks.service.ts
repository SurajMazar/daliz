import { Injectable } from '@nestjs/common';
import type { ActivityRow, CommentRow, LabelRow, PlannerSummary, TaskDetail, TaskInput, TaskRow, TaskStatus } from '@daliz/shared';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, max, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DomainEvents } from '../../common/domain-events.js';
import { Errors } from '../../common/errors.js';
import { qcol } from '../../common/sql.js';
import { RequestContext, type TenantContext } from '../../common/request-context.js';
import { files, labels, projects, taskActivity, taskAttachments, taskComments, taskLabels, tasks, users } from '../../database/tenant/schema.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { AuditService } from '../audit/audit.service.js';
import { FilesService } from '../files/files.service.js';
import { PlannerAccessService } from './planner-access.js';
import { PlannerService } from './planner.service.js';

type Tx = Parameters<Parameters<TenantDb['transaction']>[0]>[0];
const uid = (ctx: TenantContext) => (ctx.actor.type === 'user' ? ctx.actor.userId : null);
const PRIORITY_ORDER = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
const STEP = 1000;

interface ListQuery {
  workspaceId?: string;
  projectId?: string;
  parentTaskId?: string;
  status?: TaskStatus[];
  assignee?: string;
  priority?: string;
  labelId?: string;
  q?: string;
  dueFrom?: string;
  dueTo?: string;
  includeSubtasks: boolean;
  includeDone: boolean;
  sort: 'position' | 'due' | 'priority' | 'updated' | 'created';
  page: number;
  pageSize: number;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly access: PlannerAccessService,
    private readonly planner: PlannerService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly filesService: FilesService,
  ) {}

  private async activity(db: TenantDb | Tx, taskId: string, actorId: string | null, type: string, data: Record<string, unknown> = {}) {
    await db.insert(taskActivity).values({ taskId, actorId, type, data });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private baseQuery(db: TenantDb) {
    const assignee = alias(users, 'assignee');
    const reporter = alias(users, 'reporter');
    return db
      .select({
        task: tasks,
        projectKey: projects.key,
        projectName: projects.name,
        workspaceId: projects.workspaceId,
        assignee: { id: assignee.id, name: assignee.name },
        reporter: { id: reporter.id, name: reporter.name },
        subtaskCount: sql<number>`(select count(*)::int from ${tasks} s where s.parent_task_id = ${qcol(tasks.id)} and s.deleted_at is null)`,
        subtaskDoneCount: sql<number>`(select count(*)::int from ${tasks} s where s.parent_task_id = ${qcol(tasks.id)} and s.deleted_at is null and s.status = 'done')`,
        commentCount: sql<number>`(select count(*)::int from ${taskComments} c where c.task_id = ${qcol(tasks.id)} and c.deleted_at is null)`,
        attachmentCount: sql<number>`(select count(*)::int from ${taskAttachments} a where a.task_id = ${qcol(tasks.id)})`,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
      .leftJoin(reporter, eq(reporter.id, tasks.reporterId))
      .$dynamic();
  }

  private async toRows(ctx: TenantContext, rows: Awaited<ReturnType<ReturnType<TasksService['baseQuery']>['execute']>>): Promise<TaskRow[]> {
    if (!rows.length) return [];
    const labelRows = await ctx.db
      .select({ taskId: taskLabels.taskId, id: labels.id, name: labels.name, color: labels.color })
      .from(taskLabels)
      .innerJoin(labels, eq(labels.id, taskLabels.labelId))
      .where(inArray(taskLabels.taskId, rows.map((r) => r.task.id)));
    const editable = new Map<string, boolean>();
    for (const ws of new Set(rows.map((r) => r.workspaceId))) {
      editable.set(ws, (await this.access.workspaceAccess(ctx, ws)).access === 'edit');
    }
    const person = (p: { id: string | null; name: string | null } | null) => (p?.id ? { id: p.id, name: p.name ?? '' } : null);
    return rows.map((r) => ({
      id: r.task.id,
      key: `${r.projectKey}-${r.task.number}`,
      projectId: r.task.projectId,
      projectName: r.projectName,
      parentTaskId: r.task.parentTaskId,
      title: r.task.title,
      description: r.task.description,
      status: r.task.status,
      priority: r.task.priority,
      assignee: person(r.assignee),
      reporter: person(r.reporter),
      startDate: r.task.startDate,
      dueDate: r.task.dueDate,
      estimateMinutes: r.task.estimateMinutes,
      position: r.task.position,
      labels: labelRows.filter((l) => l.taskId === r.task.id).map(({ id, name, color }): LabelRow => ({ id, name, color })),
      subtaskCount: Number(r.subtaskCount),
      subtaskDoneCount: Number(r.subtaskDoneCount),
      commentCount: Number(r.commentCount),
      attachmentCount: Number(r.attachmentCount),
      completedAt: r.task.completedAt?.toISOString() ?? null,
      canEdit: editable.get(r.workspaceId) ?? false,
      createdAt: r.task.createdAt.toISOString(),
      updatedAt: r.task.updatedAt.toISOString(),
      version: r.task.version,
    }));
  }

  async list(q: ListQuery): Promise<{ items: TaskRow[]; meta: { page: number; pageSize: number; total: number } }> {
    const ctx = RequestContext.tenant();
    let visible = await this.access.visibleWorkspaceIds(ctx);
    if (q.workspaceId) visible = visible.filter((v) => v === q.workspaceId);
    if (q.projectId) {
      const { project } = await this.access.requireProject(ctx, q.projectId, 'view');
      visible = visible.filter((v) => v === project.workspaceId);
    }
    if (!visible.length) return { items: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
    const me = uid(ctx);
    const where = and(
      isNull(tasks.deletedAt),
      inArray(projects.workspaceId, visible),
      q.projectId ? eq(tasks.projectId, q.projectId) : undefined,
      q.parentTaskId ? eq(tasks.parentTaskId, q.parentTaskId) : q.includeSubtasks ? undefined : isNull(tasks.parentTaskId),
      q.status?.length ? inArray(tasks.status, q.status) : undefined,
      !q.includeDone ? notInArray(tasks.status, ['done', 'cancelled']) : undefined,
      q.assignee === 'me' ? (me ? eq(tasks.assigneeId, me) : sql`false`) : q.assignee === 'unassigned' ? isNull(tasks.assigneeId) : q.assignee ? eq(tasks.assigneeId, q.assignee) : undefined,
      q.priority ? eq(tasks.priority, q.priority as TaskRow['priority']) : undefined,
      q.labelId ? sql`exists (select 1 from ${taskLabels} tl where tl.task_id = ${qcol(tasks.id)} and tl.label_id = ${q.labelId})` : undefined,
      q.q ? or(ilike(tasks.title, `%${q.q}%`), ilike(tasks.description, `%${q.q}%`)) : undefined,
      q.dueFrom ? gte(tasks.dueDate, q.dueFrom) : undefined,
      q.dueTo ? lte(tasks.dueDate, q.dueTo) : undefined,
    );
    const order =
      q.sort === 'due'
        ? [sql`${tasks.dueDate} asc nulls last`, asc(tasks.position)]
        : q.sort === 'priority'
          ? [asc(PRIORITY_ORDER), sql`${tasks.dueDate} asc nulls last`]
          : q.sort === 'updated'
            ? [desc(tasks.updatedAt)]
            : q.sort === 'created'
              ? [desc(tasks.createdAt)]
              : [asc(tasks.status), asc(tasks.position)];
    const [total] = await ctx.db.select({ n: count() }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(where);
    const rows = await this.baseQuery(ctx.db)
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items: await this.toRows(ctx, rows), meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) } };
  }

  private async load(ctx: TenantContext, id: string, needed: 'view' | 'edit') {
    const [row] = await this.baseQuery(ctx.db).where(and(eq(tasks.id, id), isNull(tasks.deletedAt)));
    if (!row) throw Errors.notFound();
    await this.access.require(ctx, row.workspaceId, needed);
    return row;
  }

  async get(id: string): Promise<TaskDetail> {
    const ctx = RequestContext.tenant();
    const row = await this.load(ctx, id, 'view');
    const [task] = await this.toRows(ctx, [row]);
    const subtaskRows = await this.baseQuery(ctx.db)
      .where(and(eq(tasks.parentTaskId, id), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.position));
    const attachments = await ctx.db
      .select({ fileId: files.id, name: files.name, extension: files.extension, sizeBytes: files.sizeBytes, addedAt: taskAttachments.createdAt })
      .from(taskAttachments)
      .innerJoin(files, eq(files.id, taskAttachments.fileId))
      .where(and(eq(taskAttachments.taskId, id), isNull(files.deletedAt)))
      .orderBy(asc(taskAttachments.createdAt));
    return {
      ...task!,
      subtasks: await this.toRows(ctx, subtaskRows),
      attachments: attachments.map((a) => ({ ...a, addedAt: a.addedAt.toISOString() })),
    };
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private async validateRefs(ctx: TenantContext, input: { assigneeId?: string | null; labelIds?: string[] }) {
    if (input.assigneeId) await this.planner.assertActiveUser(ctx, input.assigneeId);
    if (input.labelIds?.length) {
      const found = await ctx.db.select({ id: labels.id }).from(labels).where(inArray(labels.id, input.labelIds));
      if (found.length !== new Set(input.labelIds).size) throw Errors.badRequest('Unknown label.');
    }
  }

  async create(input: TaskInput): Promise<TaskDetail> {
    const ctx = RequestContext.tenant();
    const { project } = await this.access.requireProject(ctx, input.projectId, 'edit');
    if (project.status === 'archived') throw Errors.conflict('This project is archived.');
    await this.validateRefs(ctx, input);
    if (input.parentTaskId) {
      const [parent] = await ctx.db.select().from(tasks).where(and(eq(tasks.id, input.parentTaskId), isNull(tasks.deletedAt)));
      if (!parent || parent.projectId !== input.projectId) throw Errors.badRequest('The parent task must be in the same project.');
      if (parent.parentTaskId) throw Errors.badRequest('Subtasks can’t have their own subtasks.');
    }
    const me = uid(ctx);
    const id = await ctx.db.transaction(async (tx) => {
      const [numbered] = await tx
        .update(projects)
        .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
        .where(eq(projects.id, input.projectId))
        .returning({ number: sql<number>`${projects.nextTaskNumber} - 1` });
      const [top] = await tx
        .select({ max: max(tasks.position) })
        .from(tasks)
        .where(and(eq(tasks.projectId, input.projectId), eq(tasks.status, input.status), isNull(tasks.deletedAt)));
      const position = String(Number(top?.max ?? 0) + STEP);
      const { labelIds, ...fields } = input;
      const [task] = await tx
        .insert(tasks)
        .values({
          ...fields,
          number: numbered!.number,
          position,
          reporterId: me,
          createdBy: me,
          completedAt: input.status === 'done' ? new Date() : null,
        })
        .returning({ id: tasks.id });
      if (labelIds.length) await tx.insert(taskLabels).values(labelIds.map((labelId) => ({ taskId: task!.id, labelId })));
      await this.activity(tx, task!.id, me, 'created', { title: input.title });
      return task!.id;
    });
    const detail = await this.get(id);
    await this.audit.tenantEvent({ action: 'planner.task_created', resourceType: 'task', resourceId: id, metadata: { key: detail.key, projectId: input.projectId } });
    if (input.assigneeId && input.assigneeId !== me) {
      this.events.emit('task.assigned', { tenantId: ctx.tenantId, taskId: id, taskKey: detail.key, title: detail.title, assigneeId: input.assigneeId, actorId: me });
    }
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['planner'] });
    return detail;
  }

  async update(id: string, patch: { title?: string; description?: string; status?: TaskStatus; priority?: TaskRow['priority']; assigneeId?: string | null; startDate?: string | null; dueDate?: string | null; estimateMinutes?: number | null; labelIds?: string[]; version: number }): Promise<TaskDetail> {
    const ctx = RequestContext.tenant();
    const row = await this.load(ctx, id, 'edit');
    await this.validateRefs(ctx, patch);
    const t = row.task;
    const start = patch.startDate !== undefined ? patch.startDate : t.startDate;
    const due = patch.dueDate !== undefined ? patch.dueDate : t.dueDate;
    if (start && due && start > due) throw Errors.badRequest('Due date must be after the start date.');
    const me = uid(ctx);
    const { version, labelIds, ...fields } = patch;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(fields)) {
      const before = (t as Record<string, unknown>)[k];
      if (v !== undefined && v !== before) changes[k] = { from: k === 'description' ? undefined : before, to: k === 'description' ? undefined : v };
    }
    let statusPosition: string | undefined;
    await ctx.db.transaction(async (tx) => {
      if (patch.status && patch.status !== t.status) {
        const [top] = await tx.select({ max: max(tasks.position) }).from(tasks).where(and(eq(tasks.projectId, t.projectId), eq(tasks.status, patch.status), isNull(tasks.deletedAt)));
        statusPosition = String(Number(top?.max ?? 0) + STEP);
      }
      const updated = await tx
        .update(tasks)
        .set({
          ...fields,
          ...(statusPosition ? { position: statusPosition } : {}),
          ...(patch.status ? { completedAt: patch.status === 'done' ? (t.completedAt ?? new Date()) : null } : {}),
          version: t.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, id), eq(tasks.version, version)))
        .returning({ id: tasks.id });
      if (!updated.length) throw Errors.versionConflict();
      if (labelIds) {
        await tx.delete(taskLabels).where(eq(taskLabels.taskId, id));
        if (labelIds.length) await tx.insert(taskLabels).values(labelIds.map((labelId) => ({ taskId: id, labelId })));
        changes.labels = { from: undefined, to: labelIds.length };
      }
      if (Object.keys(changes).length) await this.activity(tx, id, me, 'updated', { changes });
    });
    const detail = await this.get(id);
    if (Object.keys(changes).length) {
      await this.audit.tenantEvent({ action: 'planner.task_updated', resourceType: 'task', resourceId: id, metadata: { key: detail.key, fields: Object.keys(changes) } });
    }
    this.emitChanges(ctx, detail, t, patch, me);
    return detail;
  }

  private emitChanges(ctx: TenantContext, detail: TaskDetail, before: typeof tasks.$inferSelect, patch: { status?: TaskStatus; assigneeId?: string | null }, me: string | null) {
    if (patch.assigneeId && patch.assigneeId !== before.assigneeId && patch.assigneeId !== me) {
      this.events.emit('task.assigned', { tenantId: ctx.tenantId, taskId: detail.id, taskKey: detail.key, title: detail.title, assigneeId: patch.assigneeId, actorId: me });
    }
    if (patch.status && patch.status !== before.status) {
      const watchers = [detail.assignee?.id, detail.reporter?.id].filter((x): x is string => !!x && x !== me);
      this.events.emit('task.status_changed', { tenantId: ctx.tenantId, taskId: detail.id, taskKey: detail.key, title: detail.title, from: before.status, to: patch.status, actorId: me, watcherIds: [...new Set(watchers)] });
    }
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['planner'] });
  }

  /** Board drag and drop: place a task between two neighbours in a (possibly new) column. */
  async move(id: string, input: { status: TaskStatus; afterTaskId: string | null; beforeTaskId: string | null; version: number }): Promise<TaskDetail> {
    const ctx = RequestContext.tenant();
    const row = await this.load(ctx, id, 'edit');
    const t = row.task;
    const me = uid(ctx);
    await ctx.db.transaction(async (tx) => {
      const neighbour = async (nid: string | null) => {
        if (!nid) return null;
        const [n] = await tx.select().from(tasks).where(and(eq(tasks.id, nid), isNull(tasks.deletedAt)));
        if (!n || n.projectId !== t.projectId || n.status !== input.status || n.id === id) throw Errors.badRequest('Invalid drop position.');
        return Number(n.position);
      };
      const after = await neighbour(input.afterTaskId);
      const before = await neighbour(input.beforeTaskId);
      let position: number;
      if (after !== null && before !== null) position = (after + before) / 2;
      else if (after !== null) position = after + STEP;
      else if (before !== null) position = before - STEP;
      else {
        const [top] = await tx.select({ max: max(tasks.position) }).from(tasks).where(and(eq(tasks.projectId, t.projectId), eq(tasks.status, input.status), isNull(tasks.deletedAt), ne(tasks.id, id)));
        position = Number(top?.max ?? 0) + STEP;
      }
      const updated = await tx
        .update(tasks)
        .set({
          status: input.status,
          position: position.toFixed(10),
          completedAt: input.status === 'done' ? (t.completedAt ?? new Date()) : null,
          version: t.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, id), eq(tasks.version, input.version)))
        .returning({ id: tasks.id });
      if (!updated.length) throw Errors.versionConflict();
      // Keep gaps usable: renumber the column when neighbours get too close.
      if (after !== null && before !== null && Math.abs(before - after) < 1e-6) {
        const column = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.projectId, t.projectId), eq(tasks.status, input.status), isNull(tasks.deletedAt)))
          .orderBy(asc(tasks.position));
        for (const [i, c] of column.entries()) await tx.update(tasks).set({ position: String((i + 1) * STEP) }).where(eq(tasks.id, c.id));
      }
      if (input.status !== t.status) await this.activity(tx, id, me, 'updated', { changes: { status: { from: t.status, to: input.status } } });
    });
    const detail = await this.get(id);
    this.emitChanges(ctx, detail, t, { status: input.status }, me);
    return detail;
  }

  async remove(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const row = await this.load(ctx, id, 'edit');
    const now = new Date();
    await ctx.db.update(tasks).set({ deletedAt: now, updatedAt: now }).where(or(eq(tasks.id, id), eq(tasks.parentTaskId, id)));
    await this.audit.tenantEvent({ action: 'planner.task_deleted', resourceType: 'task', resourceId: id, metadata: { key: `${row.projectKey}-${row.task.number}`, title: row.task.title } });
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['planner'] });
  }

  // -------------------------------------------------------------------------
  // Comments, attachments, activity
  // -------------------------------------------------------------------------

  async comments(id: string): Promise<CommentRow[]> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, id, 'view');
    const me = uid(ctx);
    const rows = await ctx.db
      .select({ c: taskComments, name: users.name })
      .from(taskComments)
      .leftJoin(users, eq(users.id, taskComments.authorId))
      .where(and(eq(taskComments.taskId, id), isNull(taskComments.deletedAt)))
      .orderBy(asc(taskComments.createdAt));
    return rows.map(({ c, name }) => ({
      id: c.id,
      author: c.authorId ? { id: c.authorId, name: name ?? '' } : null,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      editedAt: c.editedAt?.toISOString() ?? null,
      mine: !!me && c.authorId === me,
    }));
  }

  async addComment(id: string, body: string): Promise<CommentRow[]> {
    const ctx = RequestContext.tenant();
    const row = await this.load(ctx, id, 'view');
    const me = uid(ctx);
    const [c] = await ctx.db.insert(taskComments).values({ taskId: id, authorId: me, body }).returning({ id: taskComments.id });
    await this.activity(ctx.db, id, me, 'commented', { commentId: c!.id });
    const key = `${row.projectKey}-${row.task.number}`;
    const priorCommenters = (await ctx.db.selectDistinct({ id: taskComments.authorId }).from(taskComments).where(eq(taskComments.taskId, id))).map((r) => r.id);
    const watchers = [row.task.assigneeId, row.task.reporterId, ...priorCommenters].filter((x): x is string => !!x && x !== me);
    this.events.emit('task.commented', { tenantId: ctx.tenantId, taskId: id, taskKey: key, title: row.task.title, commentId: c!.id, actorId: me, watcherIds: [...new Set(watchers)] });
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['planner'] });
    return this.comments(id);
  }

  async editComment(taskId: string, commentId: string, body: string): Promise<CommentRow[]> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, taskId, 'view');
    const me = uid(ctx);
    const updated = await ctx.db
      .update(taskComments)
      .set({ body, editedAt: new Date() })
      .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId), me ? eq(taskComments.authorId, me) : sql`false`, isNull(taskComments.deletedAt)))
      .returning({ id: taskComments.id });
    if (!updated.length) throw Errors.notFound();
    return this.comments(taskId);
  }

  async deleteComment(taskId: string, commentId: string): Promise<void> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, taskId, 'view');
    const me = uid(ctx);
    const moderator = ctx.permissions.has('planner.delete');
    const updated = await ctx.db
      .update(taskComments)
      .set({ deletedAt: new Date() })
      .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId), moderator ? undefined : me ? eq(taskComments.authorId, me) : sql`false`))
      .returning({ id: taskComments.id });
    if (!updated.length) throw Errors.notFound();
  }

  async addAttachment(taskId: string, fileId: string): Promise<TaskDetail> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, taskId, 'edit');
    // The caller must be able to see the file itself; attaching doesn't widen file access.
    await this.filesService.getFile(fileId);
    await ctx.db.insert(taskAttachments).values({ taskId, fileId, addedBy: uid(ctx) }).onConflictDoNothing();
    await this.activity(ctx.db, taskId, uid(ctx), 'attachment_added', { fileId });
    return this.get(taskId);
  }

  async removeAttachment(taskId: string, fileId: string): Promise<void> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, taskId, 'edit');
    const removed = await ctx.db.delete(taskAttachments).where(and(eq(taskAttachments.taskId, taskId), eq(taskAttachments.fileId, fileId))).returning({ id: taskAttachments.fileId });
    if (!removed.length) throw Errors.notFound();
    await this.activity(ctx.db, taskId, uid(ctx), 'attachment_removed', { fileId });
  }

  async activityLog(taskId: string): Promise<ActivityRow[]> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, taskId, 'view');
    const rows = await ctx.db
      .select({ a: taskActivity, name: users.name })
      .from(taskActivity)
      .leftJoin(users, eq(users.id, taskActivity.actorId))
      .where(eq(taskActivity.taskId, taskId))
      .orderBy(desc(taskActivity.createdAt))
      .limit(200);
    return rows.map(({ a, name }) => ({ id: a.id, actor: a.actorId ? { id: a.actorId, name: name ?? '' } : null, type: a.type, data: a.data, createdAt: a.createdAt.toISOString() }));
  }

  /** "My work" numbers for the dashboard, using the tenant's time zone for "today". */
  async summary(timezone: string): Promise<PlannerSummary> {
    const ctx = RequestContext.tenant();
    const me = uid(ctx);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const weekEnd = new Date(`${today}T00:00:00Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const inAWeek = weekEnd.toISOString().slice(0, 10);
    if (!me) return { assignedToMe: 0, dueToday: 0, overdue: 0, dueThisWeek: 0, upcoming: [] };
    const visible = await this.access.visibleWorkspaceIds(ctx);
    if (!visible.length) return { assignedToMe: 0, dueToday: 0, overdue: 0, dueThisWeek: 0, upcoming: [] };
    const base = and(isNull(tasks.deletedAt), eq(tasks.assigneeId, me), notInArray(tasks.status, ['done', 'cancelled']), inArray(projects.workspaceId, visible));
    const countWhere = async (extra?: SQL) =>
      Number((await ctx.db.select({ n: count() }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(base, extra)))[0]?.n ?? 0);
    const upcomingRows = await this.baseQuery(ctx.db).where(and(base, sql`${tasks.dueDate} is not null`)).orderBy(asc(tasks.dueDate), asc(PRIORITY_ORDER)).limit(6);
    return {
      assignedToMe: await countWhere(),
      dueToday: await countWhere(eq(tasks.dueDate, today)),
      overdue: await countWhere(sql`${tasks.dueDate} < ${today}`),
      dueThisWeek: await countWhere(and(gte(tasks.dueDate, today), lte(tasks.dueDate, inAWeek))),
      upcoming: await this.toRows(ctx, upcomingRows),
    };
  }
}
