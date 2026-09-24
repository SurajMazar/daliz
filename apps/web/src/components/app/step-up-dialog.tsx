import { zodResolver } from '@hookform/resolvers/zod';
import type { MeResponse } from '@daliz/shared';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { api, errorMessage, registerStepUpHandler } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { ME_KEY } from '@/lib/session';

const schema = z.object({
  password: z.string().min(1, 'Enter your password').max(128),
  code: z.string().trim().optional(),
});
type Values = z.infer<typeof schema>;

/**
 * Global re-authentication prompt. The API client calls the registered handler when a
 * request fails with STEP_UP_REQUIRED; on success it retries the original request once.
 */
export function StepUpDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const me = queryClient.getQueryData<MeResponse | null>(ME_KEY);
  const needsCode = !!me?.account.mfaEnabled;

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: '', code: '' } });

  useEffect(() => {
    registerStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          form.reset({ password: '', code: '' });
          setError(null);
          setOpen(true);
        }),
    );
    return () => registerStepUpHandler(null);
  }, [form]);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    if (needsCode && !/^\d{6}$/.test(values.code ?? '')) {
      form.setError('code', { message: 'Enter the 6-digit code from your authenticator app' });
      return;
    }
    try {
      const res = await api.post<{ stepUpUntil: string }>(
        '/auth/step-up',
        { password: values.password, ...(needsCode ? { code: values.code } : {}) },
        { silent: true, skipStepUp: true },
      );
      queryClient.setQueryData<MeResponse | null>(ME_KEY, (prev) => (prev ? { ...prev, stepUpUntil: res.stepUpUntil } : prev));
      finish(true);
    } catch (e) {
      setError(errorMessage(e));
      form.setValue('password', '');
      form.setValue('code', '');
      form.setFocus('password');
    }
  });

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? finish(false) : undefined)}>
      <DialogContent className="max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="size-5" aria-hidden />
            </div>
            <DialogTitle>Confirm it’s you</DialogTitle>
            <DialogDescription>
              This is a sensitive action. Re-enter your password{needsCode ? ' and a code from your authenticator app' : ''} to continue.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <FormField label="Password" error={form.formState.errors.password?.message}>
            <Input type="password" autoComplete="current-password" autoFocus {...form.register('password')} />
          </FormField>
          {needsCode ? (
            <FormField label="Authentication code" error={form.formState.errors.code?.message}>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" {...form.register('code')} />
            </FormField>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => finish(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
