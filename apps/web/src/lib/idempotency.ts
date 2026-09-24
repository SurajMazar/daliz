import { useCallback, useRef } from 'react';
import { isApiError } from './api';

/**
 * One Idempotency-Key per form submission. A retry of the *same* submission (identical body
 * after a network or server failure) reuses the key so the server replays instead of creating
 * a duplicate; any new submission — or a changed body — gets a fresh key.
 */
export function useIdempotencyKey() {
  const last = useRef<{ key: string; body: string; retryable: boolean } | null>(null);

  const keyFor = useCallback((body: unknown): string => {
    const serialized = JSON.stringify(body ?? null);
    const prev = last.current;
    if (prev && prev.retryable && prev.body === serialized) return prev.key;
    const key = crypto.randomUUID();
    last.current = { key, body: serialized, retryable: false };
    return key;
  }, []);

  /** Call after a failed attempt; only network/5xx failures keep the key for a retry. */
  const failed = useCallback((error: unknown) => {
    if (!last.current) return;
    last.current.retryable = !isApiError(error) || error.status === 0 || error.status >= 500;
  }, []);

  const succeeded = useCallback(() => {
    last.current = null;
  }, []);

  return { keyFor, failed, succeeded };
}

/**
 * Runs a mutation with an idempotency key tied to its body; use with useIdempotencyKey().
 */
export async function withIdempotency<T>(
  idem: ReturnType<typeof useIdempotencyKey>,
  body: unknown,
  run: (key: string) => Promise<T>,
): Promise<T> {
  const key = idem.keyFor(body);
  try {
    const result = await run(key);
    idem.succeeded();
    return result;
  } catch (e) {
    idem.failed(e);
    throw e;
  }
}
