import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginResponse } from '@daliz/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router';
import type { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { FullPageSpinner } from '@/components/ui/spinner';
import { usePublicBranding } from '@/features/branding/api';
import { api, ApiError, errorMessage, setCsrfToken } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { refreshMe, useMe } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';
import { AuthCard } from './auth-layout';
import { PasswordInput } from './password-input';
import { useNextPath } from './use-next';

type Values = z.input<typeof loginSchema>;

export function LoginPage() {
  useDocumentTitle('Sign in');
  const navigate = useNavigate();
  const next = useNextPath();
  const me = useMe();
  const branding = usePublicBranding();
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const form = useForm<Values, unknown, z.output<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  if (me.isPending) return <FullPageSpinner />;
  if (me.data?.stage === 'active' && !form.formState.isSubmitting) return <Navigate to={next} replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api.post<LoginResponse>('/auth/login', values, { silent: true });
      setCsrfToken(res.csrfToken);
      // A new session: nothing cached from a previous one may leak into it.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'public-branding' });
      await refreshMe();
      const suffix = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
      navigate(res.stage === 'mfa_pending' ? `/login/mfa${suffix}` : next, { replace: true });
    } catch (e) {
      setError({ message: errorMessage(e), requestId: e instanceof ApiError && e.status >= 500 ? e.requestId : null });
      form.setValue('password', '');
      form.setFocus('password');
    }
  });

  return (
    <AuthCard title={branding.data?.tenantId ? `Sign in to ${branding.data.name}` : 'Sign in'} description="Welcome back. Enter your details to continue.">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error ? (
          <Alert variant="destructive" title={error.message}>
            {error.requestId ? <span className="text-xs">Request ID: {error.requestId}</span> : null}
          </Alert>
        ) : null}
        <FormField label="Email" error={form.formState.errors.email?.message}>
          <Input type="email" autoComplete="username" autoFocus placeholder="you@company.com" {...form.register('email')} />
        </FormField>
        <FormField
          label="Password"
          error={form.formState.errors.password?.message}
          labelAction={
            <Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput autoComplete="current-password" {...form.register('password')} />
        </FormField>
        <Button type="submit" className="mt-2 w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
