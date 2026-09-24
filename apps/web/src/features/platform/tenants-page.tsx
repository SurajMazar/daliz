import { TENANT_STATUSES_PUBLIC } from '@daliz/shared';
import { Plus, Search, Server, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDebouncedValue } from '@/lib/hooks';
import { useAccess } from '@/lib/session';
import { formatDate, humanize, ago } from '@/lib/utils';
import { useTenants } from './api';
import { CreateTenantDialog } from './create-tenant-dialog';

export function TenantsPage() {
  const { canPlatform } = useAccess();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const organizationId = params.get('organizationId') ?? undefined;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
  const tenants = useTenants({ page, pageSize: 20, q: q || undefined, status: status || undefined, organizationId });
  const filtered = !!(q || status || organizationId);

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Every workspace, its database and provisioning state."
        actions={
          canPlatform('platform.tenants.create') ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Create tenant
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
              aria-label="Search tenants"
              placeholder="Search by name or slug…"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="sm:w-52">
            <NativeSelect
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {TENANT_STATUSES_PUBLIC.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          </div>
          {organizationId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                params.delete('organizationId');
                setParams(params, { replace: true });
              }}
            >
              <X /> Organization filter
            </Button>
          ) : null}
        </div>
        {tenants.isPending ? (
          <SkeletonRows rows={6} cols={6} />
        ) : tenants.isError ? (
          <ErrorState error={tenants.error} onRetry={() => void tenants.refetch()} />
        ) : tenants.data.items.length === 0 ? (
          <EmptyState
            icon={Server}
            title={filtered ? 'No tenants match your filters' : 'No tenants yet'}
            action={
              !filtered && canPlatform('platform.tenants.create') ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus /> Create tenant
                </Button>
              ) : null
            }
          />
        ) : (
          <Table aria-busy={tenants.isFetching || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tenant</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Admin</TableHead>
                <TableHead>Database</TableHead>
                <TableHead className="hidden xl:table-cell">Created</TableHead>
                <TableHead className="hidden xl:table-cell">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.data.items.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => navigate(`/platform/tenants/${t.id}`)}>
                  <TableCell>
                    <Link to={`/platform/tenants/${t.id}`} className="font-medium outline-none hover:underline focus-visible:underline" onClick={(e) => e.stopPropagation()}>
                      {t.name}
                    </Link>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{t.slug}</span>
                      <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                        {humanize(t.plan)}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.organizationName}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="hidden max-w-[14rem] truncate text-muted-foreground lg:table-cell">{t.primaryAdminEmail ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={t.databaseStatus} />
                      <span className="font-mono text-[11px] text-muted-foreground">{t.schemaVersion ?? 'no schema'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">{formatDate(t.createdAt)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">{t.lastActivityAt ? ago(t.lastActivityAt) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {tenants.data && tenants.data.meta.total > 0 ? <Pagination meta={tenants.data.meta} onPageChange={setPage} noun="tenants" /> : null}
      </Card>
      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} defaultOrganizationId={organizationId} />
    </>
  );
}
