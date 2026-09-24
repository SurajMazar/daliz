import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inviteUserSchema, type TenantUserRow } from '@daliz/shared';
import { Ban, Ellipsis, KeyRound, MailPlus, Search, ShieldCheck, ShieldOff, Trash, UserCheck, UserPlus, Users } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { api, isApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useDebouncedValue } from '@/lib/hooks';
import { useAccess } from '@/lib/session';
import { formatDateTime, ago } from '@/lib/utils';
import { adminKeys, useAssignableRoles, useUsers } from './api';
import { RoleChecklist } from './role-checklist';

const PAGE_SIZE = 20;

type Pending =
  | { kind: 'roles'; user: TenantUserRow }
  | { kind: 'disable'; user: TenantUserRow }
  | { kind: 'enable'; user: TenantUserRow }
  | { kind: 'revoke'; user: TenantUserRow }
  | null;

export function UsersPage() {
  const { me, canWrite } = useAccess();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim(), 300);
  const users = useUsers({ page, pageSize: PAGE_SIZE, q: q || undefined, status: status || undefined });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: adminKeys.usersAll });
    void qc.invalidateQueries({ queryKey: adminKeys.dashboard });
    void qc.invalidateQueries({ queryKey: adminKeys.roles });
  };

  const patchUser = useMutation({
    mutationFn: (v: { id: string; body: { roleIds?: string[]; status?: 'active' | 'disabled'; version: number } }) =>
      api.patch<TenantUserRow>(`/users/${v.id}`, v.body),
    onSuccess: invalidate,
    onError: (e) => {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') invalidate();
    },
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/resend-invitation`),
    onSuccess: () => toast.success('Invitation sent again'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      toast.success('Invitation revoked');
      invalidate();
    },
  });

  const canInvite = canWrite('users.create');
  const canUpdate = canWrite('users.update');
  const canDelete = canWrite('users.delete');

  return (
    <>
      <PageHeader
        title="Users"
        description="Invite people to this workspace and control what they can do with roles."
        actions={
          canInvite ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite user
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              placeholder="Search by name or email…"
              aria-label="Search users"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="sm:w-44">
            <NativeSelect
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="disabled">Disabled</option>
            </NativeSelect>
          </div>
        </div>

        {users.isPending ? (
          <SkeletonRows rows={6} cols={5} />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : users.data.items.length === 0 ? (
          <EmptyState
            icon={Users}
            title={q || status ? 'No users match your filters' : 'No users yet'}
            description={q || status ? 'Try a different search or status.' : 'Invite your team to get started.'}
            action={
              canInvite && !q && !status ? (
                <Button size="sm" onClick={() => setInviteOpen(true)}>
                  <UserPlus /> Invite user
                </Button>
              ) : null
            }
          />
        ) : (
          <Table aria-busy={users.isFetching || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>User</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">MFA</TableHead>
                <TableHead className="hidden xl:table-cell">Last active</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.items.map((u) => {
                const self = me.tenant?.userId === u.id;
                const actions = {
                  roles: canUpdate && !self && u.status !== 'disabled',
                  disable: canDelete && !self && u.status === 'active',
                  enable: canDelete && !self && u.status === 'disabled',
                  resend: canInvite && u.status === 'invited',
                  revoke: canDelete && u.status === 'invited',
                };
                const anyAction = Object.values(actions).some(Boolean);
                return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar name={u.name} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {u.name}
                            {self ? <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span> : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {u.roles.length ? u.roles.map((r) => <Badge key={r.id} variant={r.key === 'owner' ? 'info' : 'secondary'}>{r.name}</Badge>) : <span className="text-muted-foreground">—</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={u.status} />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {u.mfaEnabled ? (
                        <Tooltip content="Two-factor authentication enabled">
                          <span className="inline-flex items-center gap-1 text-success">
                            <ShieldCheck className="size-4" aria-hidden />
                            <span className="text-xs">On</span>
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <ShieldOff className="size-4" aria-hidden />
                          <span className="text-xs">Off</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
                      {u.lastActiveAt ? (
                        <time dateTime={u.lastActiveAt} title={formatDateTime(u.lastActiveAt)}>
                          {ago(u.lastActiveAt)}
                        </time>
                      ) : (
                        'Never'
                      )}
                    </TableCell>
                    <TableCell>
                      {anyAction ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`}>
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {actions.roles ? (
                              <DropdownMenuItem onSelect={() => setPending({ kind: 'roles', user: u })}>
                                <KeyRound /> Edit roles
                              </DropdownMenuItem>
                            ) : null}
                            {actions.resend ? (
                              <DropdownMenuItem onSelect={() => resend.mutate(u.id)} disabled={resend.isPending}>
                                <MailPlus /> Resend invitation
                              </DropdownMenuItem>
                            ) : null}
                            {actions.enable ? (
                              <DropdownMenuItem onSelect={() => setPending({ kind: 'enable', user: u })}>
                                <UserCheck /> Enable user
                              </DropdownMenuItem>
                            ) : null}
                            {actions.disable || actions.revoke ? <DropdownMenuSeparator /> : null}
                            {actions.disable ? (
                              <DropdownMenuItem destructive onSelect={() => setPending({ kind: 'disable', user: u })}>
                                <Ban /> Disable user
                              </DropdownMenuItem>
                            ) : null}
                            {actions.revoke ? (
                              <DropdownMenuItem destructive onSelect={() => setPending({ kind: 'revoke', user: u })}>
                                <Trash /> Revoke invitation
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {users.data && users.data.meta.total > 0 ? <Pagination meta={users.data.meta} onPageChange={setPage} noun="users" /> : null}
      </Card>

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} onInvited={invalidate} />

      {pending?.kind === 'roles' ? (
        <EditRolesDialog
          user={pending.user}
          onClose={() => setPending(null)}
          onSave={(roleIds) => patchUser.mutateAsync({ id: pending.user.id, body: { roleIds, version: pending.user.version } })}
        />
      ) : null}

      <ConfirmDialog
        open={pending?.kind === 'disable'}
        onOpenChange={(o) => !o && setPending(null)}
        destructive
        title={`Disable ${pending?.user.name}?`}
        description="They’ll be signed out of this workspace immediately and won’t be able to sign in to it until you enable them again. Their history is kept."
        confirmLabel="Disable user"
        onConfirm={async () => {
          if (!pending) return;
          await patchUser.mutateAsync({ id: pending.user.id, body: { status: 'disabled', version: pending.user.version } });
          toast.success(`${pending.user.name} was disabled`);
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'enable'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Enable ${pending?.user.name}?`}
        description="They’ll regain access to this workspace with their current roles."
        confirmLabel="Enable user"
        onConfirm={async () => {
          if (!pending) return;
          await patchUser.mutateAsync({ id: pending.user.id, body: { status: 'active', version: pending.user.version } });
          toast.success(`${pending.user.name} was enabled`);
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'revoke'}
        onOpenChange={(o) => !o && setPending(null)}
        destructive
        title="Revoke invitation?"
        description={`The invitation for ${pending?.user.email} will stop working. You can invite them again later.`}
        confirmLabel="Revoke invitation"
        onConfirm={async () => {
          if (pending) await revoke.mutateAsync(pending.user.id);
        }}
      />
    </>
  );
}

type InviteValues = z.input<typeof inviteUserSchema>;

function InviteUserDialog({ open, onOpenChange, onInvited }: { open: boolean; onOpenChange: (o: boolean) => void; onInvited: () => void }) {
  const roles = useAssignableRoles(open);
  const rolesLabel = useId();
  const form = useForm<InviteValues, unknown, z.output<typeof inviteUserSchema>>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: { email: '', name: '', roleIds: [] },
  });
  const invite = useMutation({
    mutationFn: (v: z.output<typeof inviteUserSchema>) => api.post<{ id: string }>('/users', v),
    meta: { silent: true },
  });

  const close = (o: boolean) => {
    if (!o) form.reset();
    onOpenChange(o);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await invite.mutateAsync(values);
      toast.success(`Invitation sent to ${values.email}`);
      onInvited();
      close(false);
    } catch (e) {
      applyServerErrors(e, form.setError, ['email', 'name', 'roleIds']);
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>They’ll get an email with a link to join this workspace.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Email" error={form.formState.errors.email?.message} required>
              <Input type="email" autoComplete="off" autoFocus {...form.register('email')} />
            </FormField>
            <FormField label="Full name" error={form.formState.errors.name?.message} required>
              <Input autoComplete="off" {...form.register('name')} />
            </FormField>
          </div>
          <div className="grid gap-2">
            <Label id={rolesLabel}>Roles</Label>
            {(
              roles.isError ? (
                <ErrorState error={roles.error} onRetry={() => void roles.refetch()} className="py-4" />
              ) : (
                <Controller
                  control={form.control}
                  name="roleIds"
                  render={({ field, fieldState }) => (
                    <RoleChecklist
                      labelledBy={rolesLabel}
                      roles={roles.data}
                      loading={roles.isPending}
                      value={field.value}
                      onChange={field.onChange}
                      error={fieldState.error?.message}
                    />
                  )}
                />
              )
            )}
          </div>
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

function EditRolesDialog({ user, onClose, onSave }: { user: TenantUserRow; onClose: () => void; onSave: (roleIds: string[]) => Promise<unknown> }) {
  const roles = useAssignableRoles();
  const labelId = useId();
  const [value, setValue] = useState<string[]>(user.roles.map((r) => r.id));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (value.length === 0) {
      setError('Choose at least one role');
      return;
    }
    setSaving(true);
    try {
      await onSave(value);
      toast.success(`Roles updated for ${user.name}`);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit roles</DialogTitle>
          <DialogDescription>
            {user.name} · {user.email}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label id={labelId}>Roles</Label>
          {roles.isError ? (
            <ErrorState error={roles.error} className="py-4" />
          ) : (
            <RoleChecklist
              labelledBy={labelId}
              roles={roles.data}
              loading={roles.isPending}
              value={value}
              onChange={(v) => {
                setValue(v);
                setError(undefined);
              }}
              error={error}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
