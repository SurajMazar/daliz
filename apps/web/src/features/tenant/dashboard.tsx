import { Activity, HardDrive, KeyRound, Sparkles, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { useTenantDashboard } from '@/features/admin/api';
import { MyWorkCard } from '@/features/planner/my-work-card';
import { useAccess } from '@/lib/session';
import { cn, formatMb, formatNumber, humanize, ago } from '@/lib/utils';

function Stat({ icon: Icon, label, value, sub, children }: { icon: typeof Users; label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span className="font-medium">{label}</span>
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
        {children}
      </CardContent>
    </Card>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  const { me, can } = useAccess();
  const { data, isPending, error, refetch } = useTenantDashboard();
  const firstName = me.account.name.split(' ')[0] ?? me.account.name;

  return (
    <>
      <PageHeader title="Dashboard" description={`${greeting()}, ${firstName}. Here’s what’s happening in ${me.tenant?.settings.displayName ?? me.tenant?.name}.`} />
      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {isPending || !data ? (
              Array.from({ length: 4 }, (_, i) => (
                <Card key={i}>
                  <CardContent className="grid gap-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-7 w-16" />
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
              ))
            ) : (
              <>
                <Stat
                  icon={Users}
                  label="Users"
                  value={
                    <>
                      {formatNumber(data.users.active + data.users.invited)}
                      <span className="text-base font-normal text-muted-foreground"> / {formatNumber(data.users.limit)}</span>
                    </>
                  }
                  sub={`${data.users.active} active · ${data.users.invited} invited · ${data.users.disabled} disabled`}
                >
                  <UsageBar used={data.users.active + data.users.invited} limit={data.users.limit} label="Seats used" />
                </Stat>
                <Stat icon={KeyRound} label="Roles" value={formatNumber(data.roles)} sub={can('roles.read') ? <Link className="text-primary hover:underline" to="/admin/roles">Manage roles</Link> : 'Built-in and custom'} />
                <Stat icon={Sparkles} label="Plan" value={humanize(data.plan)} sub="Contact your provider to change plans" />
                <Stat icon={HardDrive} label="Storage quota" value={formatMb(data.storageQuotaMb)} sub="Available to this workspace" />
              </>
            )}
          </div>

          {can('planner.read') ? <MyWorkCard /> : null}

          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>The latest events from this workspace’s audit log.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-2 sm:px-0">
              {isPending ? (
                <SkeletonRows rows={4} cols={3} />
              ) : !data?.recentActivity ? (
                <EmptyState icon={Activity} title="Activity is visible to auditors" description="You need the audit log permission to see recent activity." />
              ) : data.recentActivity.length === 0 ? (
                <EmptyState icon={Activity} title="No activity yet" />
              ) : (
                <ul className="divide-y">
                  {data.recentActivity.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 sm:px-6">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{a.action}</code>
                      {a.actorType === 'support' ? <Badge variant="warning">Support</Badge> : null}
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{a.actorEmail ?? humanize(a.actorType)}</span>
                      {a.outcome !== 'success' ? <StatusBadge status={a.outcome} /> : null}
                      <time dateTime={a.occurredAt} className="text-xs text-muted-foreground tabular-nums">
                        {ago(a.occurredAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
              {data?.recentActivity && data.recentActivity.length > 0 ? (
                <div className="border-t px-5 pt-3 pb-1 sm:px-6">
                  <Link to="/admin/audit" className="text-sm font-medium text-primary hover:underline">
                    View full audit log
                  </Link>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function UsageBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-destructive' : pct >= 75 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
    </div>
  );
}
