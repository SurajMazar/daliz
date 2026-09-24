import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { ME_KEY, useMe } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';
import { AuthCard } from './auth-layout';

export function VerifyEmailPage() {
  useDocumentTitle('Verify email');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const me = useMe();
  const started = useRef(false);
  const verify = useMutation({
    mutationFn: () => api.post('/auth/email/verify', { token }, { silent: true }),
    meta: { silent: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });

  useEffect(() => {
    if (started.current || token.length < 20) return;
    started.current = true;
    verify.mutate();
  }, [token, verify]);

  const home = me.data?.stage === 'active' ? '/' : '/login';

  return (
    <AuthCard title="Verify your email">
      {token.length < 20 ? (
        <Alert variant="destructive" title="This verification link is incomplete or invalid." />
      ) : verify.isSuccess ? (
        <Alert variant="success" title="Your email address is verified.">
          Thanks! You can close this tab or continue to Daliz.
        </Alert>
      ) : verify.isError ? (
        <Alert variant="destructive" title={errorMessage(verify.error)}>
          You can request a new verification email from your account page.
        </Alert>
      ) : (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Verifying your email…
        </div>
      )}
      <Button asChild variant="outline" className="mt-5 w-full">
        <Link to={home}>{home === '/' ? 'Continue' : 'Go to sign in'}</Link>
      </Button>
    </AuthCard>
  );
}
