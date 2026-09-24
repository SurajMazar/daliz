import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { decommissionTenantSchema, supportAccessSchema, tenantStatusChangeSchema, type TenantDetail } from '@daliz/shared';
import { LifeBuoy } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { navigateTo } from '@/lib/navigation';
import { ME_KEY, refreshMe, useAccess } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';
import { platformKeys } from './api';

type ReasonValues = z.infer<typeof tenantStatusChangeSchema>;

/** Suspend / activate with a mandatory reason (recorded in the audit log). */
export function StatusChangeDialog({ tenant, action, onClose }: { tenant: TenantDetail; action: 'suspend' | 'activate'; onClose: () => void }) {
  const qc = useQueryClient();
  const form = useForm<ReasonValues>({ resolver: zodResolver(tenantStatusChangeSchema), defaultValues: { reason: '' } });
  const run = useMutation({ mutationFn: (v: ReasonValues) => api.post(`/platform/tenants/${tenant.id}/${action}`, v), meta: { silent: true } });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await run.mutateAsync(v);
      toast.success(action === 'suspend' ? `${tenant.name} suspended` : `${tenant.name} activated`);
      void qc.invalidateQueries({ queryKey: platformKeys.tenant(tenant.id) });
      void qc.invalidateQueries({ queryKey: platformKeys.tenantsAll });
      onClose();
    } catch (e) {
      applyServerErrors(e, form.setError, ['reason']);
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{action === 'suspend' ? `Suspend ${tenant.name}?` : `Activate ${tenant.name}?`}</DialogTitle>
            <DialogDescription>
              {action === 'suspend'
                ? 'Users are signed out and can’t access the workspace until it’s activated. Data is kept.'
                : 'Users regain access to the workspace immediately.'}
            </DialogDescription>
          </DialogHeader>
          <FormField label="Reason" required hint="Recorded in the audit log." error={form.formState.errors.reason?.message}>
            <Textarea rows={3} autoFocus {...form.register('reason')} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant={action === 'suspend' ? 'destructive' : 'default'} loading={form.formState.isSubmitting}>
              {action === 'suspend' ? 'Suspend tenant' : 'Activate tenant'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type DecomValues = z.input<typeof decommissionTenantSchema>;

/** Decommission: typed slug confirmation + reason; the API also requires a step-up. */
export function DecommissionDialog({ tenant, onClose }: { tenant: TenantDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const schema = decommissionTenantSchema.refine((v) => v.confirmSlug === tenant.slug, { path: ['confirmSlug'], message: `Type ${tenant.slug} to confirm` });
  const form = useForm<DecomValues, unknown, z.output<typeof decommissionTenantSchema>>({ resolver: zodResolver(schema), defaultValues: { reason: '', confirmSlug: '' } });
  const run = useMutation({
    mutationFn: (v: z.output<typeof decommissionTenantSchema>) => api.post<{ purgeAt: string }>(`/platform/tenants/${tenant.id}/decommission`, v),
    meta: { silent: true },
  });
  const typed = form.watch('confirmSlug');
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const res = await run.mutateAsync(v);
      toast.success(`${tenant.name} scheduled for decommissioning`, { description: `Data will be purged ${formatDateTime(res.purgeAt)} unless cancelled.` });
      void qc.invalidateQueries({ queryKey: platformKeys.tenant(tenant.id) });
      void qc.invalidateQueries({ queryKey: platformKeys.tenantsAll });
      onClose();
    } catch (e) {
      applyServerErrors(e, form.setError, ['reason', 'confirmSlug']);
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>Decommission {tenant.name}?</DialogTitle>
            <DialogDescription>The workspace becomes unavailable now. After the grace period its database and files are permanently deleted.</DialogDescription>
          </DialogHeader>
          <Alert variant="destructive" title="This permanently deletes customer data after the grace period." />
          <FormField label="Reason" required error={form.formState.errors.reason?.message}>
            <Textarea rows={2} autoFocus {...form.register('reason')} />
          </FormField>
          <FormField
            label={
              <>
                Type <span className="font-mono font-semibold">{tenant.slug}</span> to confirm
              </>
            }
            required
            error={form.formState.errors.confirmSlug?.message}
          >
            <Input className="font-mono" autoComplete="off" spellCheck={false} {...form.register('confirmSlug')} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} disabled={typed !== tenant.slug}>
              Decommission
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const DURATIONS = [15, 30, 60, 120] as const;
type SupportValues = z.input<typeof supportAccessSchema>;

/** Opens an audited support session inside the tenant, then enters the tenant app. */
export function SupportAccessDialog({ tenant, onClose }: { tenant: TenantDetail; onClose: () => void }) {
  const { canPlatform } = useAccess();
  const qc = useQueryClient();
  const canWrite = canPlatform('platform.tenants.update');
  const form = useForm<SupportValues, unknown, z.output<typeof supportAccessSchema>>({
    resolver: zodResolver(supportAccessSchema),
    defaultValues: { reason: '', durationMinutes: 30, allowWrite: false },
  });
  const start = useMutation({
    mutationFn: (v: z.output<typeof supportAccessSchema>) => api.post<{ expiresAt: string }>(`/platform/tenants/${tenant.id}/support-access`, v),
    meta: { silent: true },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await start.mutateAsync(v);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
      await refreshMe();
      toast.success(`Support session started in ${tenant.name}`);
      onClose();
      navigateTo('/', { replace: true });
    } catch (e) {
      applyServerErrors(e, form.setError, ['reason', 'durationMinutes', 'allowWrite']);
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-warning/10 text-warning">
              <LifeBuoy className="size-5" aria-hidden />
            </div>
            <DialogTitle>Open a support session</DialogTitle>
            <DialogDescription>
              You’ll see {tenant.name} as its users do. The session is time-limited, recorded in both audit logs and visible to the tenant’s admins.
            </DialogDescription>
          </DialogHeader>
          <FormField label="Reason" required hint="At least 10 characters, e.g. the ticket you’re working on." error={form.formState.errors.reason?.message}>
            <Textarea rows={3} autoFocus {...form.register('reason')} />
          </FormField>
          <FormField label="Duration" error={form.formState.errors.durationMinutes?.message}>
            <NativeSelect {...form.register('durationMinutes', { setValueAs: (v) => Number(v) })}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? `${d} minutes` : `${d / 60} hour${d > 60 ? 's' : ''}`}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <div className="grid gap-1.5">
            <div className="flex items-center gap-2">
              <Controller
                control={form.control}
                name="allowWrite"
                render={({ field }) => <Checkbox id="allow-write" checked={!!field.value} onCheckedChange={(c) => field.onChange(c === true)} disabled={!canWrite} />}
              />
              <Label htmlFor="allow-write" className="font-normal">
                Allow write access
              </Label>
            </div>
            <p className="pl-6 text-xs text-muted-foreground">
              {canWrite ? 'Without it, the session is read-only and every change is refused.' : 'Your platform role can only open read-only sessions.'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Start session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

