import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reverseJournalEntrySchema, sumMoney, type JournalEntryRow } from '@daliz/shared';
import {
  ArrowLeft,
  CircleCheck,
  Circle,
  Pencil,
  Printer,
  Send,
  Stamp,
  Trash,
  Undo2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { OnlineOnly } from '@/components/app/online-only';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatIsoDate } from '@/lib/dates';
import { applyServerErrors } from '@/lib/forms';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn, formatDateTime, humanize } from '@/lib/utils';
import { AccountingTabs } from './accounting-tabs';
import { accountingKeys, useAccountingSettings, useJournalEntry } from './api';
import { JournalStatusBadge } from './journal-status';

type Action = 'submit' | 'approve' | 'post' | 'delete' | 'reverse' | null;

export function EntryDetailPage() {
  const { id = '' } = useParams();
  const entry = useJournalEntry(id);
  useBreadcrumbTail(entry.data ? (entry.data.number ?? 'Draft entry') : null);

  if (entry.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (entry.isError) return <ErrorState error={entry.error} onRetry={() => void entry.refetch()} />;
  return <EntryDetail entry={entry.data} />;
}

function EntryDetail({ entry }: { entry: JournalEntryRow }) {
  const { canWrite, me } = useAccess();
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useAccountingSettings();
  const [action, setAction] = useState<Action>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const postIdem = useIdempotencyKey();

  const refresh = (updated?: JournalEntryRow) => {
    if (updated) qc.setQueryData(accountingKeys.entry(updated.id), updated);
    void qc.invalidateQueries({ queryKey: accountingKeys.entriesAll });
    void qc.invalidateQueries({ queryKey: accountingKeys.accounts });
    void qc.invalidateQueries({ queryKey: ['accounting', 'report'] });
  };

  const transition = useMutation({
    mutationFn: async (kind: 'submit' | 'approve' | 'post') => {
      if (kind === 'post') {
        return withIdempotency(postIdem, { id: entry.id, kind }, (key) =>
          api.post<JournalEntryRow>(
            `/accounting/journal-entries/${entry.id}/post`,
            {},
            { idempotencyKey: key },
          ),
        );
      }
      return api.post<JournalEntryRow>(`/accounting/journal-entries/${entry.id}/${kind}`);
    },
    meta: { silent: true },
    onMutate: () => setActionError(null),
    onSuccess: (updated, kind) => {
      refresh(updated);
      toast.success(
        kind === 'submit'
          ? 'Submitted for approval'
          : kind === 'approve'
            ? 'Entry approved'
            : `Posted as ${updated.number}`,
      );
    },
    onError: (e) => {
      setActionError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: accountingKeys.entry(entry.id) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/accounting/journal-entries/${entry.id}`),
  });

  const s = entry.status;
  const requireApproval = settings.data?.requireApproval ?? true;
  const editable = s === 'draft' || s === 'pending';
  const can = {
    submit: s === 'draft' && canWrite('accounting.create'),
    approve: s === 'pending' && canWrite('accounting.approve'),
    post: canWrite('accounting.approve') && (s === 'approved' || (!requireApproval && editable)),
    edit: editable && canWrite('accounting.update'),
    delete: editable && canWrite('accounting.delete'),
    reverse:
      s === 'posted' &&
      entry.source !== 'reversal' &&
      !entry.reversedById &&
      canWrite('accounting.approve'),
  };
  const lines = entry.lines ?? [];
  const totalDebit = sumMoney(lines.map((l) => l.debit));
  const totalCredit = sumMoney(lines.map((l) => l.credit));
  const sod = settings.data?.segregationOfDuties && entry.createdBy?.id === me.tenant?.userId;

  return (
    <>
      <PageHeader
        title={entry.number ?? `${humanize(s)} entry`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <JournalStatusBadge status={s} />
            <span>{formatIsoDate(entry.entryDate, { dateStyle: 'long' }, fmt.locale)}</span>
            <Badge variant="outline">{humanize(entry.source)}</Badge>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button asChild variant="outline">
              <Link to="/accounting">
                <ArrowLeft /> Journal
              </Link>
            </Button>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {can.edit ? (
              <Button asChild variant="outline">
                <Link to={`/accounting/entries/${entry.id}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
            ) : null}
            {can.delete ? (
              <OnlineOnly>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setAction('delete')}
                >
                  <Trash /> Delete
                </Button>
              </OnlineOnly>
            ) : null}
            {can.submit ? (
              <OnlineOnly>
                <Button
                  variant={can.post ? 'outline' : 'default'}
                  onClick={() => transition.mutate('submit')}
                  loading={transition.isPending && transition.variables === 'submit'}
                >
                  <Send /> Submit
                </Button>
              </OnlineOnly>
            ) : null}
            {can.approve ? (
              <OnlineOnly>
                <Button
                  onClick={() => transition.mutate('approve')}
                  loading={transition.isPending && transition.variables === 'approve'}
                  disabled={!!sod}
                >
                  <CircleCheck /> Approve
                </Button>
              </OnlineOnly>
            ) : null}
            {can.post ? (
              <OnlineOnly>
                <Button onClick={() => setAction('post')}>
                  <Stamp /> Post
                </Button>
              </OnlineOnly>
            ) : null}
            {can.reverse ? (
              <OnlineOnly>
                <Button variant="outline" onClick={() => setAction('reverse')}>
                  <Undo2 /> Reverse
                </Button>
              </OnlineOnly>
            ) : null}
          </div>
        }
      />
      <div className="print:hidden">
        <AccountingTabs />
      </div>
      <div className="grid grid-cols-1 gap-6">
        {actionError ? <Alert variant="destructive" title={actionError} /> : null}
        {sod && can.approve ? (
          <Alert variant="info" title="Segregation of duties is on">
            You created this entry, so someone else must approve it.
          </Alert>
        ) : null}
        {entry.reversalOfId ? (
          <Alert variant="info" title="This entry reverses another entry">
            <Link
              to={`/accounting/entries/${entry.reversalOfId}`}
              className="font-medium text-primary underline"
            >
              View the original entry
            </Link>
          </Alert>
        ) : null}
        {entry.reversedById ? (
          <Alert variant="warning" title="This entry has been reversed">
            {entry.reversalReason ? <p>Reason: {entry.reversalReason}</p> : null}
            <Link
              to={`/accounting/entries/${entry.reversedById}`}
              className="font-medium text-primary underline"
            >
              View the reversing entry
            </Link>
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>{entry.description}</CardTitle>
              {entry.reference ? (
                <p className="text-sm text-muted-foreground">Reference: {entry.reference}</p>
              ) : null}
            </CardHeader>
            <CardContent className="px-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="hidden md:table-cell">Description</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {l.lineNo}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">
                          {l.accountCode}
                        </span>{' '}
                        {l.accountName}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {l.description || '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {isZeroish(l.debit) ? '' : fmt.money(l.debit)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {isZeroish(l.credit) ? '' : fmt.money(l.credit)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold hover:bg-transparent">
                    <TableCell />
                    <TableCell>Total</TableCell>
                    <TableCell className="hidden md:table-cell" />
                    <TableCell className="text-right font-mono tabular-nums">
                      {fmt.money(totalDebit)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {fmt.money(totalCredit)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-4">
                <Step
                  done
                  label="Created"
                  who={entry.createdBy?.name}
                  when={formatDateTime(entry.createdAt)}
                />
                <Step
                  done={s !== 'draft'}
                  label="Submitted for approval"
                  who={entry.submittedBy?.name}
                  when={
                    entry.submittedAt
                      ? formatDateTime(entry.submittedAt)
                      : s === 'draft'
                        ? 'Not yet'
                        : undefined
                  }
                />
                <Step
                  done={!!entry.approvedBy}
                  label="Approved"
                  who={entry.approvedBy?.name}
                  when={
                    entry.approvedAt
                      ? formatDateTime(entry.approvedAt)
                      : entry.approvedBy
                        ? undefined
                        : 'Not yet'
                  }
                />
                <Step
                  done={!!entry.postedAt}
                  label={entry.number ? `Posted as ${entry.number}` : 'Posted'}
                  who={entry.postedBy?.name}
                  when={entry.postedAt ? formatDateTime(entry.postedAt) : 'Not yet'}
                />
                {entry.reversedById ? (
                  <Step done label="Reversed" when={entry.reversalReason ?? ''} />
                ) : null}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={action === 'post'}
        onOpenChange={(o) => !o && setAction(null)}
        title="Post this entry to the ledger?"
        description="Posted entries are numbered and final. To undo one later you’ll need to reverse it."
        confirmLabel="Post entry"
        onConfirm={() => transition.mutateAsync('post').catch(() => undefined)}
      />
      <ConfirmDialog
        open={action === 'delete'}
        onOpenChange={(o) => !o && setAction(null)}
        destructive
        title="Delete this entry?"
        description="Draft and pending entries can be deleted. This can’t be undone."
        confirmLabel="Delete entry"
        onConfirm={async () => {
          await remove.mutateAsync();
          refresh();
          toast.success('Entry deleted');
          navigate('/accounting', { replace: true });
        }}
      />
      {action === 'reverse' ? (
        <ReverseDialog
          entry={entry}
          onClose={() => setAction(null)}
          onDone={(rev) => {
            refresh();
            navigate(`/accounting/entries/${rev.id}`);
          }}
        />
      ) : null}
    </>
  );
}

function isZeroish(v: string): boolean {
  return /^0+(\.0+)?$/.test(v);
}

function Step({
  done,
  label,
  who,
  when,
}: {
  done: boolean;
  label: string;
  who?: string | null;
  when?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      {done ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-label="Pending" />
      )}
      <div className="min-w-0 text-sm">
        <div className={cn('font-medium', !done && 'text-muted-foreground')}>{label}</div>
        {who || when ? (
          <div className="text-xs text-muted-foreground">
            {who ? `by ${who}` : ''}
            {who && when ? ' · ' : ''}
            {when}
          </div>
        ) : null}
      </div>
    </li>
  );
}

type ReverseValues = z.infer<typeof reverseJournalEntrySchema>;

function ReverseDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: JournalEntryRow;
  onClose: () => void;
  onDone: (reversal: JournalEntryRow) => void;
}) {
  const fmt = useTenantFormat();
  const idem = useIdempotencyKey();
  const today = fmt.today();
  const form = useForm<ReverseValues>({
    resolver: zodResolver(reverseJournalEntrySchema),
    defaultValues: { entryDate: today < entry.entryDate ? entry.entryDate : today, reason: '' },
  });
  const [error, setError] = useState<string | null>(null);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const rev = await withIdempotency(idem, { id: entry.id, ...v }, (key) =>
        api.post<JournalEntryRow>(`/accounting/journal-entries/${entry.id}/reverse`, v, {
          idempotencyKey: key,
        }),
      );
      toast.success(`Reversed with ${rev.number ?? 'a new entry'}`);
      onClose();
      onDone(rev);
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['entryDate', 'reason'], { toastUnmatched: false }))
        setError(errorMessage(e));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>Reverse {entry.number}</DialogTitle>
            <DialogDescription>
              A mirror-image entry is posted on the date you choose. The original stays in the
              ledger.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <FormField
            label="Reversal date"
            required
            error={form.formState.errors.entryDate?.message}
            hint={`Can’t be before ${formatIsoDate(entry.entryDate, undefined, fmt.locale)}.`}
          >
            <Input type="date" min={entry.entryDate} {...form.register('entryDate')} />
          </FormField>
          <FormField label="Reason" required error={form.formState.errors.reason?.message}>
            <Textarea rows={3} autoFocus {...form.register('reason')} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Reverse entry
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
