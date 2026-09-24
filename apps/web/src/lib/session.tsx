import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, PlatformPermission, TenantPermission } from '@daliz/shared';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { api, isApiError, setCsrfToken } from './api';
import { setAppState } from './app-state';
import { navigateTo } from './navigation';
import { queryClient } from './query-client';

export const ME_KEY = ['me'] as const;

/** Loads the session. Resolves to null when signed out (never throws UNAUTHENTICATED). */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    const me = await api.get<MeResponse>('/auth/me', undefined, { silent: true });
    setCsrfToken(me.csrfToken);
    setAppState({ maintenance: null });
    return me;
  } catch (e) {
    if (isApiError(e) && e.code === 'UNAUTHENTICATED') {
      setCsrfToken(null);
      return null;
    }
    if (isApiError(e) && e.code === 'MAINTENANCE_MODE') setAppState({ maintenance: e.message });
    throw e;
  }
}

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 60_000, refetchOnWindowFocus: true });
}

/** Refetches /auth/me and returns the fresh value. */
export function refreshMe(): Promise<MeResponse | null> {
  return queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 0 });
}

/** The signed-in session. Only use below a route guard that guarantees one. */
export function useSession(): MeResponse {
  const { data } = useMe();
  if (!data) throw new Error('useSession() used without an active session');
  return data;
}

export interface Access {
  me: MeResponse;
  /** Holds the tenant permission. */
  can: (p: TenantPermission) => boolean;
  canPlatform: (p: PlatformPermission) => boolean;
  /** A read-only support session is active: every mutation is refused server-side. */
  readOnly: boolean;
  /** Holds the permission AND may mutate (not in a read-only support session). */
  canWrite: (p: TenantPermission) => boolean;
}

export function useAccess(): Access {
  const me = useSession();
  return useMemo(() => {
    const tenantPerms = new Set<string>(me.tenant?.permissions ?? []);
    const platformPerms = new Set<string>(me.platform?.permissions ?? []);
    const readOnly = !!me.support && !me.support.allowWrite;
    return {
      me,
      can: (p) => tenantPerms.has(p),
      canPlatform: (p) => platformPerms.has(p),
      readOnly,
      canWrite: (p) => !readOnly && tenantPerms.has(p),
    };
  }, [me]);
}

function afterSignOut(message?: string) {
  setCsrfToken(null);
  queryClient.clear();
  queryClient.setQueryData(ME_KEY, null);
  navigateTo('/login', { replace: true });
  if (message) toast.success(message);
}

export function useSignOut() {
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/auth/logout'),
    onSettled: () => afterSignOut(),
  });
}

export function useSignOutEverywhere() {
  return useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/auth/logout-all'),
    onSuccess: (r) => afterSignOut(`Signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`),
  });
}

/** Switches the session's active workspace, drops every cached tenant query and reloads the shell. */
export function useSwitchWorkspace() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (tenantId: string) => api.post<{ ok: true }>('/auth/tenant', { tenantId }),
    onSuccess: async () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
      await refreshMe();
      navigateTo('/', { replace: true });
    },
  });
  const switchTo = useCallback((tenantId: string) => mutation.mutateAsync(tenantId), [mutation]);
  return { ...mutation, switchTo };
}
