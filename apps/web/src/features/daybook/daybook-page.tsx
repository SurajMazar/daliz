import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { daybookEntryInputSchema, type DaybookEntryRow, type DaybookKind, type DaybookSummary } from '@daliz/shared';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BookOpen, Ban, Ellipsis, Landmark, Pencil, Search, Wallet, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Controlled } from '@/components/app/controlled';
import { ErrorState } from '@/components/app/error-state';
import { MoneyInput } from '@/components/app/money-input';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Pagination } from '@/components/ui/pagination';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage, type Query } from '@/lib/api';
import { addMonths, endOfMonth, formatIsoDate, startOfMonth, startOfYear } from '@/lib/dates';
import { applyServerErrors } from '@/lib/forms';
import { useDebouncedValue } from '@/lib/hooks';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn } from '@/lib/utils';

interface FormAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}
interface FormAccounts {
  money: FormAccount[];
  income: FormAccount[];
  expense: FormAccount[];
}

const keys = {
  accounts: ['daybook', 'accounts'] as const,
  summary: (from: string, to: string) => ['daybook', 'summary', from, to] as const,
  entries: (q: Query) => ['daybook', 'entries', q] as const,
  all: ['daybook'] as const,
};

type Period = 'this-month' | 'last-month' | 'this-year' | 'custom';

export function DaybookPage() {
  const { canWrite } = useAccess();
  const fmt = useTenantFormat();
  const today = fmt.today();
  const [period, setPeriod] = useState<Period>('this-month');
  const [custom, setCustom] = useState({ from: startOfMonth(today), to: today });
  const range = useMemo(() => {
    switch (period) {
      case 'this-month':
        return { from: startOfMonth(today), to: endOfMonth(today) };
      case 'last-month': {
        const last = addMonths(today, -1);
        return { from: last, to: endOfMonth(last) };
      }
      case 'this-year':
        return { from: startOfYear(today), to: today };
      default:
        return custom;
    }
  }, [period, custom, today]);

  const accounts = useQuery({ queryKey: keys.accounts, queryFn: () => api.get<FormAccounts>('/daybook/accounts') });
  const summary = useQuery({
    queryKey: keys.summary(range.from, range.to),
    queryFn: () => api.get<DaybookSummary>('/daybook/summary', range),
    enabled: range.from <= range.to,
  });

  return (
    <>
      <PageHeader
        title="Daybook"
        description="Record everyday money in and out. Entries wait for approval before they reach the ledger."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="period" className="text-xs text-muted-foreground">
                Period
              </Label>
              <NativeSelect id="period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="w-40">
                <option value="this-month">This month</option>
                <option value="last-month">Last month</option>
                <option value="this-year">This year</option>
                <option value="custom">Custom…</option>
              </NativeSelect>
            </div>
            {period === 'custom' ? (
              <>
                <Input type="date" aria-label="From" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} className="w-40" />
                <Input type="date" aria-label="To" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} className="w-40" />
              </>
            ) : null}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-6">
        <SummaryCards summary={summary.data} loading={summary.isPending} error={summary.error} onRetry={() => void summary.refetch()} range={range} />
        {canWrite('daybook.create') ? (
          accounts.isError ? (
            <Card>
              <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Quick entry</CardTitle>
                <CardDescription>Income, an expense, or a transfer between your cash and bank accounts.</CardDescription>
              </CardHeader>
              <CardContent>
                {accounts.data ? <EntryForm accounts={accounts.data} /> : <Skeleton className="h-48" />}
              </CardContent>
            </Card>
          )
        ) : null}
        <EntriesList accounts={accounts.data} />
      </div>
    </>
  );
}

function SummaryCards({ summary, loading, error, onRetry, range }: { summary: DaybookSummary | undefined; loading: boolean; error: unknown; onRetry: () => void; range: { from: string; to: string } }) {
  const fmt = useTenantFormat();
  if (error) {
    return (
      <Card>
        <ErrorState error={error} onRetry={onRetry} />
      </Card>
    );
  }
  const stat = (label: string, value: string | undefined, icon: typeof Wallet, tone?: string) => {
    const Icon = icon;
    return (
      <Card>
        <CardContent className="grid gap-2">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="font-medium">{label}</span>
            <Icon className="size-4" aria-hidden />
          </div>
          {loading || value === undefined ? <Skeleton className="h-7 w-28" /> : <div className={cn('text-2xl font-semibold tracking-tight tabular-nums', tone)}>{fmt.money(value)}</div>}
          <div className="text-xs text-muted-foreground">
            {formatIsoDate(range.from, { dateStyle: 'medium' }, fmt.locale)} – {formatIsoDate(range.to, { dateStyle: 'medium' }, fmt.locale)} · posted only
          </div>
        </CardContent>
      </Card>
    );
  };
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {stat('Income', summary?.income, ArrowDownLeft, 'text-success')}
        {stat('Expenses', summary?.expense, ArrowUpRight)}
        {stat('Net', summary?.net, Wallet, summary?.net.startsWith('-') ? 'text-destructive' : undefined)}
      </div>
      {summary && summary.byAccount.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summary.byAccount.map((a) => (
            <div key={a.accountId} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Landmark className="size-3.5" aria-hidden /> {a.name}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{fmt.money(a.balance)}</div>
              <div className="text-xs text-muted-foreground">
                +{fmt.money(a.inflow)} · −{fmt.money(a.outflow)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type FormValues = z.input<typeof daybookEntryInputSchema>;
type FormOutput = z.output<typeof daybookEntryInputSchema>;

const KIND_OPTIONS: { value: DaybookKind; label: string; icon: ReactNode }[] = [
  { value: 'income', label: 'Income', icon: <ArrowDownLeft /> },
  { value: 'expense', label: 'Expense', icon: <ArrowUpRight /> },
  { value: 'transfer', label: 'Transfer', icon: <ArrowLeftRight /> },
];

function EntryForm({ accounts, entry, onDone }: { accounts: FormAccounts; entry?: DaybookEntryRow; onDone?: () => void }) {
  const { canWrite, can } = useAccess();
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const idem = useIdempotencyKey();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormValues, unknown, FormOutput>({
    resolver: zodResolver(daybookEntryInputSchema),
    defaultValues: {
      kind: entry?.kind ?? 'expense',
      entryDate: entry?.entryDate ?? fmt.today(),
      amount: entry ? entry.amount.replace(/\.?0+$/, '') : '',
      moneyAccountId: entry?.moneyAccount.id ?? accounts.money.find((a) => a.subtype === 'bank')?.id ?? accounts.money[0]?.id ?? '',
      counterAccountId: entry?.counterAccount.id ?? '',
      counterparty: entry?.counterparty ?? '',
      description: entry?.description ?? '',
      reference: entry?.reference ?? '',
      postImmediately: false,
    },
  });
  const kind = form.watch('kind');
  const moneyAccountId = form.watch('moneyAccountId');
  const categories = kind === 'income' ? accounts.income : kind === 'expense' ? accounts.expense : accounts.money.filter((a) => a.id !== moneyAccountId);

  // Keep the category valid when the kind (or the transfer source) changes.
  useEffect(() => {
    const current = form.getValues('counterAccountId');
    if (current && !categories.some((c) => c.id === current)) form.setValue('counterAccountId', '');
  }, [kind, moneyAccountId, categories, form]);

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const body = { ...v, counterparty: v.counterparty || null, reference: v.reference || null };
    try {
      if (entry) {
        const { postImmediately: _ignored, ...rest } = body;
        void _ignored;
        await api.put(`/daybook/entries/${entry.id}`, { ...rest, version: entry.version });
        toast.success('Entry updated');
      } else {
        const created = await withIdempotency(idem, body, (key) => api.post<DaybookEntryRow>('/daybook/entries', body, { idempotencyKey: key }));
        toast.success(created.status === 'posted' ? `Posted as ${created.journalNumber ?? 'a journal entry'}` : 'Entry recorded — waiting for approval');
        form.reset({ ...form.getValues(), amount: '', counterparty: '', description: '', reference: '', postImmediately: false });
      }
      void qc.invalidateQueries({ queryKey: keys.all });
      void qc.invalidateQueries({ queryKey: ['accounting'] });
      onDone?.();
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['entryDate', 'kind', 'amount', 'moneyAccountId', 'counterAccountId', 'counterparty', 'description', 'reference'], { toastUnmatched: false })) {
        setError(errorMessage(e));
      }
    }
  });

  const e = form.formState.errors;
  const moneyLabel = kind === 'income' ? 'Received into' : kind === 'expense' ? 'Paid from' : 'From account';
  const counterLabel = kind === 'income' ? 'Income category' : kind === 'expense' ? 'Expense category' : 'To account';

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {error ? <Alert variant="destructive" title={error} /> : null}
      <Controller control={form.control} name="kind" render={({ field }) => <Segmented label="Entry type" value={field.value} onChange={field.onChange} options={KIND_OPTIONS} className="w-full sm:w-auto" />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Amount" required error={e.amount?.message}>
          <Controlled control={form.control} name="amount" render={(field, props) => <MoneyInput {...props} value={field.value} onValueChange={field.onChange} onBlur={field.onBlur} placeholder="0.00" />} />
        </FormField>
        <FormField label="Date" required error={e.entryDate?.message}>
          <Input type="date" {...form.register('entryDate')} />
        </FormField>
        <FormField label={moneyLabel} required error={e.moneyAccountId?.message}>
          <NativeSelect {...form.register('moneyAccountId')}>
            {accounts.money.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label={counterLabel} required error={e.counterAccountId?.message ? 'Choose one' : undefined}>
          <NativeSelect {...form.register('counterAccountId')}>
            <option value="">Choose…</option>
            {categories.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <FormField label="Description" required error={e.description?.message}>
          <Input maxLength={500} placeholder={kind === 'expense' ? 'e.g. Printer paper' : kind === 'income' ? 'e.g. Invoice 1042 paid' : 'e.g. Move to savings'} {...form.register('description')} />
        </FormField>
        <FormField label={kind === 'income' ? 'Received from' : kind === 'expense' ? 'Paid to' : 'Counterparty'} error={e.counterparty?.message}>
          <Input maxLength={200} {...form.register('counterparty')} />
        </FormField>
        <FormField label="Reference" error={e.reference?.message}>
          <Input maxLength={100} placeholder="Receipt no." {...form.register('reference')} />
        </FormField>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!entry && can('accounting.approve') ? (
          <div className="flex items-center gap-2">
            <Controller control={form.control} name="postImmediately" render={({ field }) => <Checkbox id="post-now" checked={!!field.value} onCheckedChange={(c) => field.onChange(c === true)} />} />
            <Label htmlFor="post-now" className="font-normal">
              Post immediately (skip approval)
            </Label>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{entry ? 'Only pending entries can be edited.' : 'An approver will post this entry to the ledger.'}</span>
        )}
        <div className="flex gap-2">
          {onDone && entry ? (
            <Button variant="outline" onClick={onDone} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" loading={form.formState.isSubmitting} disabled={!canWrite(entry ? 'daybook.update' : 'daybook.create')}>
            {entry ? 'Save changes' : 'Record entry'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function EntriesList({ accounts }: { accounts: FormAccounts | undefined }) {
  const { can, canWrite } = useAccess();
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<DaybookEntryRow | null>(null);
  const [voiding, setVoiding] = useState<DaybookEntryRow | null>(null);
  const q = useDebouncedValue(search.trim(), 300);
  const query: Query = { page, pageSize: 25, kind: kind || undefined, status: status || undefined, from: from || undefined, to: to || undefined, q: q || undefined };
  const list = useQuery({ queryKey: keys.entries(query), queryFn: () => api.list<DaybookEntryRow>('/daybook/entries', query), placeholderData: keepPreviousData });
  const voidEntry = useMutation({
    mutationFn: (id: string) => api.post(`/daybook/entries/${id}/void`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.all });
      void qc.invalidateQueries({ queryKey: ['accounting'] });
    },
  });
  const filtered = !!(kind || status || from || to || q);
  const set = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4 sm:pb-4">
        <CardTitle>Entries</CardTitle>
      </CardHeader>
      <div className="grid gap-3 border-y p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Search entries" placeholder="Search description or counterparty…" className="pl-9" value={search} onChange={(e) => set(setSearch)(e.target.value)} />
        </div>
        <NativeSelect aria-label="Kind" value={kind} onChange={(e) => set(setKind)(e.target.value)}>
          <option value="">All kinds</option>
          <option value="income">Income</option>
          <option value="expense">Expense</option>
          <option value="transfer">Transfer</option>
        </NativeSelect>
        <NativeSelect aria-label="Status" value={status} onChange={(e) => set(setStatus)(e.target.value)}>
          <option value="">Any status</option>
          <option value="pending">Pending</option>
          <option value="posted">Posted</option>
          <option value="void">Void</option>
        </NativeSelect>
        <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => set(setFrom)(e.target.value)} />
        <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => set(setTo)(e.target.value)} />
        <Button
          variant="ghost"
          disabled={!filtered}
          onClick={() => {
            setKind('');
            setStatus('');
            setFrom('');
            setTo('');
            setSearch('');
            setPage(1);
          }}
        >
          <X /> Clear
        </Button>
      </div>
      {list.isPending ? (
        <SkeletonRows rows={6} cols={5} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={BookOpen} title={filtered ? 'No entries match your filters' : 'No daybook entries yet'} />
      ) : (
        <Table aria-busy={list.isFetching || undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="hidden lg:table-cell">Accounts</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.items.map((d) => {
              const pending = d.status === 'pending';
              const actions = { edit: pending && canWrite('daybook.update'), void: pending && canWrite('daybook.delete') };
              return (
                <TableRow key={d.id} className={cn(d.status === 'void' && 'opacity-60')}>
                  <TableCell className="whitespace-nowrap">{formatIsoDate(d.entryDate, undefined, fmt.locale)}</TableCell>
                  <TableCell className="max-w-xs">
                    <div className="flex items-center gap-2">
                      <KindIcon kind={d.kind} />
                      <span className="truncate font-medium">{d.description}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[d.counterparty, d.reference ? `Ref ${d.reference}` : null, d.createdBy ? `by ${d.createdBy.name}` : null].filter(Boolean).join(' · ')}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {d.kind === 'income' ? `${d.counterAccount.name} → ${d.moneyAccount.name}` : `${d.moneyAccount.name} → ${d.counterAccount.name}`}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={d.status === 'posted' ? 'success' : d.status === 'pending' ? 'warning' : 'muted'}>
                        {d.status === 'pending' ? 'Pending approval' : d.status === 'posted' ? 'Posted' : 'Void'}
                      </Badge>
                      {d.journalEntryId && can('accounting.read') ? (
                        <Link to={`/accounting/entries/${d.journalEntryId}`} className="font-mono text-xs text-primary hover:underline">
                          {d.journalNumber ?? 'View journal entry'}
                        </Link>
                      ) : d.journalNumber ? (
                        <span className="font-mono text-xs text-muted-foreground">{d.journalNumber}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className={cn('text-right font-mono tabular-nums whitespace-nowrap', d.kind === 'income' && 'text-success')}>
                    {d.kind === 'income' ? '+' : d.kind === 'expense' ? '−' : ''}
                    {fmt.money(d.amount)}
                  </TableCell>
                  <TableCell>
                    {actions.edit || actions.void ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.description}`}>
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {actions.edit ? (
                            <DropdownMenuItem onSelect={() => setEditing(d)} disabled={!accounts}>
                              <Pencil /> Edit
                            </DropdownMenuItem>
                          ) : null}
                          {actions.void ? (
                            <DropdownMenuItem destructive onSelect={() => setVoiding(d)}>
                              <Ban /> Void
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
      {list.data && list.data.meta.total > 0 ? <Pagination meta={list.data.meta} onPageChange={setPage} noun="entries" /> : null}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit entry</DialogTitle>
            <DialogDescription>Changes update the pending journal entry too.</DialogDescription>
          </DialogHeader>
          {editing && accounts ? <EntryForm accounts={accounts} entry={editing} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        destructive
        title="Void this entry?"
        description="It stays in the list for the record but never reaches the ledger."
        confirmLabel="Void entry"
        onConfirm={async () => {
          if (!voiding) return;
          await voidEntry.mutateAsync(voiding.id);
          toast.success('Entry voided');
        }}
      />
    </Card>
  );
}

function KindIcon({ kind }: { kind: DaybookKind }) {
  const Icon = kind === 'income' ? ArrowDownLeft : kind === 'expense' ? ArrowUpRight : ArrowLeftRight;
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full',
        kind === 'income' ? 'bg-success/10 text-success' : kind === 'expense' ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary',
      )}
      aria-label={kind}
      role="img"
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}
