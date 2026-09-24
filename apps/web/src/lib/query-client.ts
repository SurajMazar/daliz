import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { ErrorCode } from '@daliz/shared';
import { toast } from 'sonner';
import { errorMessage, isApiError } from './api';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** The component shows this mutation's errors itself (inline alert / field errors). */
      silent?: boolean;
    };
  }
}

/** Codes the global API listener already handles (navigation or its own toast). */
export const GLOBALLY_HANDLED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'MFA_ENROLLMENT_REQUIRED',
  'TENANT_REQUIRED',
  'TENANT_UNAVAILABLE',
  'MAINTENANCE_MODE',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'SUPPORT_SESSION_READ_ONLY',
]);

export const queryClient = new QueryClient({
  queryCache: new QueryCache(),
  mutationCache: new MutationCache({
    onError: (error, _vars, _res, mutation) => {
      if (mutation.meta?.silent) return;
      if (isApiError(error) && GLOBALLY_HANDLED.has(error.code)) return;
      // A dismissed step-up dialog leaves STEP_UP_REQUIRED; say what happened.
      if (isApiError(error) && error.code === 'STEP_UP_REQUIRED') {
        toast.error('Action cancelled', { description: 'You need to confirm your identity to do that.' });
        return;
      }
      const details = isApiError(error) && error.details.length ? error.details.map((d) => d.message).join(' · ') : undefined;
      toast.error(errorMessage(error), details ? { description: details } : undefined);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (isApiError(error)) return (error.status === 0 || error.status >= 500) && failureCount < 2;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});
