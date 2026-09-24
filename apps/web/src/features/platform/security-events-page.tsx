import { ChevronRight, ShieldAlert } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { NativeSelect } from '@/components/ui/native-select';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn, formatDateTime, parseUserAgent, ago } from '@/lib/utils';
import { useSecurityEvents } from './api';

export function SecurityEventsPage() {
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const events = useSecurityEvents({ page, pageSize: 25, severity: severity || undefined });

  return (
    <>
      <PageHeader title="Security events" description="Sign-in activity, lockouts, MFA changes, support sessions and administrator changes." />
      <Card className="overflow-hidden">
        <div className="border-b p-4">
          <div className="sm:w-52">
            <NativeSelect
              aria-label="Filter by severity"
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </NativeSelect>
          </div>
        </div>
        {events.isPending ? (
          <SkeletonRows rows={8} cols={5} />
        ) : events.isError ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : events.data.items.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No security events" />
        ) : (
          <Table aria-busy={events.isFetching || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">
                  <span className="sr-only">Expand</span>
                </TableHead>
                <TableHead>When</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.data.items.map((e) => {
                const open = expanded === e.id;
                return (
                  <Fragment key={e.id}>
                    <TableRow className={cn(e.severity === 'critical' && 'bg-destructive/5 hover:bg-destructive/10', open && 'border-b-0')}>
                      <TableCell className="pr-0">
                        <Button variant="ghost" size="icon-sm" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setExpanded(open ? null : e.id)}>
                          <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
                        </Button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>
                          {ago(e.createdAt)}
                        </time>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.severity} />
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.type}</code>
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate text-muted-foreground">{e.email ?? '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.ipAddress ?? '—'}
                        {e.userAgent ? <div>{parseUserAgent(e.userAgent)}</div> : null}
                      </TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="pt-0">
                          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(e.metadata, null, 2)}</pre>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
        {events.data && events.data.meta.total > 0 ? <Pagination meta={events.data.meta} onPageChange={setPage} noun="events" /> : null}
      </Card>
    </>
  );
}
