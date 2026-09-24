import { ShieldCheck } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { refreshMe, useSession, useSignOut } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';
import { AuthCard } from './auth-layout';
import { MfaEnrollment } from './mfa-enrollment';

/** Forced enrolment: shown when the platform or workspace policy requires MFA. */
export function MfaEnrollPage() {
  useDocumentTitle('Set up two-factor authentication');
  const me = useSession();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [inProgress] = useState(() => !me.account.mfaEnabled);

  if (me.account.mfaEnabled && !inProgress) return <Navigate to="/" replace />;

  const reason = me.platform
    ? 'Platform administrators must use two-factor authentication.'
    : me.tenant
      ? `${me.tenant.name} requires two-factor authentication for everyone.`
      : 'Your organization requires two-factor authentication.';

  return (
    <AuthCard
      wide
      title="Set up two-factor authentication"
      description={
        <span className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>{reason} This keeps your account safe even if your password is compromised.</span>
        </span>
      }
    >
      <MfaEnrollment
        email={me.account.email}
        onComplete={async () => {
          await refreshMe();
          navigate('/', { replace: true });
        }}
      />
      <div className="mt-6 border-t pt-4 text-center">
        <Button variant="link" className="text-muted-foreground" onClick={() => signOut.mutate()}>
          Sign out ({me.account.email})
        </Button>
      </div>
    </AuthCard>
  );
}
