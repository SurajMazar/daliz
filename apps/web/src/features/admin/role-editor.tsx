import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { roleInputSchema, type RoleRow, type TenantPermission } from '@daliz/shared';
import { ArrowLeft, Lock, Trash } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { api, errorMessage, isApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { cn, humanize } from '@/lib/utils';
import { adminKeys, usePermissionCatalog, useRoles, type PermissionCatalogEntry } from './api';

type Values = z.input<typeof roleInputSchema>;

export function RoleEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const role = isNew ? undefined : roles.data?.find((r) => r.id === id);

  useBreadcrumbTail(isNew ? 'New role' : role?.name);

  if (roles.isPending || catalog.isPending) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (roles.isError || catalog.isError) return <ErrorState error={roles.error ?? catalog.error} onRetry={() => void (roles.refetch(), catalog.refetch())} />;
  if (!isNew && !role) return <ErrorState error={new Error('This role no longer exists.')} title="Role not found" />;

  return <RoleEditor key={role ? `${role.id}:${role.version}` : 'new'} role={role} catalog={catalog.data} />;
}

function RoleEditor({ role, catalog }: { role: RoleRow | undefined; catalog: PermissionCatalogEntry[] }) {
  const { me, canWrite } = useAccess();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isNew = !role;
  const locked = !!role?.immutable;
  const canEdit = isNew ? canWrite('roles.create') : canWrite('roles.update') && !locked;
  const canDelete = !!role && !role.isSystem && canWrite('roles.delete');
  const held = useMemo(() => new Set<string>(me.tenant?.permissions ?? []), [me.tenant]);

  const form = useForm<Values, unknown, z.output<typeof roleInputSchema>>({
    resolver: zodResolver(roleInputSchema),
    defaultValues: { name: role?.name ?? '', description: role?.description ?? '', permissions: role?.permissions ?? [] },
  });

  useEffect(() => setServerError(null), [role?.version]);

  const groups = useMemo(() => {
    const map = new Map<string, PermissionCatalogEntry[]>();
    for (const p of catalog) map.set(p.group, [...(map.get(p.group) ?? []), p]);
    return [...map.entries()];
  }, [catalog]);

  const save = useMutation({
    mutationFn: (values: z.output<typeof roleInputSchema>): Promise<{ id?: string; ok?: true }> =>
      role ? api.put<{ ok: true }>(`/roles/${role.id}`, { ...values, version: role.version }) : api.post<{ id: string }>('/roles', values),
    meta: { silent: true },
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/roles/${role!.id}`) });

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const res = await save.mutateAsync(values);
      await qc.invalidateQueries({ queryKey: adminKeys.roles });
      toast.success(role ? 'Role saved' : 'Role created');
      if (!role && res.id) navigate(`/admin/roles/${res.id}`, { replace: true });
      else form.reset(values);
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
        setServerError(e.message);
        return;
      }
      if (!applyServerErrors(e, form.setError, ['name', 'description'], { toastUnmatched: false })) setServerError(errorMessage(e));
    }
  });

  const title = role ? role.name : 'New role';

  return (
    <form onSubmit={onSubmit} noValidate>
      <PageHeader
        title={title}
        description={role?.isSystem ? 'A built-in role. You can adjust its permissions, but not rename or delete it.' : 'A custom role for this workspace.'}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/roles">
                <ArrowLeft /> Back
              </Link>
            </Button>
            {canDelete ? (
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash /> Delete
              </Button>
            ) : null}
            {canEdit ? (
              <Button type="submit" loading={form.formState.isSubmitting} disabled={!isNew && !form.formState.isDirty}>
                {isNew ? 'Create role' : 'Save changes'}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6">
        {locked ? (
          <Alert variant="info" icon={<Lock aria-hidden />} title="The Owner role is locked">
            Owners always hold every permission. This role can’t be edited or deleted.
          </Alert>
        ) : !canEdit ? (
          <Alert variant="info" title="View only">
            You don’t have permission to change this role.
          </Alert>
        ) : null}
        {serverError ? <Alert variant="destructive" title="Couldn’t save the role">{serverError}</Alert> : null}

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Name"
              required
              error={form.formState.errors.name?.message}
              hint={role?.isSystem ? 'Built-in roles can’t be renamed.' : undefined}
            >
              <Input disabled={!canEdit || !!role?.isSystem} {...form.register('name')} />
            </FormField>
            <FormField label="Description" error={form.formState.errors.description?.message} className="sm:col-span-2">
              <Textarea rows={2} disabled={!canEdit} maxLength={300} {...form.register('description')} />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Permissions</CardTitle>
            <CardDescription>You can only grant or remove permissions that you hold yourself.</CardDescription>
          </CardHeader>
          <CardContent>
            <Controller
              control={form.control}
              name="permissions"
              render={({ field }) => {
                const selected = new Set<string>(field.value);
                const set = (keys: string[], on: boolean) => {
                  const next = new Set(selected);
                  for (const k of keys) {
                    if (on) next.add(k);
                    else next.delete(k);
                  }
                  field.onChange(catalog.map((c) => c.key).filter((k) => next.has(k)) as TenantPermission[]);
                };
                return (
                  <div className="grid gap-4 md:grid-cols-2">
                    {groups.map(([group, perms]) => {
                      const keys = perms.map((p) => p.key);
                      const count = keys.filter((k) => selected.has(k)).length;
                      const state = count === 0 ? false : count === keys.length ? true : 'indeterminate';
                      const groupId = `perm-group-${group}`;
                      return (
                        <fieldset key={group} className="rounded-lg border">
                          <legend className="sr-only">{humanize(group)} permissions</legend>
                          <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
                            <Checkbox
                              id={groupId}
                              checked={state}
                              disabled={!canEdit}
                              onCheckedChange={(c) => set(keys, c === true)}
                              aria-label={`Select all ${humanize(group)} permissions`}
                            />
                            <label htmlFor={groupId} className="flex-1 text-sm font-semibold">
                              {humanize(group)}
                            </label>
                            <Badge variant="muted">
                              {count}/{keys.length}
                            </Badge>
                          </div>
                          <div className="divide-y">
                            {perms.map((p) => {
                              const pid = `perm-${p.key}`;
                              return (
                                <div key={p.key} className={cn('flex items-start gap-3 px-4 py-2.5', selected.has(p.key) && 'bg-primary/5')}>
                                  <Checkbox id={pid} className="mt-0.5" checked={selected.has(p.key)} disabled={!canEdit} onCheckedChange={(c) => set([p.key], c === true)} />
                                  <label htmlFor={pid} className="min-w-0 flex-1 cursor-pointer">
                                    <span className="block text-sm">{p.description}</span>
                                    <code className="font-mono text-xs text-muted-foreground">{p.key}</code>
                                  </label>
                                  {!held.has(p.key) && canEdit ? (
                                    <Tooltip content="You don’t hold this permission, so you can’t grant or remove it">
                                      <span className="mt-0.5 text-muted-foreground" tabIndex={0} aria-label="You don’t hold this permission">
                                        <Lock className="size-3.5" aria-hidden />
                                      </span>
                                    </Tooltip>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </fieldset>
                      );
                    })}
                  </div>
                );
              }}
            />
          </CardContent>
        </Card>
      </div>

      {role ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          destructive
          title={`Delete ${role.name}?`}
          description={
            role.userCount > 0
              ? `This role is assigned to ${role.userCount} user${role.userCount === 1 ? '' : 's'}. Remove it from them first.`
              : 'This can’t be undone.'
          }
          confirmLabel="Delete role"
          onConfirm={async () => {
            await remove.mutateAsync();
            await qc.invalidateQueries({ queryKey: adminKeys.roles });
            toast.success('Role deleted');
            navigate('/admin/roles', { replace: true });
          }}
        />
      ) : null}
    </form>
  );
}
