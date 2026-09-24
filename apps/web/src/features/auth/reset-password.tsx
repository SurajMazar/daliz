import { zodResolver } from '@hookform/resolvers/zod';
import { passwordSchema } from '@daliz/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { api, errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/theme';
import { AuthCard } from './auth-layout';
import { PasswordInput } from './password-input';

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords don’t match' });

export function ResetPasswordPage() {
  useDocumentTitle('Choose a new password');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof newPasswordSchema>>({ resolver: zodResolver(newPasswordSchema), defaultValues: { password: '', confirm: '' } });

  if (token.length < 20) {
    return (
      <AuthCard title="Invalid reset link">
        <Alert variant="destructive" title="This password reset link is incomplete or invalid." />
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link to="/forgot-password">Request a new link</Link>
        </Button>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password updated">
        <Alert variant="success" title="Your password has been changed.">
          For your security, you’ve been signed out of your other sessions.
        </Alert>
        <Button asChild className="mt-4 w-full">
          <Link to="/login">Sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/password/reset', { token, password: values.password }, { silent: true });
      setDone(true);
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['password'], { toastUnmatched: false })) setError(errorMessage(e));
    }
  });

  return (
    <AuthCard title="Choose a new password" description="Use at least 12 characters. A passphrase of several words works well.">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error ? <Alert variant="destructive" title={error} /> : null}
        <FormField label="New password" error={form.formState.errors.password?.message}>
          <PasswordInput autoComplete="new-password" autoFocus {...form.register('password')} />
        </FormField>
        <FormField label="Confirm new password" error={form.formState.errors.confirm?.message}>
          <PasswordInput autoComplete="new-password" {...form.register('confirm')} />
        </FormField>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}
