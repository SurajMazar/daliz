import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addTenantAdminSchema, addTenantDomainSchema, type ProvisioningStep, type TenantDetail } from '@daliz/shared';
import {
  ArrowLeft,
  Ban,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleX,
  Copy,
  Database,
  Globe,
  LifeBuoy,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash,
  Undo2,
  UserCog,
  UserPlus,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { AuditLogView } from '@/components/app/audit-log';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { copyText, formatDateTime, formatMb, humanize, ago } from '@/lib/utils';
import { platformKeys, useTenantDetail } from './api';
import { DecommissionDialog, StatusChangeDialog, SupportAccessDialog } from './tenant-actions';

type Dialogs = 'suspend' | 'activate' | 'decommission' | 'support' | 'cancel-decommission' | 'retry' | 'migrate' | null;

export function TenantDetailPage() {
  const { id = '' } = useParams();
  const tenant = useTenantDetail(id);
  useBreadcrumbTail(tenant.data?.name);

  if (tenant.isPending) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (tenant.isError) {
    return (
      <Card>
        <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />
      </Card>
    );
  }
  return <TenantDetailView tenant={tenant.data} refreshing={tenant.isFetching} />;
}

function TenantDetailView({ tenant, refreshing }: { tenant: TenantDetail; refreshing: boolean }) {
  const { canPlatform } = useAccess();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: platformKeys.tenant(tenant.id) });
    void qc.invalidateQueries({ queryKey: platformKeys.tenantsAll });
  };
  const retry = useMutation({ mutationFn: () => api.post(`/platform/tenants/${tenant.id}/retry-provisioning`), onSuccess: invalidate });
  const migrate = useMutation({ mutationFn: () => api.post<{ jobId: string }>(`/platform/tenants/${tenant.id}/migrate`), onSuccess: invalidate });
  const cancelDecom = useMutation({ mutationFn: () => api.post(`/platform/tenants/${tenant.id}/decommission/cancel`), onSuccess: invalidate });

  const s = tenant.status;
  const live = s === 'active' || s === 'suspended';
  const actions = {
    support: canPlatform('platform.support_access') && live,
    suspend: canPlatform('platform.tenants.suspend') && s === 'active',
    activate: canPlatform('platform.tenants.suspend') && s === 'suspended',
    retry: canPlatform('platform.tenants.create') && s === 'provisioning_failed',
    migrate: canPlatform('platform.tenants.migrate') && live,
    decommission: canPlatform('platform.tenants.decommission') && live,
    cancelDecommission: canPlatform('platform.tenants.decommission') && s === 'decommissioning',
  };
  const anyAction = Object.values(actions).some(Boolean);
  const provisioningActive = s === 'provisioning' || tenant.provisioning?.status === 'running' || tenant.provisioning?.status === 'queued';

  return (
    <>
      <PageHeader
        title={tenant.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={tenant.status} />
            <span className="font-mono text-xs">{tenant.slug}</span>
            <span aria-hidden>·</span>
            <span>{tenant.organizationName}</span>
            <span aria-hidden>·</span>
            <span>{humanize(tenant.plan)} plan</span>
            {refreshing && provisioningActive ? <LoaderCircle className="size-3.5 animate-spin" aria-label="Refreshing" /> : null}
          </span>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/platform/tenants">
                <ArrowLeft /> Tenants
              </Link>
            </Button>
            {actions.support ? (
              <Button variant="secondary" onClick={() => setDialog('support')}>
                <LifeBuoy /> Support access
              </Button>
            ) : null}
            {anyAction ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button>
                    Actions <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {actions.activate ? (
                    <DropdownMenuItem onSelect={() => setDialog('activate')}>
                      <Play /> Activate
                    </DropdownMenuItem>
                  ) : null}
                  {actions.retry ? (
                    <DropdownMenuItem onSelect={() => setDialog('retry')}>
                      <RotateCcw /> Retry provisioning
                    </DropdownMenuItem>
                  ) : null}
                  {actions.migrate ? (
                    <DropdownMenuItem onSelect={() => setDialog('migrate')}>
                      <Database /> Run migrations
                    </DropdownMenuItem>
                  ) : null}
                  {actions.cancelDecommission ? (
                    <DropdownMenuItem onSelect={() => setDialog('cancel-decommission')}>
                      <Undo2 /> Cancel decommission
                    </DropdownMenuItem>
                  ) : null}
                  {actions.suspend || actions.decommission ? <DropdownMenuSeparator /> : null}
                  {actions.suspend ? (
                    <DropdownMenuItem destructive onSelect={() => setDialog('suspend')}>
                      <Ban /> Suspend
                    </DropdownMenuItem>
                  ) : null}
                  {actions.decommission ? (
                    <DropdownMenuItem destructive onSelect={() => setDialog('decommission')}>
                      <Trash /> Decommission
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {tenant.statusReason && s !== 'active' ? (
        <Alert variant={s === 'provisioning_failed' ? 'destructive' : 'warning'} title={`${humanize(s)}: ${tenant.statusReason}`} className="mb-6" />
      ) : null}

      <Tabs defaultValue={provisioningActive || s === 'provisioning_failed' ? 'provisioning' : 'overview'}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="provisioning">Provisioning</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="admins">Admins</TabsTrigger>
          {canPlatform('platform.audit.read') ? <TabsTrigger value="audit">Audit</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="overview">
          <Overview tenant={tenant} />
        </TabsContent>
        <TabsContent value="provisioning">
          <Provisioning tenant={tenant} />
        </TabsContent>
        <TabsContent value="domains">
          <Domains tenant={tenant} />
        </TabsContent>
        <TabsContent value="admins">
          <Admins tenant={tenant} />
        </TabsContent>
        {canPlatform('platform.audit.read') ? (
          <TabsContent value="audit">
            <Card className="overflow-hidden">
              <AuditLogView queryKey={platformKeys.tenantAudit(tenant.id)} path={`/platform/tenants/${tenant.id}/audit`} />
            </Card>
          </TabsContent>
        ) : null}
      </Tabs>

      {dialog === 'suspend' || dialog === 'activate' ? <StatusChangeDialog tenant={tenant} action={dialog} onClose={() => setDialog(null)} /> : null}
      {dialog === 'decommission' ? <DecommissionDialog tenant={tenant} onClose={() => setDialog(null)} /> : null}
      {dialog === 'support' ? <SupportAccessDialog tenant={tenant} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog === 'retry'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Retry provisioning?"
        description="Provisioning resumes from the failed step."
        confirmLabel="Retry"
        onConfirm={async () => {
          await retry.mutateAsync();
          toast.success('Provisioning restarted');
        }}
      />
      <ConfirmDialog
        open={dialog === 'migrate'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Run database migrations?"
        description="Pending schema migrations are applied to this tenant’s database in the background."
        confirmLabel="Run migrations"
        onConfirm={async () => {
          await migrate.mutateAsync();
          toast.success('Migration queued');
        }}
      />
      <ConfirmDialog
        open={dialog === 'cancel-decommission'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Cancel decommissioning?"
        description="The tenant returns to its previous state and nothing is deleted."
        confirmLabel="Cancel decommission"
        onConfirm={async () => {
          await cancelDecom.mutateAsync();
          toast.success('Decommissioning cancelled');
        }}
      />
    </>
  );
}

function Overview({ tenant }: { tenant: TenantDetail }) {
  const rows: [string, ReactNode][] = [
    ['Organization', tenant.organizationName],
    ['Plan', humanize(tenant.plan)],
    ['Users', tenant.userCount === null ? '—' : `${tenant.userCount} of ${tenant.limits.maxUsers}`],
    ['Storage quota', formatMb(tenant.limits.storageQuotaMb)],
    ['Locale', tenant.locale],
    ['Time zone', tenant.timezone],
    ['Currency', tenant.currency],
    ['Primary admin', tenant.primaryAdminEmail ?? '—'],
    ['Created', formatDateTime(tenant.createdAt)],
    ['Last activity', tenant.lastActivityAt ? `${ago(tenant.lastActivityAt)} (${formatDateTime(tenant.lastActivityAt)})` : '—'],
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-medium break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="size-4 text-primary" aria-hidden /> Database
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge status={tenant.database.status} />
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Schema version</dt>
              <dd className="font-mono text-xs">{tenant.database.schemaVersion ?? '—'}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Name</dt>
              <dd className="font-mono text-xs break-all">{tenant.database.name}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Host</dt>
              <dd className="font-mono text-xs break-all">{tenant.database.host}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function StepIcon({ status }: { status: ProvisioningStep['status'] }) {
  switch (status) {
    case 'done':
      return <CircleCheck className="size-5 text-success" aria-label="Done" />;
    case 'running':
      return <LoaderCircle className="size-5 animate-spin text-primary" aria-label="Running" />;
    case 'failed':
      return <CircleX className="size-5 text-destructive" aria-label="Failed" />;
    default:
      return <Circle className="size-5 text-muted-foreground/60" aria-label="Pending" />;
  }
}

function Provisioning({ tenant }: { tenant: TenantDetail }) {
  const p = tenant.provisioning;
  if (!p) {
    return (
      <Card>
        <EmptyState icon={RefreshCw} title="No provisioning job" description="This tenant has no provisioning history." />
      </Card>
    );
  }
  const done = p.steps.filter((st) => st.status === 'done').length;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Provisioning</CardTitle>
          <StatusBadge status={p.status} />
        </div>
        <CardDescription>
          {done}/{p.steps.length} steps complete · attempt {p.attempts} · updated {ago(p.updatedAt)}
          {p.status === 'running' || p.status === 'queued' ? ' · refreshing every 2 seconds' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div role="progressbar" aria-label="Provisioning progress" aria-valuemin={0} aria-valuemax={p.steps.length} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${p.steps.length ? (done / p.steps.length) * 100 : 0}%` }} />
        </div>
        {p.lastError ? <Alert variant="destructive" title="Last error">{p.lastError}</Alert> : null}
        <ol className="relative grid gap-0" aria-live="polite">
          {p.steps.map((st, i) => (
            <li key={st.key} className="relative flex gap-3 pb-5 last:pb-0">
              {i < p.steps.length - 1 ? <span className="absolute top-6 left-2.5 h-[calc(100%-1.25rem)] w-px bg-border" aria-hidden /> : null}
              <span className="relative z-10 bg-card">
                <StepIcon status={st.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{humanize(st.key)}</span>
                  {st.status !== 'pending' ? <span className="text-xs text-muted-foreground">{humanize(st.status)}</span> : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {st.startedAt ? `Started ${formatDateTime(st.startedAt)}` : null}
                  {st.finishedAt ? ` · finished ${formatDateTime(st.finishedAt)}` : null}
                </div>
                {st.error ? <p className="mt-1 rounded-md bg-destructive/10 px-2 py-1 font-mono text-xs break-words text-destructive">{st.error}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-xs break-all select-all">{value}</code>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          onClick={async () => (await copyText(value)) ? toast.success(`${label} copied`) : toast.error('Couldn’t copy')}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

function Domains({ tenant }: { tenant: TenantDetail }) {
  const { canPlatform } = useAccess();
  const qc = useQueryClient();
  const canEdit = canPlatform('platform.tenants.update');
  const [record, setRecord] = useState<{ domain: string; name: string; value: string } | null>(null);
  const [removing, setRemoving] = useState<TenantDetail['domains'][number] | null>(null);
  const form = useForm<z.input<typeof addTenantDomainSchema>, unknown, z.output<typeof addTenantDomainSchema>>({
    resolver: zodResolver(addTenantDomainSchema),
    defaultValues: { domain: '' },
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: platformKeys.tenant(tenant.id) });
  const add = useMutation({
    mutationFn: (v: z.output<typeof addTenantDomainSchema>) =>
      api.post<{ id: string; verificationRecord: { name: string; value: string } }>(`/platform/tenants/${tenant.id}/domains`, v),
    meta: { silent: true },
  });
  const verify = useMutation({
    mutationFn: (domainId: string) => api.post<{ verified: boolean }>(`/platform/tenants/${tenant.id}/domains/${domainId}/verify`),
    onSuccess: (r) => {
      if (r.verified) toast.success('Domain verified');
      else toast.error('Not verified yet', { description: 'The TXT record wasn’t found. DNS changes can take a while to propagate.' });
      invalidate();
    },
  });
  const remove = useMutation({ mutationFn: (domainId: string) => api.delete(`/platform/tenants/${tenant.id}/domains/${domainId}`), onSuccess: invalidate });

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const res = await add.mutateAsync(v);
      setRecord({ domain: v.domain, ...res.verificationRecord });
      form.reset();
      invalidate();
      toast.success('Domain added', { description: 'Create the TXT record, then verify.' });
    } catch (e) {
      applyServerErrors(e, form.setError, ['domain']);
    }
  });

  return (
    <div className="grid gap-6">
      {canEdit ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a custom domain</CardTitle>
            <CardDescription>Point a hostname such as finance.acme.com at this tenant. Ownership is verified with a DNS TXT record.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
              <FormField label="Hostname" error={form.formState.errors.domain?.message} className="flex-1">
                <Input placeholder="finance.acme.com" autoComplete="off" {...form.register('domain')} />
              </FormField>
              <Button type="submit" className="sm:mt-6" loading={form.formState.isSubmitting}>
                <Plus /> Add domain
              </Button>
            </form>
            {record ? (
              <Alert variant="info" title={`Create this TXT record for ${record.domain}`}>
                <div className="mt-2 grid gap-3">
                  <CopyField label="Record name" value={record.name} />
                  <CopyField label="Record value" value={record.value} />
                </div>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      <Card className="overflow-hidden">
        {tenant.domains.length === 0 ? (
          <EmptyState icon={Globe} title="No custom domains" description={`Users reach this tenant at its ${tenant.slug} subdomain.`} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Domain</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenant.domains.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="text-sm">
                    <span className="font-mono">{d.domain}</span> {d.isPrimary ? <Badge variant="info" className="ml-2">Primary</Badge> : null}
                    {!d.verified && d.verificationRecord ? (
                      <div className="mt-2 grid max-w-lg gap-2 rounded-md border bg-muted/40 p-3">
                        <p className="text-xs text-muted-foreground">Create this DNS TXT record, then verify:</p>
                        <CopyField label="Record name" value={d.verificationRecord.name} />
                        <CopyField label="Record value" value={d.verificationRecord.value} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{d.verified ? <StatusBadge status="verified" /> : <StatusBadge status="pending" label="Unverified" />}</TableCell>
                  <TableCell className="text-right">
                    {canEdit ? (
                      <div className="flex justify-end gap-2">
                        {!d.verified ? (
                          <Button variant="outline" size="sm" onClick={() => verify.mutate(d.id)} loading={verify.isPending && verify.variables === d.id}>
                            Verify
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRemoving(d)}>
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        destructive
        title={`Remove ${removing?.domain}?`}
        description="Users will no longer reach the tenant at this hostname."
        confirmLabel="Remove domain"
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.id);
          toast.success('Domain removed');
        }}
      />
    </div>
  );
}

function Admins({ tenant }: { tenant: TenantDetail }) {
  const { canPlatform } = useAccess();
  const qc = useQueryClient();
  const canEdit = canPlatform('platform.tenants.update');
  const [addOpen, setAddOpen] = useState(false);
  const [resetting, setResetting] = useState<TenantDetail['admins'][number] | null>(null);
  const [resetMfa, setResetMfa] = useState(false);
  const reset = useMutation({
    mutationFn: (v: { accountId: string; resetMfa: boolean }) => api.post(`/platform/tenants/${tenant.id}/admins/${v.accountId}/reset-access`, { resetMfa: v.resetMfa }),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4 sm:pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Tenant administrators</CardTitle>
            <CardDescription>People with full control of this workspace.</CardDescription>
          </div>
          {canEdit ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <UserPlus /> Add admin
            </Button>
          ) : null}
        </div>
      </CardHeader>
      {tenant.admins.length === 0 ? (
        <EmptyState icon={UserCog} title="No administrators" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenant.admins.map((a) => (
              <TableRow key={a.accountId}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell className="text-muted-foreground">{a.email}</TableCell>
                <TableCell>
                  <StatusBadge status={a.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canEdit ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setResetMfa(false);
                        setResetting(a);
                      }}
                    >
                      Reset access
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <AddAdminDialog tenant={tenant} open={addOpen} onOpenChange={setAddOpen} onAdded={() => void qc.invalidateQueries({ queryKey: platformKeys.tenant(tenant.id) })} />
      <ConfirmDialog
        open={!!resetting}
        onOpenChange={(o) => !o && setResetting(null)}
        title={`Reset access for ${resetting?.name}?`}
        description="Their sessions are revoked and they receive an email to set a new password. Requires confirming your identity."
        confirmLabel="Reset access"
        destructive
        onConfirm={async () => {
          if (!resetting) return;
          await reset.mutateAsync({ accountId: resetting.accountId, resetMfa });
          toast.success('Access reset', { description: `${resetting.email} will receive recovery instructions.` });
        }}
      >
        <div className="flex items-center gap-2">
          <Checkbox id="reset-mfa" checked={resetMfa} onCheckedChange={(c) => setResetMfa(c === true)} />
          <Label htmlFor="reset-mfa" className="font-normal">
            Also reset two-factor authentication
          </Label>
        </div>
      </ConfirmDialog>
    </Card>
  );
}

function AddAdminDialog({ tenant, open, onOpenChange, onAdded }: { tenant: TenantDetail; open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const form = useForm<z.input<typeof addTenantAdminSchema>, unknown, z.output<typeof addTenantAdminSchema>>({
    resolver: zodResolver(addTenantAdminSchema),
    defaultValues: { email: '', name: '' },
  });
  const add = useMutation({ mutationFn: (v: z.output<typeof addTenantAdminSchema>) => api.post(`/platform/tenants/${tenant.id}/admins`, v), meta: { silent: true } });
  const close = (o: boolean) => {
    if (!o) form.reset();
    onOpenChange(o);
  };
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await add.mutateAsync(v);
      toast.success(`${v.email} added as an administrator`);
      onAdded();
      close(false);
    } catch (e) {
      applyServerErrors(e, form.setError, ['email', 'name']);
    }
  });
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>Add tenant administrator</DialogTitle>
            <DialogDescription>They get the Admin role in {tenant.name} and an invitation email. The tenant must be active.</DialogDescription>
          </DialogHeader>
          <FormField label="Email" required error={form.formState.errors.email?.message}>
            <Input type="email" autoFocus {...form.register('email')} />
          </FormField>
          <FormField label="Full name" required error={form.formState.errors.name?.message}>
            <Input {...form.register('name')} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Add admin
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
