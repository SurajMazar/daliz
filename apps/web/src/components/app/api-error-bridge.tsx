import { useEffect } from 'react';
import { toast } from 'sonner';
import { onApiError, setCsrfToken } from '@/lib/api';
import { setAppState } from '@/lib/app-state';
import { navigateTo } from '@/lib/navigation';
import { queryClient } from '@/lib/query-client';
import { ME_KEY, refreshMe } from '@/lib/session';

/** Handles cross-cutting API error codes in one place. */
export function ApiErrorBridge() {
  useEffect(
    () =>
      onApiError((err) => {
        switch (err.code) {
          case 'UNAUTHENTICATED':
            // Route guards react to the signed-out session and send the user to /login.
            setCsrfToken(null);
            queryClient.setQueryData(ME_KEY, null);
            if (err.message && err.message !== 'Sign in to continue.') toast.info(err.message);
            break;
          case 'MFA_REQUIRED':
            void refreshMe().finally(() => navigateTo('/login/mfa', { replace: true }));
            break;
          case 'MFA_ENROLLMENT_REQUIRED':
            void refreshMe().finally(() => navigateTo('/mfa/setup', { replace: true }));
            break;
          case 'TENANT_REQUIRED':
            void refreshMe().finally(() => navigateTo('/select-workspace', { replace: true }));
            break;
          case 'TENANT_UNAVAILABLE':
          case 'TENANT_DOMAIN_MISMATCH':
            toast.error(err.message);
            void refreshMe().finally(() => navigateTo('/select-workspace', { replace: true }));
            break;
          case 'MAINTENANCE_MODE':
            setAppState({ maintenance: err.message });
            break;
          case 'VERSION_CONFLICT':
            toast.error(err.message, {
              id: 'version-conflict',
              action: { label: 'Reload', onClick: () => void queryClient.invalidateQueries() },
            });
            break;
          case 'RATE_LIMITED':
            toast.error(err.message, { id: 'rate-limited' });
            break;
          case 'SUPPORT_SESSION_READ_ONLY':
            toast.error(err.message, { id: 'support-read-only', description: 'Start a support session with write access to make changes.' });
            break;
          case 'FORBIDDEN':
            // Support session ended or membership removed: the shell must re-evaluate.
            if (/support session has ended|no longer have access/i.test(err.message)) void refreshMe();
            break;
          default:
            break;
        }
      }),
    [],
  );
  return null;
}
