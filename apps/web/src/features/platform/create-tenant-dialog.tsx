import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createTenantSchema, localeSchema } from '@daliz/shared';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm, type FieldPath } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { COMMON_LOCALES, CURRENCIES, TIME_ZONES } from '@/features/admin/settings-page';
import { api, isApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { cn, humanize, slugify } from '@/lib/utils';
import { platformKeys, useOrganizations, usePlatformMeta, usePlatformSettings } from './api';

// The shared schema, with a friendlier message for the organization picker.
const schema = createTenantSchema.extend({ organizationId: z.string().uuid('Choose an organization') });
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

const STEPS: { title: string; fields: FieldPath<Values>[] }[] = [
  { title: 'Workspace', fields: ['organizationId', 'name', 'slug', 'plan'] },
  { title: 'Limits & region', fields: ['limits.maxUsers', 'limits.storageQuotaMb', 'locale', 'timezone', 'currency'] },
  { title: 'First admin', fields: ['admin.email', 'admin.name'] },
];

function defaultLocale(): string {
  const l = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  return localeSchema.safeParse(l).success ? l : 'en-US';
}
function defaultZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function CreateTenantDialog({ open, onOpenChange, defaultOrganizationId }: { open: boolean; onOpenChange: (o: boolean) => void; defaultOrganizationId?: string }) {
  const { canPlatform } = useAccess();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [slugEdited, setSlugEdited] = useState(false);
  const orgs = useOrganizations({ page: 1, pageSize: 100 }, open);
  const meta = usePlatformMeta();
  const settings = usePlatformSettings(open && canPlatform('platform.settings.manage'));

  const form = useForm<Values, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: {
      organizationId: defaultOrganizationId ?? '',
      name: '',
      slug: '',
      plan: 'business',
      limits: { maxUsers: 25, storageQuotaMb: 10240 },
      locale: defaultLocale(),
      timezone: defaultZone(),
      currency: 'USD',
      admin: { email: '', name: '' },
    },
  });

  useEffect(() => {
    if (!settings.data || form.formState.dirtyFields.limits) return;
    form.setValue('limits', { maxUsers: settings.data.defaultMaxUsers, storageQuotaMb: settings.data.defaultStorageQuotaMb });
  }, [settings.data, form]);

  useEffect(() => {
    if (open && defaultOrganizationId) form.setValue('organizationId', defaultOrganizationId);
  }, [open, defaultOrganizationId, form]);

  const create = useMutation({
    mutationFn: (v: Output) => api.post<{ tenantId: string; jobId: string }>('/platform/tenants', v),
    meta: { silent: true },
  });

  const close = (o: boolean) => {
    if (!o && !form.formState.isSubmitting) {
      form.reset();
      setStep(0);
      setSlugEdited(false);
    }
    onOpenChange(o);
  };

  const next = async () => {
    const ok = await form.trigger(STEPS[step]!.fields);
    if (ok) setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const onSubmit = form.handleSubmit(
    async (values) => {
      try {
        const res = await create.mutateAsync(values);
        toast.success(`Provisioning ${values.name}`, { description: 'Follow progress on the tenant page.' });
        void qc.invalidateQueries({ queryKey: platformKeys.tenantsAll });
        void qc.invalidateQueries({ queryKey: platformKeys.dashboard });
        close(false);
        navigate(`/platform/tenants/${res.tenantId}`);
      } catch (e) {
        const fields = STEPS.flatMap((s) => s.fields);
        applyServerErrors(e, form.setError, fields);
        if (isApiError(e)) {
          const firstStep = STEPS.findIndex((s) => s.fields.some((f) => e.details.some((d) => d.path === f || d.path.startsWith(`${f}.`))));
          if (firstStep >= 0) setStep(firstStep);
        }
      }
    },
    (errors) => {
      const firstStep = STEPS.findIndex((s) => s.fields.some((f) => f.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], errors)));
      if (firstStep >= 0) setStep(firstStep);
    },
  );

  const e = form.formState.errors;
  const nameField = form.register('name');
  const values = form.watch();
  const orgName = orgs.data?.items.find((o) => o.id === values.organizationId)?.name;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={(ev) => {
            if (step < STEPS.length - 1) {
              ev.preventDefault();
              void next();
              return;
            }
            void onSubmit(ev);
          }}
          className="grid gap-5"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Create tenant</DialogTitle>
            <DialogDescription>A new workspace with its own isolated database. Provisioning runs in the background.</DialogDescription>
          </DialogHeader>

          <ol className="flex items-center gap-2" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-1 items-center gap-2" aria-current={i === step ? 'step' : undefined}>
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                    i < step && 'border-primary bg-primary text-primary-foreground',
                    i === step && 'border-primary text-primary',
                    i > step && 'text-muted-foreground',
                  )}
                >
                  {i < step ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </span>
                <span className={cn('hidden text-xs font-medium sm:inline', i === step ? 'text-foreground' : 'text-muted-foreground')}>{s.title}</span>
                {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-border" aria-hidden /> : null}
              </li>
            ))}
          </ol>

          {step === 0 ? (
            <div className="grid gap-4">
              <FormField label="Organization" required error={e.organizationId?.message}>
                <NativeSelect disabled={orgs.isPending} {...form.register('organizationId')}>
                  <option value="">{orgs.isPending ? 'Loading…' : 'Choose an organization'}</option>
                  {orgs.data?.items.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.status !== 'active'}>
                      {o.name}
                      {o.status !== 'active' ? ' (suspended)' : ''}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              {orgs.data && orgs.data.items.length === 0 ? <Alert variant="warning" title="Create an organization first." /> : null}
              <FormField label="Tenant name" required error={e.name?.message}>
                <Input
                  autoFocus
                  {...nameField}
                  onChange={(ev) => {
                    void nameField.onChange(ev);
                    if (!slugEdited) form.setValue('slug', slugify(ev.target.value));
                  }}
                />
              </FormField>
              <FormField label="Slug" required hint={values.slug ? `Address: ${values.slug}.<your domain>` : 'Used in the workspace address.'} error={e.slug?.message}>
                <Input className="font-mono" {...form.register('slug', { onChange: () => setSlugEdited(true) })} />
              </FormField>
              <FormField label="Plan" required error={e.plan?.message}>
                <NativeSelect {...form.register('plan')}>
                  {(meta.data?.plans ?? ['starter', 'business', 'enterprise']).map((p) => (
                    <option key={p} value={p}>
                      {humanize(p)}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Maximum users" required error={e.limits?.maxUsers?.message}>
                <Input type="number" inputMode="numeric" min={1} {...form.register('limits.maxUsers')} />
              </FormField>
              <FormField label="Storage quota (MB)" required error={e.limits?.storageQuotaMb?.message}>
                <Input type="number" inputMode="numeric" min={100} step={100} {...form.register('limits.storageQuotaMb')} />
              </FormField>
              <FormField label="Locale" required error={e.locale?.message}>
                <NativeSelect {...form.register('locale')}>
                  {(COMMON_LOCALES.includes(values.locale) ? COMMON_LOCALES : [values.locale, ...COMMON_LOCALES]).map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Currency" required error={e.currency?.message}>
                <NativeSelect {...form.register('currency')}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Time zone" required error={e.timezone?.message} className="sm:col-span-2">
                <NativeSelect {...form.register('timezone')}>
                  {TIME_ZONES.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Admin email" required error={e.admin?.email?.message}>
                  <Input type="email" autoFocus {...form.register('admin.email')} />
                </FormField>
                <FormField label="Admin name" required error={e.admin?.name?.message}>
                  <Input {...form.register('admin.name')} />
                </FormField>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
                <dt className="text-muted-foreground">Organization</dt>
                <dd className="truncate">{orgName ?? '—'}</dd>
                <dt className="text-muted-foreground">Tenant</dt>
                <dd className="truncate">
                  {values.name} <span className="font-mono text-xs text-muted-foreground">({values.slug})</span>
                </dd>
                <dt className="text-muted-foreground">Plan</dt>
                <dd>{humanize(values.plan)}</dd>
                <dt className="text-muted-foreground">Limits</dt>
                <dd>
                  {String(values.limits.maxUsers)} users · {String(values.limits.storageQuotaMb)} MB
                </dd>
                <dt className="text-muted-foreground">Region</dt>
                <dd className="truncate">
                  {values.locale} · {values.timezone} · {values.currency}
                </dd>
              </dl>
              <p className="text-xs text-muted-foreground">The admin receives an invitation email once the workspace is ready.</p>
            </div>
          ) : null}

          <DialogFooter>
            {step > 0 ? (
              <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={form.formState.isSubmitting}>
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button type="submit">Continue</Button>
            ) : (
              <Button type="submit" loading={form.formState.isSubmitting}>
                Create and provision
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
