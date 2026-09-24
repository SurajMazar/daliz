import type { PlatformPermission, TenantPermission } from '@daliz/shared';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { Button } from '@/components/ui/button';
import { FullPageSpinner } from '@/components/ui/spinner';
import { useAccess, useMe } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';

/**
 * Requires a fully authenticated session. Sends signed-out users to /login (remembering
 * where they were going), half-authenticated users to the MFA challenge, and accounts that
 * must enrol in MFA to the forced enrolment screen.
 */
export function RequireSession({ allowEnrollment = false }: { allowEnrollment?: boolean }) {
  const { data: me, isPending, error, refetch } = useMe();
  const location = useLocation();

  if (isPending) return <FullPageSpinner />;
  if (error && me === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState
          error={error}
          onRetry={() => void refetch()}
          title="Couldn’t load your session"
        />
      </div>
    );
  }
  if (!me) {
    const next = location.pathname + location.search;
    return (
      <Navigate
        to={next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'}
        replace
      />
    );
  }
  if (me.stage === 'mfa_pending') return <Navigate to="/login/mfa" replace />;
  if (me.mustEnrollMfa && !allowEnrollment) return <Navigate to="/mfa/setup" replace />;
  return <Outlet />;
}

export function NoAccess({ what = 'this page' }: { what?: string }) {
  useDocumentTitle('No access');
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="size-5" aria-hidden />
      </div>
      <h1 className="text-lg font-semibold">You don’t have access to {what}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Ask a workspace administrator to grant you the required permission.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}

export function RequirePermission({
  perm,
  children,
}: {
  perm: TenantPermission;
  children: ReactNode;
}) {
  const { can } = useAccess();
  return can(perm) ? <>{children}</> : <NoAccess />;
}

export function RequirePlatformPermission({
  perm,
  children,
}: {
  perm: PlatformPermission;
  children: ReactNode;
}) {
  const { canPlatform } = useAccess();
  return canPlatform(perm) ? <>{children}</> : <NoAccess />;
}
