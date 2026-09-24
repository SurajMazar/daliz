import { recoveryCodeSchema, totpCodeSchema, type LoginResponse } from '@daliz/shared';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { FullPageSpinner } from '@/components/ui/spinner';
import { api, errorMessage, setCsrfToken } from '@/lib/api';
import { refreshMe, useMe, useSignOut } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';
import { AuthCard } from './auth-layout';
import { useNextPath } from './use-next';

export function MfaChallengePage() {
  useDocumentTitle('Two-factor authentication');
  const me = useMe();
  const navigate = useNavigate();
  const next = useNextPath();
  const signOut = useSignOut();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (me.isPending) return <FullPageSpinner />;
  if (!me.data) return <Navigate to="/login" replace />;
  if (me.data.stage === 'active' && !pending) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = (useRecovery ? recoveryCodeSchema : totpCodeSchema).safeParse(value);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Invalid code');
      return;
    }
    setFieldError(null);
    setPending(true);
    try {
      const res = await api.post<LoginResponse>('/auth/mfa/verify', useRecovery ? { recoveryCode: parsed.data } : { code: parsed.data }, { silent: true });
      setCsrfToken(res.csrfToken);
      await refreshMe();
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setValue('');
      setPending(false);
    }
  };

  return (
    <AuthCard
      title="Two-factor authentication"
      description={
        useRecovery
          ? 'Enter one of the recovery codes you saved when you set up two-factor authentication.'
          : `Enter the 6-digit code from your authenticator app for ${me.data.account.email}.`
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {error ? <Alert variant="destructive" title={error} /> : null}
        {useRecovery ? (
          <FormField key="recovery" label="Recovery code" error={fieldError ?? undefined}>
            <Input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="abcde-12345"
              className="font-mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </FormField>
        ) : (
          <FormField key="totp" label="Authentication code" error={fieldError ?? undefined}>
            <Input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              className="text-center font-mono text-lg tracking-[0.4em]"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
            />
          </FormField>
        )}
        <Button type="submit" className="w-full" loading={pending}>
          Verify
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Button
            variant="link"
            onClick={() => {
              setUseRecovery((v) => !v);
              setValue('');
              setFieldError(null);
              setError(null);
            }}
          >
            {useRecovery ? 'Use authenticator app' : 'Use a recovery code'}
          </Button>
          <Button variant="link" className="text-muted-foreground" onClick={() => signOut.mutate()}>
            Use a different account
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
