import type { HealthReport } from '@daliz/shared';
import { CircleCheck, CircleX } from 'lucide-react';
import { StatusBadge } from '@/components/app/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration, formatNumber, humanize } from '@/lib/utils';

export function HealthChecksCard({ health }: { health: HealthReport }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Health checks</CardTitle>
          <StatusBadge status={health.status} />
        </div>
        <CardDescription>
          Version {health.version} · up {formatDuration(health.uptimeSeconds)} · tenant pools {health.tenantPools.open}/{health.tenantPools.max}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-2 sm:px-0">
        <ul className="divide-y border-t">
          {health.checks.map((c) => (
            <li key={c.name} className="flex items-center gap-3 px-5 py-2.5 sm:px-6">
              {c.status === 'ok' ? <CircleCheck className="size-4 text-success" aria-label="OK" /> : <CircleX className="size-4 text-destructive" aria-label="Down" />}
              <span className="flex-1 text-sm font-medium">{humanize(c.name)}</span>
              {c.detail ? <span className="max-w-[40%] truncate text-xs text-muted-foreground">{c.detail}</span> : null}
              <span className="w-16 text-right font-mono text-xs text-muted-foreground tabular-nums">{c.latencyMs === null ? '—' : `${c.latencyMs} ms`}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function QueuesCard({ health }: { health: HealthReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Job queues</CardTitle>
        <CardDescription>Background work: provisioning, migrations, email.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-2 sm:px-0">
        {health.queues.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">No queues reported.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Queue</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Delayed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.queues.map((q) => (
                <TableRow key={q.name}>
                  <TableCell className="font-mono text-xs">{q.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(q.waiting)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(q.active)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(q.delayed)}</TableCell>
                  <TableCell className={q.failed > 0 ? 'text-right font-medium text-destructive tabular-nums' : 'text-right tabular-nums'}>{formatNumber(q.failed)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
