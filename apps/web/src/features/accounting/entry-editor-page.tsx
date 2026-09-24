import { useQueryClient } from '@tanstack/react-query';
import { fromUnits, sumMoney, toUnits, type JournalEntryRow, type LedgerAccountRow } from '@daliz/shared';
import { ArrowLeft, CircleCheck, Plus, Trash, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { MoneyInput } from '@/components/app/money-input';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { NoAccess } from '@/components/layout/guards';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { amountOrZero, isPositive } from '@/lib/money';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { useUnsavedChanges } from '@/lib/unsaved';
import { cn, humanize } from '@/lib/utils';
import { accountingKeys, accountLabel, useJournalEntry, useLedgerAccounts } from './api';

interface Line {
  key: string;
  accountId: string | null;
  description: string;
  debit: string;
  credit: string;
}

const newLine = (): Line => ({ key: crypto.randomUUID(), accountId: null, description: '', debit: '', credit: '' });

export function EntryEditorPage() {
  const { id } = useParams();
  const { can } = useAccess();
  const accounts = useLedgerAccounts();
  const entry = useJournalEntry(id);
  useBreadcrumbTail(id ? (entry.data?.number ?? 'Edit entry') : 'New entry');

  if (!can(id ? 'accounting.update' : 'accounting.create')) return <NoAccess what="this action" />;
  if (accounts.isPending || (id && entry.isPending)) {
    return (
      <div className="grid grid-cols-1 gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (accounts.isError) return <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />;
  if (id && entry.isError) return <ErrorState error={entry.error} onRetry={() => void entry.refetch()} />;
  if (entry.data && !['draft', 'pending'].includes(entry.data.status)) {
    return (
      <Alert variant="warning" title="This entry can no longer be edited">
        Only draft and pending entries can be changed. <Link to={`/accounting/entries/${entry.data.id}`} className="font-medium text-primary underline">Back to the entry</Link>
      </Alert>
    );
  }
  return <EntryEditor key={entry.data ? `${entry.data.id}:${entry.data.version}` : 'new'} entry={entry.data} accounts={accounts.data} />;
}

function EntryEditor({ entry, accounts }: { entry: JournalEntryRow | undefined; accounts: LedgerAccountRow[] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fmt = useTenantFormat();
  const { canWrite } = useAccess();
  const idem = useIdempotencyKey();
  const tableRef = useRef<HTMLDivElement>(null);
  const [entryDate, setEntryDate] = useState(entry?.entryDate ?? fmt.today());
  const [description, setDescription] = useState(entry?.description ?? '');
  const [reference, setReference] = useState(entry?.reference ?? '');
  const [lines, setLines] = useState<Line[]>(() =>
    entry?.lines?.length
      ? entry.lines.map((l) => ({
          key: l.id,
          accountId: l.accountId,
          description: l.description,
          debit: toUnits(l.debit) > 0n ? fromUnits(toUnits(l.debit)).replace(/\.?0+$/, '') : '',
          credit: toUnits(l.credit) > 0n ? fromUnits(toUnits(l.credit)).replace(/\.?0+$/, '') : '',
        }))
      : [newLine(), newLine()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<ApiError | Error | null>(null);
  const [submitting, setSubmitting] = useState<null | 'save' | 'submit'>(null);
  useUnsavedChanges(!submitting && (description.trim() !== (entry?.description ?? '') || lines.some((l) => l.accountId || l.debit || l.credit)) && !entry);

  const options = useMemo(
    () =>
      accounts
        .filter((a) => a.isActive || lines.some((l) => l.accountId === a.id))
        .map((a) => ({ value: a.id, label: accountLabel(a), group: humanize(a.type), keywords: a.subtype })),
    [accounts],
  );

  const totalDebit = sumMoney(lines.map((l) => amountOrZero(l.debit)));
  const totalCredit = sumMoney(lines.map((l) => amountOrZero(l.credit)));
  const diff = toUnits(totalDebit) - toUnits(totalCredit);
  const hasAmounts = toUnits(totalDebit) > 0n;
  const balanced = diff === 0n && hasAmounts;

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    setLines((ls) => [...ls, newLine()]);
    requestAnimationFrame(() => {
      const triggers = tableRef.current?.querySelectorAll<HTMLButtonElement>('button.line-account');
      triggers?.[triggers.length - 1]?.focus();
    });
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) e.entryDate = 'Choose a date';
    if (!description.trim()) e.description = 'Required';
    const used = lines.filter((l) => l.accountId || l.debit || l.credit || l.description);
    used.forEach((l) => {
      if (!l.accountId) e[`${l.key}.account`] = 'Choose an account';
      const d = isPositive(l.debit);
      const c = isPositive(l.credit);
      if (d === c) e[`${l.key}.amount`] = 'Enter a debit or a credit';
    });
    if (used.length < 2) e.lines = 'An entry needs at least two lines';
    if (!balanced) e.lines = e.lines ?? 'Debits and credits must be equal';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev: FormEvent | null, mode: 'save' | 'submit') => {
    ev?.preventDefault();
    setServerError(null);
    if (!validate()) return;
    const body = {
      entryDate,
      description: description.trim(),
      reference: reference.trim() || null,
      lines: lines
        .filter((l) => l.accountId)
        .map((l) => ({ accountId: l.accountId!, description: l.description.trim(), debit: amountOrZero(l.debit), credit: amountOrZero(l.credit) })),
    };
    setSubmitting(mode);
    try {
      let saved: JournalEntryRow;
      if (entry) {
        saved = await api.put<JournalEntryRow>(`/accounting/journal-entries/${entry.id}`, { ...body, version: entry.version });
      } else {
        saved = await withIdempotency(idem, body, (key) => api.post<JournalEntryRow>('/accounting/journal-entries', body, { idempotencyKey: key }));
      }
      if (mode === 'submit' && saved.status === 'draft') {
        saved = await api.post<JournalEntryRow>(`/accounting/journal-entries/${saved.id}/submit`, {});
      }
      qc.setQueryData(accountingKeys.entry(saved.id), saved);
      void qc.invalidateQueries({ queryKey: accountingKeys.entriesAll });
      toast.success(mode === 'submit' ? 'Entry submitted for approval' : entry ? 'Entry saved' : 'Draft entry created');
      navigate(`/accounting/entries/${saved.id}`, { replace: !!entry });
    } catch (e) {
      setServerError(e instanceof Error ? e : new Error(errorMessage(e)));
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') void qc.invalidateQueries({ queryKey: accountingKeys.entry(entry?.id ?? '') });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e, 'save')} noValidate>
      <PageHeader
        title={entry ? `Edit ${entry.number ?? 'entry'}` : 'New journal entry'}
        description="Every entry must balance: total debits equal total credits."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={entry ? `/accounting/entries/${entry.id}` : '/accounting'}>
                <ArrowLeft /> Cancel
              </Link>
            </Button>
            <Button type="submit" variant="secondary" loading={submitting === 'save'} disabled={!balanced || submitting !== null}>
              {entry ? 'Save changes' : 'Save draft'}
            </Button>
            {(!entry || entry.status === 'draft') && canWrite('accounting.create') ? (
              <Button onClick={() => void submit(null, 'submit')} loading={submitting === 'submit'} disabled={!balanced || submitting !== null}>
                Save and submit
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6">
        {serverError ? (
          <Alert variant="destructive" title="Couldn’t save the entry">
            {serverError.message}
            {serverError instanceof ApiError && serverError.details.length ? (
              <ul className="mt-1 list-disc pl-4">
                {serverError.details.map((d) => (
                  <li key={d.path + d.message}>{d.message}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)_200px]">
            <FormField label="Date" required error={errors.entryDate}>
              <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </FormField>
            <FormField label="Description" required error={errors.description}>
              <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Office rent for September" autoFocus={!entry} />
            </FormField>
            <FormField label="Reference">
              <Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder="Invoice or receipt no." />
            </FormField>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="px-0 sm:px-0">
            <div ref={tableRef} className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-y text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    <th className="w-8 px-4 py-2" aria-label="Line number" />
                    <th className="px-2 py-2">Account</th>
                    <th className="px-2 py-2">Description</th>
                    <th className="w-36 px-2 py-2 text-right">Debit</th>
                    <th className="w-36 px-2 py-2 text-right">Credit</th>
                    <th className="w-12 px-2 py-2" aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.key} className="border-b align-top">
                      <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{i + 1}</td>
                      <td className="px-2 py-2">
                        <Combobox
                          className="line-account"
                          aria-label={`Account for line ${i + 1}`}
                          options={options}
                          value={l.accountId}
                          onChange={(v) => update(l.key, { accountId: v })}
                          placeholder="Choose account"
                          searchPlaceholder="Search by code or name…"
                          invalid={!!errors[`${l.key}.account`]}
                        />
                        {errors[`${l.key}.account`] ? <p className="mt-1 text-xs text-destructive">{errors[`${l.key}.account`]}</p> : null}
                      </td>
                      <td className="px-2 py-2">
                        <Input aria-label={`Description for line ${i + 1}`} value={l.description} maxLength={300} onChange={(e) => update(l.key, { description: e.target.value })} />
                      </td>
                      <td className="px-2 py-2">
                        <MoneyInput
                          aria-label={`Debit for line ${i + 1}`}
                          aria-invalid={!!errors[`${l.key}.amount`] || undefined}
                          value={l.debit}
                          placeholder="0.00"
                          onValueChange={(v) => update(l.key, { debit: v, credit: v ? '' : l.credit })}
                        />
                        {errors[`${l.key}.amount`] ? <p className="mt-1 text-xs text-destructive">{errors[`${l.key}.amount`]}</p> : null}
                      </td>
                      <td className="px-2 py-2">
                        <MoneyInput
                          aria-label={`Credit for line ${i + 1}`}
                          aria-invalid={!!errors[`${l.key}.amount`] || undefined}
                          value={l.credit}
                          placeholder="0.00"
                          onValueChange={(v) => update(l.key, { credit: v, debit: v ? '' : l.debit })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && i === lines.length - 1) {
                              e.preventDefault();
                              addLine();
                            }
                          }}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove line ${i + 1}`}
                          disabled={lines.length <= 2}
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        >
                          <Trash />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <td />
                    <td className="px-2 py-3">
                      <Button variant="outline" size="sm" onClick={addLine}>
                        <Plus /> Add line
                      </Button>
                    </td>
                    <td className="px-2 py-3 text-right text-muted-foreground">Totals</td>
                    <td className="px-2 py-3 text-right font-mono tabular-nums">{fmt.money(totalDebit)}</td>
                    <td className="px-2 py-3 text-right font-mono tabular-nums">{fmt.money(totalCredit)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div
              className={cn(
                'mx-5 mt-2 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium sm:mx-6',
                balanced ? 'border-success/30 bg-success/5 text-success' : 'border-warning/30 bg-warning/5 text-warning',
              )}
              role="status"
              aria-live="polite"
            >
              {balanced ? <CircleCheck className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
              {balanced
                ? `Balanced — ${fmt.money(totalDebit)}`
                : !hasAmounts
                  ? 'Enter amounts to balance the entry'
                  : `Out of balance by ${fmt.money(fromUnits(diff < 0n ? -diff : diff))} (${diff > 0n ? 'more debits' : 'more credits'})`}
            </div>
            {errors.lines ? <p className="mx-5 mt-2 text-sm text-destructive sm:mx-6">{errors.lines}</p> : null}
            <p className="mx-5 mt-2 text-xs text-muted-foreground sm:mx-6">Tip: press Enter in the last credit cell to add a line.</p>
          </CardContent>
        </Card>
      </div>
    </form>
  );
}
