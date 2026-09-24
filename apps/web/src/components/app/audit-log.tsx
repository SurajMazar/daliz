import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditRow } from '@daliz/shared';
import { ChevronRight, LifeBuoy, ScrollText, Search, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type Query } from '@/lib/api';
import { useDebouncedValue } from '@/lib/hooks';
import { cn, formatDateTime, humanize, ago } from '@/lib/utils';
import { ErrorState } from './error-state';
import { StatusBadge } from './status-badge';

const ACTOR_VARIANT: Record<AuditRow['actorType'], 'info' | 'warning' | 'muted' | 'secondary' | 'destructive'> = {
  user: 'secondary',
  platform_admin: 'info',
  support: 'warning',
  system: 'muted',
  anonymous: 'muted',
  api_key: 'info',
};

export function ActorBadge({ type }: { type: AuditRow['actorType'] }) {
  return (
    <Badge variant={ACTOR_VARIANT[type]}>
      {type === 'support' ? <LifeBuoy aria-hidden /> : null}
      {type === 'platform_admin' ? 'Platform admin' : type === 'api_key' ? 'API key' : humanize(type)}
    </Badge>
  );
}

function dayStart(d: string): string | undefined {
  if (!d) return undefined;
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}
function dayEnd(d: string): string | undefined {
  if (!d) return undefined;
  const dt = new Date(`${d}T23:59:59.999`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

/** Filterable, paginated audit log with expandable rows. Shared by tenant and platform views. */
export function AuditLogView({ queryKey, path, pageSize = 25 }: { queryKey: readonly unknown[]; path: string; pageSize?: number }) {
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useDebouncedValue(text.trim(), 300);
  const actionQ = useDebouncedValue(action.trim(), 300);

  const query: Query = {
    page,
    pageSize,
    q: q || undefined,
    action: actionQ || undefined,
    outcome: outcome || undefined,
    from: dayStart(from),
    to: dayEnd(to),
  };
  const log = useQuery({
    queryKey: [...queryKey, query],
    queryFn: () => api.list<AuditRow>(path, query),
    placeholderData: keepPreviousData,
  });

  const filtered = !!(q || actionQ || outcome || from || to);
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div>
      <div className="grid gap-3 border-b p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Search actor or action" placeholder="Search actor or action…" className="pl-9" value={text} onChange={(e) => reset(() => setText(e.target.value))} />
        </div>
        <Input aria-label="Action prefix" placeholder="Action prefix, e.g. user." value={action} onChange={(e) => reset(() => setAction(e.target.value))} className="font-mono" />
        <NativeSelect aria-label="Outcome" value={outcome} onChange={(e) => reset(() => setOutcome(e.target.value))}>
          <option value="">Any outcome</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="denied">Denied</option>
        </NativeSelect>
        <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => reset(() => setFrom(e.target.value))} />
        <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => reset(() => setTo(e.target.value))} />
        <Button
          variant="ghost"
          disabled={!filtered}
          onClick={() =>
            reset(() => {
              setText('');
              setAction('');
              setOutcome('');
              setFrom('');
              setTo('');
            })
          }
        >
          <X /> Clear
        </Button>
      </div>

      {log.isPending ? (
        <SkeletonRows rows={8} cols={5} />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : log.data.items.length === 0 ? (
        <EmptyState icon={ScrollText} title={filtered ? 'No events match your filters' : 'No events yet'} />
      ) : (
        <Table aria-busy={log.isFetching || undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8">
                <span className="sr-only">Expand</span>
              </TableHead>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead className="hidden lg:table-cell">Resource</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.data.items.map((row) => {
              const open = expanded === row.id;
              const detailId = `audit-${row.id}`;
              return (
                <Fragment key={row.id}>
                  <TableRow className={cn(row.actorType === 'support' && 'bg-warning/5 hover:bg-warning/10', open && 'border-b-0')}>
                    <TableCell className="pr-0">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={open ? 'Hide details' : 'Show details'}
                        onClick={() => setExpanded(open ? null : row.id)}
                      >
                        <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <time dateTime={row.occurredAt} title={formatDateTime(row.occurredAt)} className="text-sm">
                        {ago(row.occurredAt)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{row.action}</code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <ActorBadge type={row.actorType} />
                        <span className="max-w-[16rem] truncate text-sm text-muted-foreground">{row.actorEmail ?? '—'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{row.resourceType ? humanize(row.resourceType) : '—'}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.outcome} />
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <TableRow id={detailId} className={cn('hover:bg-transparent', row.actorType === 'support' && 'bg-warning/5')}>
                      <TableCell colSpan={6} className="pt-0">
                        <dl className="grid gap-x-6 gap-y-2 rounded-lg border bg-muted/40 p-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
                          <div>
                            <dt className="text-muted-foreground">Time</dt>
                            <dd className="font-medium">{formatDateTime(row.occurredAt)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Resource</dt>
                            <dd className="font-mono break-all">{row.resourceType ? `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ''}` : '—'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">IP address</dt>
                            <dd className="font-mono">{row.ipAddress ?? '—'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Request ID</dt>
                            <dd className="font-mono break-all">{row.requestId ?? '—'}</dd>
                          </div>
                          {row.userAgent ? (
                            <div className="sm:col-span-2 lg:col-span-4">
                              <dt className="text-muted-foreground">User agent</dt>
                              <dd className="break-all">{row.userAgent}</dd>
                            </div>
                          ) : null}
                          <div className="sm:col-span-2 lg:col-span-4">
                            <dt className="mb-1 text-muted-foreground">Metadata</dt>
                            <dd>
                              <pre className="max-h-72 overflow-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
                                {JSON.stringify(row.metadata, null, 2)}
                              </pre>
                            </dd>
                          </div>
                        </dl>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
      {log.data && log.data.meta.total > 0 ? <Pagination meta={log.data.meta} onPageChange={setPage} noun="events" /> : null}
    </div>
  );
}
