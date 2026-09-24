import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createPlatformAdminSchema, PLATFORM_ROLES, type PlatformAdminRow, type PlatformRoleKey } from '@daliz/shared';
import { ShieldCheck, ShieldOff, UserCog, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { ago } from '@/lib/utils';
import { platformKeys, usePlatformAdmins } from './api';

export function PlatformAdminsPage() {
  const { me } = useAccess();
  const qc = useQueryClient();
  const admins = usePlatformAdmins();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleChange, setRoleChange] = useState<{ admin: PlatformAdminRow; role: PlatformRoleKey } | null>(null);
  const [statusChange, setStatusChange] = useState<PlatformAdminRow | null>(null);
  const update = useMutation({
    mutationFn: (v: { accountId: string; body: { role?: PlatformRoleKey; status?: 'active' | 'disabled' } }) => api.patch(`/platform/admins/${v.accountId}`, v.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: platformKeys.admins }),
  });

  return (
    <>
      <PageHeader
        title="Platform admins"
        description="People who can operate the Daliz platform. Changes require confirming your identity."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite admin
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {admins.isPending ? (
          <SkeletonRows rows={4} cols={5} />
        ) : admins.isError ? (
          <ErrorState error={admins.error} onRetry={() => void admins.refetch()} />
        ) : admins.data.length === 0 ? (
          <EmptyState icon={UserCog} title="No platform admins" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Admin</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>MFA</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.data.map((a) => {
                const self = a.accountId === me.account.id;
                return (
                  <TableRow key={a.accountId}>
                    <TableCell>
                      <div className="font-medium">
                        {a.name} {self ? <span className="text-xs font-normal text-muted-foreground">(you)</span> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{a.email}</div>
                    </TableCell>
                    <TableCell>
                      <NativeSelect
                        aria-label={`Role for ${a.name}`}
                        className="h-8 w-40 text-xs"
                        value={a.role}
                        disabled={self || update.isPending}
                        onChange={(e) => setRoleChange({ admin: a, role: e.target.value as PlatformRoleKey })}
                      >
                        {PLATFORM_ROLES.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                    <TableCell>
                      {a.mfaEnabled ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <ShieldCheck className="size-4" aria-hidden /> On
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <ShieldOff className="size-4" aria-hidden /> Off
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.lastLoginAt ? ago(a.lastLoginAt) : 'Never'}</TableCell>
                    <TableCell className="text-right">
                      {!self ? (
                        <Button variant="outline" size="sm" className={a.status === 'active' ? 'text-destructive hover:text-destructive' : undefined} onClick={() => setStatusChange(a)}>
                          {a.status === 'active' ? 'Disable' : 'Enable'}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <InviteAdminDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={!!roleChange}
        onOpenChange={(o) => !o && setRoleChange(null)}
        title={`Change ${roleChange?.admin.name}’s role?`}
        description={roleChange ? `New role: ${PLATFORM_ROLES.find((r) => r.key === roleChange.role)?.name}. ${PLATFORM_ROLES.find((r) => r.key === roleChange.role)?.description}` : undefined}
        confirmLabel="Change role"
        onConfirm={async () => {
          if (!roleChange) return;
          await update.mutateAsync({ accountId: roleChange.admin.accountId, body: { role: roleChange.role } });
          toast.success('Role updated');
        }}
      />
      <ConfirmDialog
        open={!!statusChange}
        onOpenChange={(o) => !o && setStatusChange(null)}
        destructive={statusChange?.status === 'active'}
        title={statusChange?.status === 'active' ? `Disable ${statusChange?.name}?` : `Enable ${statusChange?.name}?`}
        description={statusChange?.status === 'active' ? 'They’re signed out everywhere and lose platform access immediately.' : 'They regain platform access with their current role.'}
        confirmLabel={statusChange?.status === 'active' ? 'Disable' : 'Enable'}
        onConfirm={async () => {
          if (!statusChange) return;
          await update.mutateAsync({ accountId: statusChange.accountId, body: { status: statusChange.status === 'active' ? 'disabled' : 'active' } });
          toast.success(statusChange.status === 'active' ? 'Admin disabled' : 'Admin enabled');
        }}
      />
    </>
  );
}

function InviteAdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const form = useForm<z.input<typeof createPlatformAdminSchema>, unknown, z.output<typeof createPlatformAdminSchema>>({
    resolver: zodResolver(createPlatformAdminSchema),
    defaultValues: { email: '', name: '', role: 'support' },
  });
  const create = useMutation({ mutationFn: (v: z.output<typeof createPlatformAdminSchema>) => api.post('/platform/admins', v), meta: { silent: true } });
  const close = (o: boolean) => {
    if (!o) form.reset();
    onOpenChange(o);
  };
  const role = form.watch('role');
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync(v);
      toast.success(`${v.email} is now a platform admin`);
      void qc.invalidateQueries({ queryKey: platformKeys.admins });
      close(false);
    } catch (e) {
      applyServerErrors(e, form.setError, ['email', 'name', 'role']);
    }
  });
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>Invite platform admin</DialogTitle>
            <DialogDescription>New accounts receive an invitation email. Platform admins must use two-factor authentication.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Email" required error={form.formState.errors.email?.message}>
              <Input type="email" autoFocus {...form.register('email')} />
            </FormField>
            <FormField label="Full name" required error={form.formState.errors.name?.message}>
              <Input {...form.register('name')} />
            </FormField>
          </div>
          <FormField label="Role" required hint={PLATFORM_ROLES.find((r) => r.key === role)?.description} error={form.formState.errors.role?.message}>
            <NativeSelect {...form.register('role')}>
              {PLATFORM_ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
