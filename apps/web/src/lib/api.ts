/**
 * The one HTTP client for the Daliz API.
 *
 *  - Parses the { success, data, meta } / { success: false, error } envelope.
 *  - Sends the session-bound CSRF token (kept in memory only) on every mutation.
 *  - CSRF_FAILED → refetches /auth/me for a fresh token and retries once.
 *  - STEP_UP_REQUIRED → asks the registered step-up handler (a dialog) to re-authenticate,
 *    then retries the original request once.
 *  - Every other error is surfaced as an ApiError and broadcast to global listeners, which
 *    handle cross-cutting codes (sign-in, MFA, workspace selection, maintenance, toasts).
 */
import type { ApiErrorBody, ErrorCode, MeResponse, PageMeta } from '@daliz/shared';
import { setConnectivity } from '@/offline/connectivity';
import { getPlatform } from '@/platform';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: { path: string; message: string }[];

  constructor(init: {
    code: ErrorCode;
    status: number;
    message: string;
    requestId?: string | null;
    details?: { path: string; message: string }[];
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? [];
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function errorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// In-memory CSRF token (never persisted — a reload refetches it from /auth/me)
// ---------------------------------------------------------------------------

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

// ---------------------------------------------------------------------------
// Hooks registered by the UI
// ---------------------------------------------------------------------------

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
let pendingStepUp: Promise<boolean> | null = null;

export function registerStepUpHandler(handler: StepUpHandler | null): void {
  stepUpHandler = handler;
}

function requestStepUp(): Promise<boolean> {
  if (!stepUpHandler) return Promise.resolve(false);
  // Several requests failing at once share one dialog.
  if (!pendingStepUp) {
    pendingStepUp = stepUpHandler().finally(() => {
      pendingStepUp = null;
    });
  }
  return pendingStepUp;
}

type ErrorListener = (error: ApiError, context: { path: string; method: string }) => void;
const listeners = new Set<ErrorListener>();

export function onApiError(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Request core
// ---------------------------------------------------------------------------

export function clientPlatform(): 'web' | 'pwa' | 'desktop' {
  const p = getPlatform();
  return p === 'DESKTOP' ? 'desktop' : p === 'PWA' ? 'pwa' : 'web';
}

const OFFLINE_MESSAGE = 'You’re offline. This action needs a connection.';

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  query?: Query;
  signal?: AbortSignal;
  /** Don't broadcast errors to global listeners (the caller handles every outcome). */
  silent?: boolean;
  /** Don't open the step-up dialog on STEP_UP_REQUIRED. */
  skipStepUp?: boolean;
  /** Sent as Idempotency-Key; the same key is reused by the client's automatic retries. */
  idempotencyKey?: string;
}

interface Envelope<T> {
  data: T;
  meta?: PageMeta;
}

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'RESOURCE_NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

async function refreshCsrf(): Promise<void> {
  const res = await fetch(buildUrl('/auth/me'), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-Daliz-Client': clientPlatform() },
  });
  if (!res.ok) return;
  const json = (await res.json()) as { success: boolean; data?: MeResponse };
  if (json.success && json.data) setCsrfToken(json.data.csrfToken);
}

function toApiError(status: number, json: unknown, requestIdHeader: string | null): ApiError {
  const errBody = (json as ApiErrorBody | null)?.error;
  return new ApiError({
    code: errBody?.code ?? STATUS_FALLBACK[status] ?? 'INTERNAL_ERROR',
    status,
    message: errBody?.message ?? (status >= 500 ? 'Something went wrong. Please try again.' : 'The request failed.'),
    requestId: errBody?.requestId ?? requestIdHeader,
    details: errBody?.details,
  });
}

async function send<T>(path: string, opts: RequestOptions, attempt: { csrf: boolean; stepUp: boolean }): Promise<Envelope<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Daliz-Client': clientPlatform(),
  };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  if (method !== 'GET' && typeof navigator !== 'undefined' && !navigator.onLine) {
    setConnectivity('OFFLINE');
    throw new ApiError({ code: 'SERVICE_UNAVAILABLE', status: 0, message: OFFLINE_MESSAGE });
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    setConnectivity('OFFLINE');
    throw new ApiError({
      code: 'SERVICE_UNAVAILABLE',
      status: 0,
      message: 'Can’t reach Daliz. Check your connection and try again.',
    });
  }

  // A gateway error means the API itself is unreachable (restarting, network down).
  if (res.status === 502 || res.status === 504) {
    setConnectivity('OFFLINE');
    throw new ApiError({ code: 'SERVICE_UNAVAILABLE', status: 0, message: 'Can’t reach Daliz right now. Try again in a moment.' });
  }

  let json: unknown = null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      json = await res.json();
    } catch {
      json = null;
    }
  }

  if (res.ok && json && typeof json === 'object' && (json as { success?: unknown }).success === true) {
    const ok = json as { data: T; meta?: PageMeta };
    return { data: ok.data, meta: ok.meta };
  }

  const error = toApiError(res.status, json, res.headers.get('x-request-id'));

  if (error.code === 'CSRF_FAILED' && !attempt.csrf) {
    await refreshCsrf();
    return send<T>(path, opts, { ...attempt, csrf: true });
  }
  if (error.code === 'STEP_UP_REQUIRED' && !attempt.stepUp && !opts.skipStepUp) {
    const confirmed = await requestStepUp();
    if (confirmed) return send<T>(path, opts, { ...attempt, stepUp: true });
  }

  if (!opts.silent) {
    for (const l of listeners) {
      try {
        l(error, { path, method });
      } catch {
        // Listener failures must never mask the original error.
      }
    }
  }
  throw error;
}

function broadcast(error: ApiError, path: string, method: string): void {
  for (const l of listeners) {
    try {
      l(error, { path, method });
    } catch {
      // ignore
    }
  }
}

/**
 * Multipart upload with progress (fetch has no upload progress). Same headers, envelope
 * parsing and CSRF retry as `request`.
 */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  retried = false,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Daliz-Client', clientPlatform());
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    opts.signal?.addEventListener('abort', () => xhr.abort());
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onerror = () =>
      reject(new ApiError({ code: 'SERVICE_UNAVAILABLE', status: 0, message: 'Can’t reach Daliz. Check your connection and try again.' }));
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && (json as { success?: boolean } | null)?.success) {
        resolve((json as { data: T }).data);
        return;
      }
      const error = toApiError(xhr.status, json, xhr.getResponseHeader('x-request-id'));
      if (error.code === 'CSRF_FAILED' && !retried) {
        void refreshCsrf().then(() => uploadWithProgress<T>(path, form, opts, true).then(resolve, reject));
        return;
      }
      broadcast(error, path, 'POST');
      reject(error);
    };
    xhr.send(form);
  });
}

export function request<T>(path: string, opts: RequestOptions = {}): Promise<Envelope<T>> {
  return send<T>(path, opts, { csrf: false, stepUp: false });
}

export interface ListResult<T> {
  items: T[];
  meta: PageMeta;
}

type Opts = Omit<RequestOptions, 'method' | 'body' | 'query'>;

export const api = {
  get: <T>(path: string, query?: Query, opts?: Opts) => request<T>(path, { ...opts, query }).then((r) => r.data),
  list: <T>(path: string, query?: Query, opts?: Opts): Promise<ListResult<T>> =>
    request<T[]>(path, { ...opts, query }).then((r) => ({
      items: r.data,
      meta: r.meta ?? { page: 1, pageSize: r.data.length, total: r.data.length },
    })),
  post: <T>(path: string, body?: unknown, opts?: Opts) =>
    request<T>(path, { ...opts, method: 'POST', body: body ?? {} }).then((r) => r.data),
  put: <T>(path: string, body?: unknown, opts?: Opts) =>
    request<T>(path, { ...opts, method: 'PUT', body: body ?? {} }).then((r) => r.data),
  patch: <T>(path: string, body?: unknown, opts?: Opts) =>
    request<T>(path, { ...opts, method: 'PATCH', body: body ?? {} }).then((r) => r.data),
  delete: <T>(path: string, opts?: Opts) => request<T>(path, { ...opts, method: 'DELETE' }).then((r) => r.data),
  upload: <T>(path: string, form: FormData, opts?: Opts) =>
    request<T>(path, { ...opts, method: 'POST', form }).then((r) => r.data),
};
