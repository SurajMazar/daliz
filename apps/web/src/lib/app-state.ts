import { useSyncExternalStore } from 'react';

/** Tiny global store for app-wide conditions that aren't server state. */
interface AppState {
  maintenance: string | null;
}

let state: AppState = { maintenance: null };
const subscribers = new Set<() => void>();

export function setAppState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const s of subscribers) s();
}

export function useAppState(): AppState {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => state,
  );
}
