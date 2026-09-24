/**
 * Planner offline support: which task operations may be queued, and overlays that show
 * queued (not yet synced) work on top of the last server data.
 */
import type { CommentRow, TaskDetail, TaskRow } from '@daliz/shared';
import { api } from '@/lib/api';
import { isNetworkError } from '@/offline/cache';
import { isOffline } from '@/offline/connectivity';
import type { QueuedOp } from '@/offline/db';
import { enqueue } from '@/offline/queue';

export const OFFLINE_ID_PREFIX = 'offline-';
export const isOfflineId = (id: string) => id.startsWith(OFFLINE_ID_PREFIX);

/** Only these fields may change offline (each change carries the task's version). */
export const OFFLINE_TASK_FIELDS = new Set(['status', 'title']);
export const isOfflinePatch = (patch: Record<string, unknown>) =>
  Object.keys(patch).length > 0 && Object.keys(patch).every((k) => OFFLINE_TASK_FIELDS.has(k));

async function sendOrQueue<T>(
  send: () => Promise<T>,
  queue: () => Promise<unknown>,
): Promise<{ queued: false; result: T } | { queued: true }> {
  if (isOffline()) {
    await queue();
    return { queued: true };
  }
  try {
    return { queued: false, result: await send() };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    await queue();
    return { queued: true };
  }
}

export interface NewTaskBody {
  projectId: string;
  title: string;
  status?: string;
  dueDate?: string;
  parentTaskId?: string;
}

/** Creates a task, or queues it (same Idempotency-Key) when there's no connection. */
export function createTask(body: NewTaskBody, key: string) {
  return sendOrQueue(
    () => api.post<TaskDetail>('/planner/tasks', body, { idempotencyKey: key }),
    () => enqueue('task.create', { body }, `New task: ${body.title}`, key),
  );
}

export function updateTaskOffline(
  task: Pick<TaskRow, 'id' | 'version' | 'title'>,
  patch: Record<string, unknown>,
) {
  return enqueue(
    'task.update',
    { taskId: task.id, version: task.version, patch },
    `Update “${task.title}”`,
  );
}

export function postComment(taskId: string, text: string, key: string) {
  return sendOrQueue(
    () =>
      api.post<CommentRow[]>(
        `/planner/tasks/${taskId}/comments`,
        { body: text },
        { idempotencyKey: key },
      ),
    () => enqueue('task.comment', { taskId, body: text }, `Comment: ${text.slice(0, 40)}`, key),
  );
}

// --- Overlays ----------------------------------------------------------------------

function tempTask(op: QueuedOp): TaskRow {
  const b = op.payload.body as NewTaskBody;
  const now = new Date(op.createdAt).toISOString();
  return {
    id: `${OFFLINE_ID_PREFIX}${op.operationId}`,
    key: 'Pending sync',
    projectId: b.projectId,
    projectName: '',
    parentTaskId: b.parentTaskId ?? null,
    title: b.title,
    description: '',
    status: (b.status as TaskRow['status']) ?? 'todo',
    priority: 'none',
    assignee: null,
    reporter: null,
    startDate: null,
    dueDate: b.dueDate ?? null,
    estimateMinutes: null,
    position: `~${op.createdAt}`,
    labels: [],
    subtaskCount: 0,
    subtaskDoneCount: 0,
    commentCount: 0,
    attachmentCount: 0,
    completedAt: null,
    canEdit: false,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function patchFor(pending: QueuedOp[], taskId: string): Record<string, unknown> | null {
  const op = pending.find((o) => o.type === 'task.update' && o.payload.taskId === taskId);
  return op ? (op.payload.patch as Record<string, unknown>) : null;
}

export function overlayTasks(
  rows: TaskRow[] | undefined,
  pending: QueuedOp[],
  projectId: string,
): TaskRow[] | undefined {
  if (!rows || pending.length === 0) return rows;
  const updated = rows.map((r) => {
    const p = patchFor(pending, r.id);
    return p ? ({ ...r, ...p } as TaskRow) : r;
  });
  const created = pending
    .filter(
      (o) =>
        o.type === 'task.create' &&
        (o.payload.body as NewTaskBody).projectId === projectId &&
        !(o.payload.body as NewTaskBody).parentTaskId,
    )
    .map(tempTask);
  return created.length ? [...updated, ...created] : updated;
}

export function overlayTask(
  task: TaskDetail | undefined,
  pending: QueuedOp[],
): TaskDetail | undefined {
  if (!task || pending.length === 0) return task;
  const p = patchFor(pending, task.id);
  const subtasks = pending
    .filter(
      (o) => o.type === 'task.create' && (o.payload.body as NewTaskBody).parentTaskId === task.id,
    )
    .map(tempTask);
  if (!p && subtasks.length === 0) return task;
  return { ...task, ...(p ?? {}), subtasks: [...task.subtasks, ...subtasks] } as TaskDetail;
}

export function overlayComments(
  rows: CommentRow[] | undefined,
  pending: QueuedOp[],
  taskId: string,
): CommentRow[] | undefined {
  if (!rows || pending.length === 0) return rows;
  const queued = pending
    .filter((o) => o.type === 'task.comment' && o.payload.taskId === taskId)
    .map<CommentRow>((o) => ({
      id: `${OFFLINE_ID_PREFIX}${o.operationId}`,
      author: { id: 'me', name: 'You (pending sync)' },
      body: String(o.payload.body),
      createdAt: new Date(o.createdAt).toISOString(),
      editedAt: null,
      mine: false,
    }));
  return queued.length ? [...rows, ...queued] : rows;
}
