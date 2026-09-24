import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DATE_FORMATS, tenantSettingsSchema } from '@daliz/shared';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { refreshMe, useAccess } from '@/lib/session';
import { adminKeys, useGeneralSettings, type GeneralSettings } from './api';

type Values = z.input<typeof tenantSettingsSchema>;
const FIELDS = ['displayName', 'locale', 'timezone', 'currency', 'dateFormat', 'weekStartsOn'] as const;

export const TIME_ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

export const CURRENCIES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['USD', 'EUR', 'GBP'];
  }
})();

export const COMMON_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'ja-JP', 'zh-CN', 'ko-KR', 'ne-NP'];

export function SettingsPage() {
  const settings = useGeneralSettings();
  return (
    <>
      <PageHeader title="Settings" description="Regional preferences used across this workspace." />
      {settings.isPending ? (
        <Skeleton className="h-96 w-full" />
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

function SettingsForm({ settings }: { settings: GeneralSettings }) {
  const { canWrite } = useAccess();
  const qc = useQueryClient();
  const editable = canWrite('settings.update');
  const form = useForm<Values, unknown, z.output<typeof tenantSettingsSchema>>({
    resolver: zodResolver(tenantSettingsSchema),
    defaultValues: {
      displayName: settings.displayName,
      locale: settings.locale,
      timezone: settings.timezone,
      currency: settings.currency,
      dateFormat: settings.dateFormat,
      weekStartsOn: settings.weekStartsOn,
    },
  });
  const save = useMutation({
    mutationFn: (v: z.output<typeof tenantSettingsSchema>) => api.put<GeneralSettings>('/settings/general', { ...v, version: settings.version }),
    meta: { silent: true },
  });

  const locales = useMemo(() => (COMMON_LOCALES.includes(settings.locale) ? COMMON_LOCALES : [settings.locale, ...COMMON_LOCALES]), [settings.locale]);
  const zones = useMemo(() => (TIME_ZONES.includes(settings.timezone) ? TIME_ZONES : [settings.timezone, ...TIME_ZONES]), [settings.timezone]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const saved = await save.mutateAsync(values);
      qc.setQueryData(adminKeys.general, saved);
      toast.success('Settings saved');
      void refreshMe();
    } catch (e) {
      applyServerErrors(e, form.setError, FIELDS);
    }
  });

  const example = (() => {
    try {
      const l = form.watch('locale');
      const tz = form.watch('timezone');
      const cur = form.watch('currency');
      return `${new Intl.DateTimeFormat(l, { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date())} · ${new Intl.NumberFormat(l, { style: 'currency', currency: cur }).format(1234.5)}`;
    } catch {
      return null;
    }
  })();

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>{example ? <>Preview: {example}</> : 'Choose valid regional settings to see a preview.'}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="Display name" required error={form.formState.errors.displayName?.message} className="sm:col-span-2">
            <Input disabled={!editable} {...form.register('displayName')} />
          </FormField>
          <FormField label="Locale" error={form.formState.errors.locale?.message}>
            <NativeSelect disabled={!editable} {...form.register('locale')}>
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                  {(() => {
                    try {
                      return ` — ${new Intl.DisplayNames([l], { type: 'language' }).of(l) ?? ''}`;
                    } catch {
                      return '';
                    }
                  })()}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Time zone" error={form.formState.errors.timezone?.message}>
            <NativeSelect disabled={!editable} {...form.register('timezone')}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Currency" error={form.formState.errors.currency?.message}>
            <NativeSelect disabled={!editable} {...form.register('currency')}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Date format" error={form.formState.errors.dateFormat?.message}>
            <NativeSelect disabled={!editable} {...form.register('dateFormat')}>
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Week starts on" error={form.formState.errors.weekStartsOn?.message}>
            <NativeSelect disabled={!editable} {...form.register('weekStartsOn', { setValueAs: (v) => Number(v) })}>
              <option value={1}>Monday</option>
              <option value={0}>Sunday</option>
              <option value={6}>Saturday</option>
            </NativeSelect>
          </FormField>
        </CardContent>
        {editable ? (
          <CardFooter className="justify-end">
            <Button variant="outline" onClick={() => form.reset()} disabled={!form.formState.isDirty || form.formState.isSubmitting}>
              Reset
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} disabled={!form.formState.isDirty}>
              Save settings
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}
