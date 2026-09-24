import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { tenantSecurityPolicySchema } from '@daliz/shared';
import { ShieldCheck } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { refreshMe, useAccess } from '@/lib/session';
import { adminKeys, useSecuritySettings, type SecuritySettings } from './api';

type Values = z.input<typeof tenantSecurityPolicySchema>;
const FIELDS = ['requireMfa', 'sessionIdleMinutes', 'sessionMaxHours', 'lockScreenMinutes'] as const;

export function SecurityPage() {
  const settings = useSecuritySettings();
  return (
    <>
      <PageHeader title="Security" description="Sign-in and session rules for everyone in this workspace." />
      {settings.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : settings.isError ? (
        <Card>
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        </Card>
      ) : (
        <SecurityForm key={settings.data.version} settings={settings.data} />
      )}
    </>
  );
}

function SecurityForm({ settings }: { settings: SecuritySettings }) {
  const { me, canWrite } = useAccess();
  const qc = useQueryClient();
  const editable = canWrite('security.update');
  const form = useForm<Values, unknown, z.output<typeof tenantSecurityPolicySchema>>({
    resolver: zodResolver(tenantSecurityPolicySchema),
    defaultValues: {
      requireMfa: settings.requireMfa,
      sessionIdleMinutes: settings.sessionIdleMinutes,
      sessionMaxHours: settings.sessionMaxHours,
      lockScreenMinutes: settings.lockScreenMinutes,
    },
  });
  const save = useMutation({
    mutationFn: (v: z.output<typeof tenantSecurityPolicySchema>) => api.put<SecuritySettings>('/settings/security', { ...v, version: settings.version }),
    meta: { silent: true },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const saved = await save.mutateAsync(values);
      qc.setQueryData(adminKeys.security, saved);
      toast.success('Security policy saved');
      void refreshMe();
    } catch (e) {
      applyServerErrors(e, form.setError, FIELDS);
    }
  });

  const requireMfa = form.watch('requireMfa');

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" aria-hidden /> Workspace policy
          </CardTitle>
          <CardDescription>Changing the policy requires you to confirm your identity.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-1">
              <Label htmlFor="require-mfa">Require two-factor authentication</Label>
              <p className="text-sm text-muted-foreground">Members without an authenticator app will be asked to set one up the next time they sign in.</p>
            </div>
            <Controller
              control={form.control}
              name="requireMfa"
              render={({ field }) => <Switch id="require-mfa" checked={field.value} onCheckedChange={field.onChange} disabled={!editable} />}
            />
          </div>
          {requireMfa && !me.account.mfaEnabled ? (
            <Alert variant="warning" title="You haven’t set up two-factor authentication">
              Once this policy is saved you’ll need to enrol before you can keep using the workspace.
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Idle timeout (minutes)" hint="Sign out after this long without activity. 5–1440." error={form.formState.errors.sessionIdleMinutes?.message}>
              <Input type="number" inputMode="numeric" min={5} max={1440} disabled={!editable} {...form.register('sessionIdleMinutes')} />
            </FormField>
            <FormField label="Maximum session (hours)" hint="Always sign out after this long. 1–720." error={form.formState.errors.sessionMaxHours?.message}>
              <Input type="number" inputMode="numeric" min={1} max={720} disabled={!editable} {...form.register('sessionMaxHours')} />
            </FormField>
            <FormField label="Lock screen (minutes)" hint="Lock the app on devices after inactivity. 1–240." error={form.formState.errors.lockScreenMinutes?.message}>
              <Input type="number" inputMode="numeric" min={1} max={240} disabled={!editable} {...form.register('lockScreenMinutes')} />
            </FormField>
          </div>
        </CardContent>
        {editable ? (
          <CardFooter className="justify-end">
            <Button variant="outline" onClick={() => form.reset()} disabled={!form.formState.isDirty || form.formState.isSubmitting}>
              Reset
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} disabled={!form.formState.isDirty}>
              Save policy
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}
