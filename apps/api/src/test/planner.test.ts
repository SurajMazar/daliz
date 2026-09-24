import type { ActivityRow, CommentRow, FileRow, LabelRow, PlannerSummary, ProjectRow, TaskDetail, TaskRow, WorkspaceRow } from '@daliz/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainEvents, type DomainEventMap } from '../common/domain-events.js';
import { TestEnv, type ApiClient, type TestTenant } from './harness.js';

describe('planner', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let manager: ApiClient;
  let managerId: string;
  let employee: ApiClient;
  let employeeId: string;
  let workspaceId: string;
  let project: ProjectRow;
  const events: { name: keyof DomainEventMap; payload: unknown }[] = [];

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    const m = await t.addUser(tenant.tenantId, 'manager');
    const e = await t.addUser(tenant.tenantId, 'employee');
    managerId = m.userId;
    employeeId = e.userId;
    manager = await t.loggedIn(m.email);
    employee = await t.loggedIn(e.email);
    const bus = t.get(DomainEvents);
    for (const name of ['task.assigned', 'task.status_changed', 'task.commented'] as const) bus.on(name, (payload) => void events.push({ name, payload }));
    const ws = await manager.post<{ id: string }>('/planner/workspaces', { name: 'Operations', color: '#0f766e' });
    workspaceId = ws.data.id;
    project = (await manager.post<ProjectRow>('/planner/projects', { workspaceId, key: 'ops', name: 'Month-end close' })).data;
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('numbers tasks per project and supports subtasks', async () => {
    expect(project.key).toBe('OPS');
    const a = await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Reconcile bank accounts', priority: 'high', dueDate: '2026-09-30' });
    const b = await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Review payroll' });
    expect([a.data.key, b.data.key]).toEqual(['OPS-1', 'OPS-2']);
    const sub = await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, parentTaskId: a.data.id, title: 'Operating account' });
    expect(sub.data.parentTaskId).toBe(a.data.id);
    expect((await manager.post('/planner/tasks', { projectId: project.id, parentTaskId: sub.data.id, title: 'Too deep' })).status).toBe(400);
    const detail = await manager.get<TaskDetail>(`/planner/tasks/${a.data.id}`);
    expect(detail.data.subtasks.map((s) => s.title)).toEqual(['Operating account']);
    expect(detail.data.subtaskCount).toBe(1);
    // Top-level list excludes subtasks by default.
    const list = await manager.get<TaskRow[]>(`/planner/tasks?projectId=${project.id}`);
    expect(list.data.map((x) => x.key)).toEqual(expect.arrayContaining(['OPS-1', 'OPS-2']));
    expect(list.data.map((x) => x.key)).not.toContain(sub.data.key);
  });

  it('assigns, notifies, and tracks activity', async () => {
    events.length = 0;
    const task = await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Send invoices', assigneeId: employeeId });
    expect(events.find((e) => e.name === 'task.assigned')?.payload).toMatchObject({ assigneeId: employeeId, taskKey: task.data.key, tenantId: tenant.tenantId });
    const updated = await employee.patch<TaskDetail>(`/planner/tasks/${task.data.id}`, { status: 'in_progress', version: task.data.version });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const statusEvent = events.find((e) => e.name === 'task.status_changed')?.payload as DomainEventMap['task.status_changed'];
    expect(statusEvent).toMatchObject({ from: 'todo', to: 'in_progress', watcherIds: [managerId] });
    const activity = await manager.get<ActivityRow[]>(`/planner/tasks/${task.data.id}/activity`);
    expect(activity.data.map((a) => a.type)).toEqual(['updated', 'created']);
    // Stale edits are rejected.
    expect((await manager.patch(`/planner/tasks/${task.data.id}`, { title: 'Stale', version: task.data.version })).code).toBe('VERSION_CONFLICT');
    // Only active members can be assigned.
    expect((await manager.patch(`/planner/tasks/${task.data.id}`, { assigneeId: '00000000-0000-4000-8000-000000000000', version: updated.data.version })).status).toBe(400);
  });

  it('orders the board with drag-and-drop moves', async () => {
    const col = async () => (await manager.get<TaskRow[]>(`/planner/tasks?projectId=${project.id}&status=in_review`)).data.map((x) => x.title);
    const mk = (title: string) => manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title, status: 'in_review' });
    const x = (await mk('X')).data;
    const y = (await mk('Y')).data;
    const z = (await mk('Z')).data;
    expect(await col()).toEqual(['X', 'Y', 'Z']);
    const moved = await manager.post<TaskDetail>(`/planner/tasks/${z.id}/move`, { status: 'in_review', afterTaskId: x.id, beforeTaskId: y.id, version: z.version });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await col()).toEqual(['X', 'Z', 'Y']);
    const done = await manager.post<TaskDetail>(`/planner/tasks/${x.id}/move`, { status: 'done', version: x.version });
    expect(done.data.status).toBe('done');
    expect(done.data.completedAt).not.toBeNull();
    expect(await col()).toEqual(['Z', 'Y']);
    expect((await manager.post(`/planner/tasks/${y.id}/move`, { status: 'in_review', afterTaskId: y.id, version: y.version })).status).toBe(400);
  });

  it('keeps private workspaces to their members', async () => {
    const priv = await manager.post<{ id: string }>('/planner/workspaces', { name: 'Leadership', visibility: 'private' });
    const secretProject = (await manager.post<ProjectRow>('/planner/projects', { workspaceId: priv.data.id, key: 'LEAD', name: 'Reorg' })).data;
    const secret = (await manager.post<TaskDetail>('/planner/tasks', { projectId: secretProject.id, title: 'Draft org chart' })).data;

    expect((await employee.get<WorkspaceRow[]>('/planner/workspaces')).data.map((w) => w.name)).not.toContain('Leadership');
    expect((await employee.get(`/planner/tasks/${secret.id}`)).status).toBe(404);
    expect((await employee.get<TaskRow[]>('/planner/tasks?q=org%20chart')).data).toHaveLength(0);
    expect((await employee.post('/planner/tasks', { projectId: secretProject.id, title: 'Sneaky' })).status).toBe(404);

    await manager.put(`/planner/workspaces/${priv.data.id}/members`, {
      members: [
        { userId: managerId, role: 'owner' },
        { userId: employeeId, role: 'viewer' },
      ],
    });
    expect((await employee.get<TaskDetail>(`/planner/tasks/${secret.id}`)).data.canEdit).toBe(false);
    expect((await employee.patch(`/planner/tasks/${secret.id}`, { title: 'Edited', version: secret.version })).status).toBe(403);
    // Non-owners can't change membership.
    expect((await employee.put(`/planner/workspaces/${priv.data.id}/members`, { members: [{ userId: employeeId, role: 'owner' }] })).status).toBe(403);
  });

  it('threads comments with notifications to watchers', async () => {
    events.length = 0;
    const task = (await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Approve budget', assigneeId: employeeId })).data;
    const after = await employee.post<CommentRow[]>(`/planner/tasks/${task.id}/comments`, { body: 'Numbers look good, one question on travel.' });
    expect(after.status).toBe(201);
    expect(after.data[0]).toMatchObject({ mine: true, author: { id: employeeId } });
    expect(events.find((e) => e.name === 'task.commented')?.payload).toMatchObject({ watcherIds: [managerId] });
    // Only the author edits; others can't.
    const commentId = after.data[0]!.id;
    expect((await manager.patch(`/planner/tasks/${task.id}/comments/${commentId}`, { body: 'Hijacked' })).status).toBe(404);
    expect((await employee.patch<CommentRow[]>(`/planner/tasks/${task.id}/comments/${commentId}`, { body: 'Edited' })).data[0]!.editedAt).not.toBeNull();
  });

  it('attaches only files the user can see', async () => {
    const task = (await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Collect receipts' })).data;
    const upload = await manager.agent
      .post('/api/v1/files/upload')
      .set('X-CSRF-Token', manager.csrf!)
      .attach('file', Buffer.from('date,amount\n2026-09-01,12.50\n'), { filename: 'receipts.csv', contentType: 'text/csv' });
    const file = upload.body.data as FileRow;
    const attached = await manager.post<TaskDetail>(`/planner/tasks/${task.id}/attachments`, { fileId: file.id });
    expect(attached.data.attachments.map((a) => a.name)).toEqual(['receipts.csv']);
    // A file in a restricted folder the employee can't see can't be attached by them.
    const folder = await manager.post<{ id: string }>('/files/folders', { name: 'Private receipts', visibility: 'restricted' });
    const hidden = await manager.agent
      .post('/api/v1/files/upload')
      .set('X-CSRF-Token', manager.csrf!)
      .field('folderId', folder.data.id)
      .attach('file', Buffer.from('x\n'), { filename: 'hidden.csv', contentType: 'text/csv' });
    const mine = (await employee.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'My task' })).data;
    expect((await employee.post(`/planner/tasks/${mine.id}/attachments`, { fileId: (hidden.body.data as FileRow).id })).status).toBe(404);
  });

  it('supports labels, filters and idempotent creation for offline sync', async () => {
    const label = (await manager.post<LabelRow>('/planner/labels', { name: 'Audit', color: '#b91c1c' })).data;
    const key = `offline-op-${Date.now()}`;
    const body = { projectId: project.id, title: 'Offline-created task', labelIds: [label.id], assigneeId: employeeId, dueDate: '2026-10-02' };
    const first = await employee.post<TaskDetail>('/planner/tasks', body, { headers: { 'Idempotency-Key': key } });
    const replay = await employee.post<TaskDetail>('/planner/tasks', body, { headers: { 'Idempotency-Key': key } });
    expect(replay.data.id).toBe(first.data.id);
    const byLabel = await manager.get<TaskRow[]>(`/planner/tasks?labelId=${label.id}`);
    expect(byLabel.data.map((x) => x.title)).toEqual(['Offline-created task']);
    const mine = await employee.get<TaskRow[]>('/planner/tasks?assignee=me&includeDone=false');
    expect(mine.data.every((x) => x.assignee?.id === employeeId)).toBe(true);
    const calendar = await manager.get<TaskRow[]>('/planner/tasks?dueFrom=2026-10-01&dueTo=2026-10-31&includeSubtasks=true');
    expect(calendar.data.map((x) => x.title)).toContain('Offline-created task');
    const summary = await employee.get<PlannerSummary>('/planner/summary');
    expect(summary.data.assignedToMe).toBeGreaterThan(0);
  });

  it('enforces planner permissions and tenant isolation', async () => {
    const viewer = await t.loggedIn((await t.addUser(tenant.tenantId, 'viewer')).email);
    expect((await viewer.get('/planner/workspaces')).status).toBe(200);
    expect((await viewer.post('/planner/tasks', { projectId: project.id, title: 'No' })).status).toBe(403);
    const accountant = await t.loggedIn((await t.addUser(tenant.tenantId, 'accountant')).email);
    const task = (await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Keep me' })).data;
    expect((await accountant.patch(`/planner/tasks/${task.id}`, { title: 'x', version: task.version })).status).toBe(403);

    const other = await t.createTenant();
    const stranger = await t.loggedIn(other.ownerEmail);
    expect((await stranger.get(`/planner/tasks/${task.id}`)).status).toBe(404);
    expect((await stranger.get<TaskRow[]>('/planner/tasks')).data).toHaveLength(0);
    expect((await stranger.post('/planner/tasks', { projectId: project.id, title: 'Cross-tenant' })).status).toBe(404);
  });
});
