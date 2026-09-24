/**
 * IndexedDB for offline use. Every record carries a scope of `${tenantId}:${userId}` and is
 * only ever read back under the same scope, so workspaces and users never see each other's
 * data. Other scopes are wiped on tenant switch; everything is wiped on sign-out.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface CacheRecord {
  key: string;
  scope: string;
  data: unknown;
  updatedAt: number;
}

export type QueuedOpType =
  'task.create' | 'task.update' | 'task.comment' | 'reminder.create' | 'daybook.create';

export interface QueuedOp {
  operationId: string;
  scope: string;
  type: QueuedOpType;
  /** Short human description for the sync centre. */
  label: string;
  payload: Record<string, unknown>;
  createdAt: number;
  status: 'pending' | 'error';
  error?: string;
}

export interface ConflictRecord {
  operationId: string;
  scope: string;
  op: QueuedOp;
  server: Record<string, unknown> | null;
  createdAt: number;
}

interface OfflineSchema extends DBSchema {
  cache: { key: string; value: CacheRecord; indexes: { scope: string } };
  queue: { key: string; value: QueuedOp; indexes: { scope: string } };
  conflicts: { key: string; value: ConflictRecord; indexes: { scope: string } };
}

let dbPromise: Promise<IDBPDatabase<OfflineSchema>> | null = null;

export function offlineDb(): Promise<IDBPDatabase<OfflineSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineSchema>('daliz-offline', 1, {
      upgrade(db) {
        db.createObjectStore('cache', { keyPath: 'key' }).createIndex('scope', 'scope');
        db.createObjectStore('queue', { keyPath: 'operationId' }).createIndex('scope', 'scope');
        db.createObjectStore('conflicts', { keyPath: 'operationId' }).createIndex('scope', 'scope');
      },
    });
  }
  return dbPromise;
}

let currentScope: string | null = null;
const scopeListeners = new Set<() => void>();

export function getOfflineScope(): string | null {
  return currentScope;
}

export function onScopeChange(fn: () => void): () => void {
  scopeListeners.add(fn);
  return () => scopeListeners.delete(fn);
}

/** Sets the active tenant/user scope and deletes cached data of any other scope. */
export async function setOfflineScope(scope: string | null): Promise<void> {
  if (scope === currentScope) return;
  currentScope = scope;
  scopeListeners.forEach((l) => l());
  try {
    const db = await offlineDb();
    const tx = db.transaction(['cache', 'queue', 'conflicts'], 'readwrite');
    for (const store of ['cache', 'queue', 'conflicts'] as const) {
      let cursor = await tx.objectStore(store).openCursor();
      while (cursor) {
        if (cursor.value.scope !== scope) await cursor.delete();
        cursor = await cursor.continue();
      }
    }
    await tx.done;
  } catch {
    // IndexedDB unavailable (private mode): offline features degrade gracefully.
  }
}

/** Sign-out: nothing may survive for the next person on this device. */
export async function clearOfflineData(): Promise<void> {
  currentScope = null;
  scopeListeners.forEach((l) => l());
  try {
    const db = await offlineDb();
    await Promise.all([db.clear('cache'), db.clear('queue'), db.clear('conflicts')]);
  } catch {
    // ignore
  }
}
