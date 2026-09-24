import { AsyncLocalStorage } from 'node:async_hooks';
import type { PlatformPermission, PlatformRoleKey, TenantPermission } from '@daliz/shared';
import type { TenantDb } from '../database/tenant/tenant-db.js';
import { Errors } from './errors.js';

export interface SessionPrincipal {
  sessionId: string;
  accountId: string;
  email: string;
  name: string;
  stage: 'mfa_pending' | 'active';
  mfaEnabled: boolean;
  activeTenantId: string | null;
  supportSessionId: string | null;
  stepUpUntil: Date | null;
}

export interface PlatformPrincipal {
  role: PlatformRoleKey;
  permissions: ReadonlySet<PlatformPermission>;
}

export type TenantActor =
  | { type: 'user'; userId: string; accountId: string; email: string }
  | {
      type: 'support';
      accountId: string;
      email: string;
      supportSessionId: string;
      allowWrite: boolean;
    }
  | { type: 'api_key'; keyId: string; name: string };

export interface ApiKeyPrincipal {
  keyId: string;
  tenantId: string;
  name: string;
  scopes: string[];
}

export interface TenantContext {
  tenantId: string;
  slug: string;
  name: string;
  db: TenantDb;
  actor: TenantActor;
  permissions: ReadonlySet<TenantPermission>;
}

export interface RequestContextStore {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  host: string | null;
  /** Tenant resolved from the request's Host (custom domain / subdomain), if any. */
  domainTenantId?: string | null;
  session?: SessionPrincipal;
  apiKey?: ApiKeyPrincipal;
  platform?: PlatformPrincipal | null;
  tenant?: TenantContext;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },
  require(): RequestContextStore {
    const store = storage.getStore();
    if (!store) throw new Error('RequestContext is not available outside a request/job scope');
    return store;
  },
  session(): SessionPrincipal {
    const s = storage.getStore()?.session;
    if (!s) throw Errors.unauthenticated();
    return s;
  },
  /**
   * The current tenant. Throws if called outside a tenant-scoped request or job, which makes
   * "forgot to resolve the tenant" a loud failure rather than a silent cross-tenant query.
   */
  tenant(): TenantContext {
    const t = storage.getStore()?.tenant;
    if (!t) throw Errors.tenantRequired();
    return t;
  },
};
