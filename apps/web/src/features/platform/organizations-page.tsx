import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createOrganizationSchema, type OrganizationRow } from '@daliz/shared';
import { Building, Ellipsis, Pause, Play, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useDebouncedValue } from '@/lib/hooks';
import { useAccess } from '@/lib/session';
import { formatDate, slugify } from '@/lib/utils';
import { platformKeys, useOrganizations } from './api';

export function OrganizationsPage() {
  const { canPlatform } = useAccess();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim(), 300);
  const orgs = useOrganizations({ page, pageSize: 20, q: q || undefined });
  const [createOpen, setCreateOpen] = useState(false);
  const [toggle, setToggle] = useState<OrganizationRow | null>(null);
  const canManage = canPlatform('platform.organizations.manage');

  const update = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'suspended' }) => api.patch(`/platform/organizations/${v.id}`, { status: v.status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: platformKeys.organizationsAll });
      void qc.invalidateQueries({ queryKey: platformKeys.tenantsAll });
    },
  });

  return (
    <>
      <PageHeader
        title="Organizations"
        description="Customers that own one or more tenants."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New organization
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        <div className="border-b p-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              aria-label="Search organizations"
              placeholder="Search organizations…"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        {orgs.isPending ? (
          <SkeletonRows rows={5} cols={5} />
        ) : orgs.isError ? (
          <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />
        ) : orgs.data.items.length === 0 ? (
          <EmptyState
            icon={Building}
            title={q ? 'No organizations match your search' : 'No organizations yet'}
            action={
              canManage && !q ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus /> New organization
                </Button>
              ) : null
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Organization</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tenants</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgs.data.items.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <div className="font-medium">{o.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{o.slug}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{o.contactEmail}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Link to={`/platform/tenants?organizationId=${o.id}`} className="text-primary hover:underline">
                      {o.tenantCount}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(o.createdAt)}</TableCell>
                  <TableCell>
                    {canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${o.name}`}>
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {o.status === 'active' ? (
                            <DropdownMenuItem destructive onSelect={() => setToggle(o)}>
                              <Pause /> Suspend organization
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => setToggle(o)}>
                              <Play /> Activate organization
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {orgs.data && orgs.data.meta.total > 0 ? <Pagination meta={orgs.data.meta} onPageChange={setPage} noun="organizations" /> : null}
      </Card>

      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && setToggle(null)}
        destructive={toggle?.status === 'active'}
        title={toggle?.status === 'active' ? `Suspend ${toggle?.name}?` : `Activate ${toggle?.name}?`}
        description={
          toggle?.status === 'active'
            ? 'All of this organization’s tenants become unavailable to their users until it’s activated again.'
            : 'Its tenants become available to their users again (unless individually suspended).'
        }
        confirmLabel={toggle?.status === 'active' ? 'Suspend' : 'Activate'}
        onConfirm={async () => {
          if (!toggle) return;
          await update.mutateAsync({ id: toggle.id, status: toggle.status === 'active' ? 'suspended' : 'active' });
          toast.success(toggle.status === 'active' ? 'Organization suspended' : 'Organization activated');
        }}
      />
    </>
  );
}

type OrgValues = z.input<typeof createOrganizationSchema>;

function CreateOrganizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [slugEdited, setSlugEdited] = useState(false);
  const form = useForm<OrgValues, unknown, z.output<typeof createOrganizationSchema>>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: '', slug: '', contactEmail: '' },
  });
  const create = useMutation({ mutationFn: (v: z.output<typeof createOrganizationSchema>) => api.post<{ id: string }>('/platform/organizations', v), meta: { silent: true } });
  const close = (o: boolean) => {
    if (!o) {
      form.reset();
      setSlugEdited(false);
    }
    onOpenChange(o);
  };
  const nameField = form.register('name');
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync(v);
      toast.success(`${v.name} created`);
      void qc.invalidateQueries({ queryKey: platformKeys.organizationsAll });
      void qc.invalidateQueries({ queryKey: platformKeys.dashboard });
      close(false);
    } catch (e) {
      applyServerErrors(e, form.setError, ['name', 'slug', 'contactEmail']);
    }
  });
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>An organization is the customer account that owns tenants.</DialogDescription>
          </DialogHeader>
          <FormField label="Name" required error={form.formState.errors.name?.message}>
            <Input
              autoFocus
              {...nameField}
              onChange={(e) => {
                void nameField.onChange(e);
                if (!slugEdited) form.setValue('slug', slugify(e.target.value), { shouldValidate: form.formState.isSubmitted });
              }}
            />
          </FormField>
          <FormField label="Slug" required hint="Lowercase letters, numbers and hyphens." error={form.formState.errors.slug?.message}>
            <Input className="font-mono" {...form.register('slug', { onChange: () => setSlugEdited(true) })} />
          </FormField>
          <FormField label="Contact email" required error={form.formState.errors.contactEmail?.message}>
            <Input type="email" {...form.register('contactEmail')} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
