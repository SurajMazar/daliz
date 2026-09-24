/**
 * Offline mutation queue. Only offline-safe operations are ever queued: creating a planner
 * task, changing a task's status/title (with its version), commenting on a task, creating a
 * reminder, and recording a daybook entry as *pending* (never posted). Each operation keeps
 * the client-generated `operationId`, sent as the Idempotency-Key when replayed, so a retry
 * after a flaky connection can never create a duplicate.
 */
import { useSyncExternalStore } from 'react';
import type { TaskDetail } from '@daliz/shared';
import { api, errorMessage, isApiError } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { isNetworkError } from './cache';
import { getConnectivity, setConnectivity } from './connectivity';
import {
  getOfflineScope,
  offlineDb,
  onScopeChange,
  type ConflictRecord,
  type QueuedOp,
  type QueuedOpType,
} from './db';

interface QueueState {
  pending: QueuedOp[];
  errors: QueuedOp[];
  conflicts: ConflictRecord[];
}

let snapshot: QueueState = { pending: [], errors: [], conflicts: [] };
const listeners = new Set<() => void>();

export async function refreshQueueState(): Promise<void> {
  const scope = getOfflineScope();
  let ops: QueuedOp[] = [];
  let conflicts: ConflictRecord[] = [];
  if (scope) {
    try {
      const db = await offlineDb();
      ops = (await db.getAllFromIndex('queue', 'scope', scope)).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      conflicts = await db.getAllFromIndex('conflicts', 'scope', scope);
    } catch {
      // IndexedDB unavailable.
    }
  }
  snapshot = {
    pending: ops.filter((o) => o.status === 'pending'),
    errors: ops.filter((o) => o.status === 'error'),
    conflicts,
  };
  listeners.forEach((l) => l());
}
onScopeChange(() => void refreshQueueState());

export function useQueueState(): QueueState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot,
  );
}

/**
 * Queues an offline-safe operation. `operationId` defaults to a new UUID; pass the
 * Idempotency-Key of an attempt that failed on the network so a request the server did
 * receive is never applied twice. Status/title changes to the same task are coalesced.
 */
export async function enqueue(
  type: QueuedOpType,
  payload: Record<string, unknown>,
  label: string,
  operationId?: string,
): Promise<QueuedOp> {
  const scope = getOfflineScope();
  if (!scope) throw new Error('Offline changes need an active workspace.');
  const db = await offlineDb();
  if (type === 'task.update') {
    const existing = (await db.getAllFromIndex('queue', 'scope', scope)).find(
      (o) =>
        o.type === 'task.update' && o.status === 'pending' && o.payload.taskId === payload.taskId,
    );
    if (existing) {
      const merged: QueuedOp = {
        ...existing,
        label,
        payload: {
          ...existing.payload,
          patch: { ...(existing.payload.patch as object), ...(payload.patch as object) },
        },
      };
      await db.put('queue', merged);
      await refreshQueueState();
      return merged;
    }
  }
  const op: QueuedOp = {
    operationId: operationId ?? crypto.randomUUID(),
    scope,
    type,
    label,
    payload,
    createdAt: Date.now(),
    status: 'pending',
  };
  await db.put('queue', op);
  await refreshQueueState();
  return op;
}

async function run(op: QueuedOp): Promise<void> {
  const p = op.payload;
  const key = op.operationId;
  switch (op.type) {
    case 'task.create':
      await api.post('/planner/tasks', p.body, { idempotencyKey: key });
      return;
    case 'task.update':
      await api.patch(`/planner/tasks/${String(p.taskId)}`, {
        ...(p.patch as object),
        version: p.version,
      });
      return;
    case 'task.comment':
      await api.post(
        `/planner/tasks/${String(p.taskId)}/comments`,
        { body: p.body },
        { idempotencyKey: key },
      );
      return;
    case 'reminder.create':
      await api.post('/reminders', p.body, { idempotencyKey: key });
      return;
    case 'daybook.create':
      // Offline daybook entries are only ever recorded as pending.
      await api.post(
        '/daybook/entries',
        { ...(p.body as object), postImmediately: false },
        { idempotencyKey: key },
      );
      return;
  }
}

let replaying: Promise<void> | null = null;

/** Replays queued operations in order. Safe to call repeatedly. */
export function replayQueue(): Promise<void> {
  if (!replaying) replaying = doReplay().finally(() => (replaying = null));
  return replaying;
}

async function doReplay(): Promise<void> {
  const scope = getOfflineScope();
  if (!scope) {
    // Nothing can be queued without a workspace; the connection itself is back.
    if (getConnectivity() !== 'OFFLINE') setConnectivity('ONLINE');
    return;
  }
  const db = await offlineDb();
  const ops = (await db.getAllFromIndex('queue', 'scope', scope))
    .filter((o) => o.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (ops.length === 0) {
    await refreshQueueState();
    if (getConnectivity() !== 'OFFLINE')
      setConnectivity(snapshot.errors.length ? 'SYNC_ERROR' : 'ONLINE');
    return;
  }
  setConnectivity('SYNCING');
  for (const op of ops) {
    try {
      await run(op);
      await db.delete('queue', op.operationId);
    } catch (e) {
      if (isNetworkError(e)) {
        setConnectivity('OFFLINE');
        await refreshQueueState();
        return;
      }
      if (isApiError(e) && e.code === 'VERSION_CONFLICT' && op.type === 'task.update') {
        const server = await api
          .get<TaskDetail>(`/planner/tasks/${String(op.payload.taskId)}`)
          .catch(() => null);
        await db.put('conflicts', {
          operationId: op.operationId,
          scope,
          op,
          server: server as unknown as Record<string, unknown> | null,
          createdAt: Date.now(),
        });
        await db.delete('queue', op.operationId);
      } else {
        await db.put('queue', { ...op, status: 'error', error: errorMessage(e) });
      }
    }
    await refreshQueueState();
  }
  await refreshQueueState();
  void queryClient.invalidateQueries({ queryKey: ['planner'] });
  void queryClient.invalidateQueries({ queryKey: ['daybook'] });
  void queryClient.invalidateQueries({ queryKey: ['events'] });
  setConnectivity(snapshot.errors.length ? 'SYNC_ERROR' : 'ONLINE');
}

export async function retryOp(operationId: string): Promise<void> {
  const db = await offlineDb();
  const op = await db.get('queue', operationId);
  if (op) await db.put('queue', { ...op, status: 'pending', error: undefined });
  await replayQueue();
}

export async function discardOp(operationId: string): Promise<void> {
  await (await offlineDb()).delete('queue', operationId);
  await refreshQueueState();
  if (!snapshot.errors.length && getConnectivity() === 'SYNC_ERROR') setConnectivity('ONLINE');
}

/** Conflict: accept the server's copy and drop the local change. */
export async function keepServer(operationId: string): Promise<void> {
  await (await offlineDb()).delete('conflicts', operationId);
  void queryClient.invalidateQueries({ queryKey: ['planner'] });
  await refreshQueueState();
}

/** Conflict: re-read the latest version and apply the local change on top of it. */
export async function applyMineAgain(operationId: string): Promise<void> {
  const db = await offlineDb();
  const c = await db.get('conflicts', operationId);
  if (!c) return;
  const taskId = String(c.op.payload.taskId);
  const latest = await api.get<TaskDetail>(`/planner/tasks/${taskId}`);
  await api.patch(`/planner/tasks/${taskId}`, {
    ...(c.op.payload.patch as object),
    version: latest.version,
  });
  await db.delete('conflicts', operationId);
  void queryClient.invalidateQueries({ queryKey: ['planner'] });
  await refreshQueueState();
}
