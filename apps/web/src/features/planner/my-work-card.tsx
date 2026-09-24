import { CalendarClock, ClipboardList, Clock, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn } from '@/lib/utils';
import { usePlannerSummary } from './api';
import { DueLabel, PriorityIcon, TaskStatusBadge } from './task-bits';

/** "My work" on the tenant dashboard, from GET /planner/summary. */
export function MyWorkCard() {
  const fmt = useTenantFormat();
  const summary = usePlannerSummary();
  const stats = summary.data
    ? [
        { label: 'Assigned to me', value: summary.data.assignedToMe, icon: ClipboardList, tone: '' },
        { label: 'Due today', value: summary.data.dueToday, icon: Clock, tone: summary.data.dueToday ? 'text-warning' : '' },
        { label: 'Overdue', value: summary.data.overdue, icon: TriangleAlert, tone: summary.data.overdue ? 'text-destructive' : '' },
        { label: 'Due this week', value: summary.data.dueThisWeek, icon: CalendarClock, tone: '' },
      ]
    : [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>My work</CardTitle>
          <Link to="/planner" className="text-sm font-medium text-primary hover:underline">
            Open planner
          </Link>
        </div>
        <CardDescription>Open tasks assigned to you.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {summary.isPending ? (
          <Skeleton className="h-32" />
        ) : summary.isError ? (
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} className="py-6" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="rounded-lg border p-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <s.icon className="size-3.5" aria-hidden /> {s.label}
                  </div>
                  <div className={cn('mt-1 text-2xl font-semibold tabular-nums', s.tone)}>{s.value}</div>
                </div>
              ))}
            </div>
            {summary.data.upcoming.length === 0 ? (
              <EmptyState icon={ClipboardList} title="Nothing on your plate" description="Tasks assigned to you will show up here." className="py-6" />
            ) : (
              <ul className="divide-y rounded-lg border">
                {summary.data.upcoming.map((t) => (
                  <li key={t.id}>
                    <Link to={`/planner/p/${t.projectId}?task=${t.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none">
                      <span className="font-mono text-xs text-muted-foreground">{t.key}</span>
                      <PriorityIcon priority={t.priority} />
                      <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                      <span className="hidden text-xs text-muted-foreground sm:inline">{t.projectName}</span>
                      <TaskStatusBadge status={t.status} />
                      <DueLabel due={t.dueDate} status={t.status} today={fmt.today()} locale={fmt.locale} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
