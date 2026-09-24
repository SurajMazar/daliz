import type { JournalStatus } from '@daliz/shared';
import { BookOpen, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatIsoDate } from '@/lib/dates';
import { useDebouncedValue } from '@/lib/hooks';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { humanize } from '@/lib/utils';
import { AccountingTabs } from './accounting-tabs';
import { accountLabel, useJournalEntries, useLedgerAccounts } from './api';
import { JournalStatusBadge } from './journal-status';

const STATUS_TABS: { value: 'all' | JournalStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'posted', label: 'Posted' },
  { value: 'reversed', label: 'Reversed' },
];

export function JournalListPage() {
  const { canWrite } = useAccess();
  const fmt = useTenantFormat();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'all' | JournalStatus>('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim(), 300);
  const accounts = useLedgerAccounts();
  const entries = useJournalEntries({
    page,
    pageSize: 25,
    status: status === 'all' ? undefined : status,
    q: q || undefined,
    from: from || undefined,
    to: to || undefined,
    accountId: accountId ?? undefined,
  });
  const accountOptions = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: accountLabel(a), group: humanize(a.type) })),
    [accounts.data],
  );
  const filtered = !!(q || from || to || accountId);
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Accounting"
        description="Journal entries, the chart of accounts and financial reports."
        actions={
          canWrite('accounting.create') ? (
            <Button asChild>
              <Link to="/accounting/entries/new">
                <Plus /> New journal entry
              </Link>
            </Button>
          ) : null
        }
      />
      <AccountingTabs />
      <Card className="overflow-hidden">
        <div className="grid gap-3 border-b p-4">
          <Tabs value={status} onValueChange={(v) => reset(setStatus)(v as typeof status)}>
            <TabsList aria-label="Filter by status">
              {STATUS_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" aria-label="Search entries" placeholder="Search number, description, reference…" className="pl-9" value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
            </div>
            <Combobox aria-label="Filter by account" options={accountOptions} value={accountId} onChange={reset(setAccountId)} placeholder="Any account" allowClear searchPlaceholder="Search accounts…" />
            <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => reset(setFrom)(e.target.value)} />
            <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => reset(setTo)(e.target.value)} />
            <Button
              variant="ghost"
              disabled={!filtered}
              onClick={() => {
                setSearch('');
                setFrom('');
                setTo('');
                setAccountId(null);
                setPage(1);
              }}
            >
              <X /> Clear
            </Button>
          </div>
        </div>
        {entries.isPending ? (
          <SkeletonRows rows={8} cols={6} />
        ) : entries.isError ? (
          <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />
        ) : entries.data.items.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={filtered || status !== 'all' ? 'No entries match your filters' : 'No journal entries yet'}
            action={
              canWrite('accounting.create') && !filtered && status === 'all' ? (
                <Button asChild size="sm">
                  <Link to="/accounting/entries/new">
                    <Plus /> New journal entry
                  </Link>
                </Button>
              ) : null
            }
          />
        ) : (
          <Table aria-busy={entries.isFetching || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="hidden lg:table-cell">Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data.items.map((e) => (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => navigate(`/accounting/entries/${e.id}`)}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    <Link to={`/accounting/entries/${e.id}`} className="outline-none hover:underline focus-visible:underline" onClick={(ev) => ev.stopPropagation()}>
                      {e.number ?? <span className="text-muted-foreground">Unnumbered</span>}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatIsoDate(e.entryDate, undefined, fmt.locale)}</TableCell>
                  <TableCell className="max-w-md">
                    <div className="truncate">{e.description}</div>
                    {e.reference ? <div className="truncate text-xs text-muted-foreground">Ref {e.reference}</div> : null}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Badge variant="outline">{humanize(e.source)}</Badge>
                  </TableCell>
                  <TableCell>
                    <JournalStatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums whitespace-nowrap">{fmt.money(e.totalAmount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {entries.data && entries.data.meta.total > 0 ? <Pagination meta={entries.data.meta} onPageChange={setPage} noun="entries" /> : null}
      </Card>
    </>
  );
}
