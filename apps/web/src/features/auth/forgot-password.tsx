import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@daliz/shared';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import type { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useDocumentTitle } from '@/lib/theme';
import { AuthCard } from './auth-layout';

export function ForgotPasswordPage() {
  useDocumentTitle('Reset your password');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.input<typeof forgotPasswordSchema>, unknown, z.output<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/password/forgot', values, { silent: true });
      setSentTo(values.email);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  if (sentTo) {
    return (
      <AuthCard title="Check your email">
        <div className="grid gap-4">
          <Alert variant="success" icon={<MailCheck aria-hidden />} title="Reset link sent">
            If an account exists for <strong className="text-foreground">{sentTo}</strong>, you’ll receive an email with a link to reset your password. The
            link expires soon, so use it promptly.
          </Alert>
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password" description="Enter your email and we’ll send you a link to choose a new password.">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error ? <Alert variant="destructive" title={error} /> : null}
        <FormField label="Email" error={form.formState.errors.email?.message}>
          <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
        </FormField>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Send reset link
        </Button>
        <Link to="/login" className="text-center text-sm font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </form>
    </AuthCard>
  );
}
