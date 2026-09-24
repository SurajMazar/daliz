import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { passwordSchema, personNameSchema, type LoginResponse } from '@daliz/shared';
import { MailOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, setCsrfToken } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { queryClient } from '@/lib/query-client';
import { ME_KEY, refreshMe, useMe } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';
import { formatDateTime } from '@/lib/utils';
import { AuthCard } from './auth-layout';
import { PasswordInput } from './password-input';

interface InvitationInfo {
  email: string;
  name: string;
  workspaceName: string;
  kind: string;
  accountExists: boolean;
  expiresAt: string;
}

const setupSchema = z
  .object({ name: personNameSchema, password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords don’t match' });

export function AcceptInvitePage() {
  useDocumentTitle('Accept invitation');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const me = useMe();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const invite = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.post<InvitationInfo>('/auth/invitations/describe', { token }, { silent: true }),
    enabled: token.length >= 20,
    retry: false,
    staleTime: Infinity,
  });

  const form = useForm<z.input<typeof setupSchema>, unknown, z.output<typeof setupSchema>>({
    resolver: zodResolver(setupSchema),
    defaultValues: { name: '', password: '', confirm: '' },
  });
  useEffect(() => {
    if (invite.data?.name && !form.getValues('name')) form.setValue('name', invite.data.name);
  }, [invite.data, form]);

  const finish = async () => {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'public-branding' });
    await refreshMe();
    navigate('/', { replace: true });
  };

  if (token.length < 20) {
    return (
      <AuthCard title="Invalid invitation link">
        <Alert variant="destructive" title="This invitation link is incomplete or invalid." />
      </AuthCard>
    );
  }
  if (invite.isPending) {
    return (
      <AuthCard title="Loading invitation…">
        <div className="grid gap-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </AuthCard>
    );
  }
  if (invite.isError) {
    return (
      <AuthCard title="Invitation unavailable">
        <Alert variant="destructive" title={errorMessage(invite.error)}>
          Ask the person who invited you to send a new invitation.
        </Alert>
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  const info = invite.data;
  const intro = (
    <Alert variant="info" icon={<MailOpen aria-hidden />} title={`You’ve been invited to ${info.workspaceName}`} className="mb-5">
      Invitation for <strong className="text-foreground">{info.email}</strong> · expires {formatDateTime(info.expiresAt)}
    </Alert>
  );

  // New account: choose a name and password; accepting signs you in.
  if (!info.accountExists) {
    const onSubmit = form.handleSubmit(async (values) => {
      setError(null);
      try {
        const res = await api.post<LoginResponse>('/auth/invitations/accept', { token, name: values.name, password: values.password }, { silent: true });
        setCsrfToken(res.csrfToken);
        await finish();
      } catch (e) {
        if (!applyServerErrors(e, form.setError, ['name', 'password'], { toastUnmatched: false })) setError(errorMessage(e));
      }
    });
    return (
      <AuthCard title="Set up your account" description="Choose your name and a password to join.">
        {intro}
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <FormField label="Email">
            <Input value={info.email} readOnly disabled autoComplete="username" />
          </FormField>
          <FormField label="Full name" error={form.formState.errors.name?.message} required>
            <Input autoComplete="name" autoFocus {...form.register('name')} />
          </FormField>
          <FormField label="Password" hint="At least 12 characters." error={form.formState.errors.password?.message} required>
            <PasswordInput autoComplete="new-password" {...form.register('password')} />
          </FormField>
          <FormField label="Confirm password" error={form.formState.errors.confirm?.message} required>
            <PasswordInput autoComplete="new-password" {...form.register('confirm')} />
          </FormField>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            Accept and join
          </Button>
        </form>
      </AuthCard>
    );
  }

  // Existing account: must be signed in as the invitee, then accept with CSRF.
  const signedInAs = me.data?.stage === 'active' ? me.data.account.email : null;
  const nextUrl = `/accept-invite?token=${encodeURIComponent(token)}`;

  if (signedInAs && signedInAs.toLowerCase() === info.email.toLowerCase()) {
    const join = async () => {
      setError(null);
      setJoining(true);
      try {
        await api.post('/auth/invitations/accept', { token }, { silent: true });
        await finish();
      } catch (e) {
        setError(errorMessage(e));
        setJoining(false);
      }
    };
    return (
      <AuthCard title={`Join ${info.workspaceName}`}>
        {intro}
        {error ? <Alert variant="destructive" title={error} className="mb-4" /> : null}
        <Button className="w-full" onClick={join} loading={joining}>
          Accept invitation
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in to accept">
      {intro}
      {signedInAs ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            You’re signed in as <strong className="text-foreground">{signedInAs}</strong>. Sign out, then sign in as{' '}
            <strong className="text-foreground">{info.email}</strong> to accept this invitation.
          </p>
          <Button
            className="w-full"
            loading={switching}
            onClick={async () => {
              setSwitching(true);
              await api.post('/auth/logout', {}, { silent: true }).catch(() => undefined);
              setCsrfToken(null);
              queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'public-branding' && q.queryKey[0] !== 'invitation' });
              queryClient.setQueryData(ME_KEY, null);
              navigate(`/login?next=${encodeURIComponent(nextUrl)}`);
            }}
          >
            Sign out and switch account
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{info.email}</strong> already has a Daliz account. Sign in with it to accept.
          </p>
          <Button asChild className="w-full">
            <Link to={`/login?next=${encodeURIComponent(nextUrl)}`}>Sign in as {info.email}</Link>
          </Button>
        </div>
      )}
    </AuthCard>
  );
}
