import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

export type ConnectivityState = 'ONLINE' | 'OFFLINE' | 'RECONNECTING' | 'SYNCING' | 'SYNC_ERROR';

let state: ConnectivityState =
  typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'ONLINE';
const listeners = new Set<() => void>();

export function getConnectivity(): ConnectivityState {
  return state;
}

export function setConnectivity(next: ConnectivityState): void {
  if (next === state) return;
  state = next;
  // Keep TanStack Query in step: while OFFLINE, query retries pause (cached data is served
  // from IndexedDB) and resume as soon as the connection is confirmed again.
  onlineManager.setOnline(next !== 'OFFLINE');
  listeners.forEach((l) => l());
}

export function isOffline(): boolean {
  return state === 'OFFLINE' || (typeof navigator !== 'undefined' && !navigator.onLine);
}

export function subscribeConnectivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(subscribeConnectivity, getConnectivity, getConnectivity);
}

export function useIsOffline(): boolean {
  const s = useConnectivity();
  return s === 'OFFLINE';
}
