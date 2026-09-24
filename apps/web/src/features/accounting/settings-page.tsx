import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { accountingSettingsSchema, type AccountingSettings } from '@daliz/shared';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { NoAccess } from '@/components/layout/guards';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { AccountingTabs } from './accounting-tabs';
import { accountingKeys, useAccountingSettings, type AccountingSettingsRow } from './api';

export function AccountingSettingsPage() {
  const { can } = useAccess();
  const settings = useAccountingSettings();
  if (!(can('accounting.approve') && can('settings.update'))) return <NoAccess />;
  return (
    <>
      <PageHeader title="Accounting settings" description="Controls that protect the ledger." />
      <AccountingTabs />
      {settings.isPending ? (
        <Skeleton className="h-72" />
      ) : settings.isError ? (
        <Card>
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        </Card>
      ) : (
        <SettingsForm key={settings.data.version} settings={settings.data} />
      )}
    </>
  );
}

// The form edits lockDate as a string ("" = none).
const formSchema = accountingSettingsSchema.extend({ lockDate: z.string().refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date') });
type Values = z.infer<typeof formSchema>;

function SettingsForm({ settings }: { settings: AccountingSettingsRow }) {
  const { readOnly } = useAccess();
  const qc = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: { lockDate: settings.lockDate ?? '', requireApproval: settings.requireApproval, segregationOfDuties: settings.segregationOfDuties },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    const body: AccountingSettings & { version: number } = { ...v, lockDate: v.lockDate || null, version: settings.version };
    try {
      const saved = await api.put<AccountingSettingsRow>('/accounting/settings', body);
      qc.setQueryData(accountingKeys.settings, saved);
      toast.success('Accounting settings saved');
    } catch (e) {
      applyServerErrors(e, form.setError, ['lockDate', 'requireApproval', 'segregationOfDuties']);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Controls</CardTitle>
          <CardDescription>Changes apply to every entry from now on.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <FormField label="Lock date" hint="Entries dated on or before this date can’t be posted or reversed into. Leave empty for no lock." error={form.formState.errors.lockDate?.message} className="max-w-xs">
            <Input type="date" disabled={readOnly} {...form.register('lockDate')} />
          </FormField>
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-1">
              <Label htmlFor="require-approval">Require approval before posting</Label>
              <p className="text-sm text-muted-foreground">When off, people with approval rights can post drafts directly.</p>
            </div>
            <Controller control={form.control} name="requireApproval" render={({ field }) => <Switch id="require-approval" checked={field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-1">
              <Label htmlFor="sod">Segregation of duties</Label>
              <p className="text-sm text-muted-foreground">The person who created an entry can’t approve or post it.</p>
            </div>
            <Controller control={form.control} name="segregationOfDuties" render={({ field }) => <Switch id="sod" checked={field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button variant="outline" onClick={() => form.reset()} disabled={!form.formState.isDirty || form.formState.isSubmitting}>
            Reset
          </Button>
          <Button type="submit" loading={form.formState.isSubmitting} disabled={!form.formState.isDirty || readOnly}>
            Save settings
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
