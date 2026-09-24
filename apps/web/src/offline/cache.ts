import { isApiError } from '@/lib/api';
import { isOffline, setConnectivity } from './connectivity';
import { getOfflineScope, offlineDb } from './db';

export function isNetworkError(e: unknown): boolean {
  return (isApiError(e) && e.status === 0) || e instanceof TypeError;
}

async function read(key: string) {
  try {
    return await (await offlineDb()).get('cache', key);
  } catch {
    return undefined;
  }
}

async function write(key: string, scope: string, data: unknown) {
  try {
    await (await offlineDb()).put('cache', { key, scope, data, updatedAt: Date.now() });
  } catch {
    // Quota or private mode: caching is best-effort.
  }
}

/**
 * Query function wrapper for the offline data layer: successful responses are stored in
 * IndexedDB under the current tenant/user scope; when offline (or the network fails) the
 * last stored copy is returned instead.
 */
export async function cachedQuery<T>(queryKey: readonly unknown[], fn: () => Promise<T>): Promise<T> {
  const scope = getOfflineScope();
  if (!scope) return fn();
  const key = `${scope}|${JSON.stringify(queryKey)}`;
  if (isOffline()) {
    const hit = await read(key);
    if (hit) return hit.data as T;
  }
  try {
    const data = await fn();
    void write(key, scope, data);
    return data;
  } catch (e) {
    if (isNetworkError(e)) {
      setConnectivity('OFFLINE');
      const hit = await read(key);
      if (hit && hit.scope === scope) return hit.data as T;
    }
    throw e;
  }
}
