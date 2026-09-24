import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { featureFlagSchema, platformSettingsSchema, type PlatformSettings } from '@daliz/shared';
import { Flag, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { ago } from '@/lib/utils';
import { platformKeys, useFeatureFlags, usePlatformSettings, type FeatureFlag } from './api';

export function PlatformSettingsPage() {
  const settings = usePlatformSettings();
  return (
    <>
      <PageHeader title="Platform settings" description="Global switches for every tenant. Saving requires confirming your identity." />
      <div className="grid gap-6">
        {settings.isPending ? (
          <Skeleton className="h-96" />
        ) : settings.isError ? (
          <Card>
            <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
          </Card>
        ) : (
          <SettingsForm settings={settings.data} />
        )}
        <FeatureFlags />
      </div>
    </>
  );
}

type Values = z.input<typeof platformSettingsSchema>;
const FIELDS = ['maintenanceMode', 'maintenanceMessage', 'requireMfaForPlatformAdmins', 'allowTenantSelfBranding', 'defaultStorageQuotaMb', 'defaultMaxUsers'] as const;

function ToggleRow({ id, label, description, children }: { id: string; label: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function SettingsForm({ settings }: { settings: PlatformSettings }) {
  const qc = useQueryClient();
  const form = useForm<Values, unknown, z.output<typeof platformSettingsSchema>>({ resolver: zodResolver(platformSettingsSchema), defaultValues: settings });
  const save = useMutation({ mutationFn: (v: z.output<typeof platformSettingsSchema>) => api.put('/platform/settings', v), meta: { silent: true } });
  const maintenance = form.watch('maintenanceMode');
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await save.mutateAsync(v);
      qc.setQueryData(platformKeys.settings, v);
      form.reset(v);
      toast.success('Platform settings saved');
    } catch (e) {
      applyServerErrors(e, form.setError, FIELDS);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ToggleRow id="maintenance" label="Maintenance mode" description="Tenant users see a maintenance notice. Platform admins keep access.">
            <Controller control={form.control} name="maintenanceMode" render={({ field }) => <Switch id="maintenance" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleRow>
          {maintenance ? <Alert variant="warning" title="Saving will take every tenant offline for its users." /> : null}
          <FormField label="Maintenance message" hint="Shown to users while maintenance mode is on." error={form.formState.errors.maintenanceMessage?.message}>
            <Textarea rows={2} maxLength={300} {...form.register('maintenanceMessage')} />
          </FormField>
          <ToggleRow id="require-mfa" label="Require MFA for platform admins" description="Platform admins must enrol in two-factor authentication before using the console.">
            <Controller control={form.control} name="requireMfaForPlatformAdmins" render={({ field }) => <Switch id="require-mfa" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleRow>
          <ToggleRow id="self-branding" label="Allow tenant self-branding" description="Tenant admins can change their own logo and colors.">
            <Controller control={form.control} name="allowTenantSelfBranding" render={({ field }) => <Switch id="self-branding" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Default max users" hint="For new tenants." error={form.formState.errors.defaultMaxUsers?.message}>
              <Input type="number" inputMode="numeric" min={1} {...form.register('defaultMaxUsers')} />
            </FormField>
            <FormField label="Default storage quota (MB)" hint="For new tenants." error={form.formState.errors.defaultStorageQuotaMb?.message}>
              <Input type="number" inputMode="numeric" min={100} step={100} {...form.register('defaultStorageQuotaMb')} />
            </FormField>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button variant="outline" onClick={() => form.reset()} disabled={!form.formState.isDirty || form.formState.isSubmitting}>
            Reset
          </Button>
          <Button type="submit" loading={form.formState.isSubmitting} disabled={!form.formState.isDirty}>
            Save settings
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function FeatureFlags() {
  const qc = useQueryClient();
  const flags = useFeatureFlags();
  const [createOpen, setCreateOpen] = useState(false);
  const upsert = useMutation({
    mutationFn: (f: Pick<FeatureFlag, 'key' | 'description' | 'enabled'>) => api.put('/platform/feature-flags', f),
    onSuccess: () => void qc.invalidateQueries({ queryKey: platformKeys.flags }),
  });
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4 sm:pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Feature flags</CardTitle>
            <CardDescription>Gradually enable features across the platform.</CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> New flag
          </Button>
        </div>
      </CardHeader>
      {flags.isPending ? (
        <SkeletonRows rows={3} cols={3} />
      ) : flags.isError ? (
        <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />
      ) : flags.data.length === 0 ? (
        <EmptyState icon={Flag} title="No feature flags yet" />
      ) : (
        <ul className="divide-y border-t">
          {flags.data.map((f) => (
            <li key={f.key} className="flex items-center gap-4 px-5 py-3 sm:px-6">
              <div className="min-w-0 flex-1">
                <code className="font-mono text-sm font-medium">{f.key}</code>
                <p className="text-sm text-muted-foreground">{f.description || 'No description'}</p>
                <p className="text-xs text-muted-foreground">Updated {ago(f.updatedAt)}</p>
              </div>
              <Switch
                aria-label={`Toggle ${f.key}`}
                checked={f.enabled}
                disabled={upsert.isPending && upsert.variables?.key === f.key}
                onCheckedChange={(enabled) =>
                  upsert.mutate(
                    { key: f.key, description: f.description, enabled },
                    { onSuccess: () => toast.success(`${f.key} ${enabled ? 'enabled' : 'disabled'}`) },
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
      <CreateFlagDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}

function CreateFlagDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const form = useForm<z.input<typeof featureFlagSchema>, unknown, z.output<typeof featureFlagSchema>>({
    resolver: zodResolver(featureFlagSchema),
    defaultValues: { key: '', description: '', enabled: false },
  });
  const create = useMutation({ mutationFn: (v: z.output<typeof featureFlagSchema>) => api.put('/platform/feature-flags', v), meta: { silent: true } });
  const close = (o: boolean) => {
    if (!o) form.reset();
    onOpenChange(o);
  };
  const onSubmit = form.handleSubmit(async (v) => {
    if (qc.getQueryData<FeatureFlag[]>(platformKeys.flags)?.some((f) => f.key === v.key)) {
      form.setError('key', { message: 'A flag with this key already exists' });
      return;
    }
    try {
      await create.mutateAsync(v);
      toast.success(`Flag ${v.key} created`);
      void qc.invalidateQueries({ queryKey: platformKeys.flags });
      close(false);
    } catch (e) {
      applyServerErrors(e, form.setError, ['key', 'description', 'enabled']);
    }
  });
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>New feature flag</DialogTitle>
            <DialogDescription>Keys are lowercase, e.g. finance.bank_feeds.</DialogDescription>
          </DialogHeader>
          <FormField label="Key" required error={form.formState.errors.key?.message}>
            <Input className="font-mono" autoFocus autoComplete="off" {...form.register('key')} />
          </FormField>
          <FormField label="Description" error={form.formState.errors.description?.message}>
            <Textarea rows={2} maxLength={300} {...form.register('description')} />
          </FormField>
          <div className="flex items-center gap-2">
            <Controller control={form.control} name="enabled" render={({ field }) => <Switch id="flag-enabled" checked={field.value} onCheckedChange={field.onChange} />} />
            <Label htmlFor="flag-enabled" className="font-normal">
              Enabled
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Create flag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
