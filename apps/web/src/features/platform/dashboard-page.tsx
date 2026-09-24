import { Building, CircleAlert, Server, ShieldAlert, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccess } from '@/lib/session';
import { formatNumber, ago } from '@/lib/utils';
import { usePlatformDashboard } from './api';
import { HealthChecksCard, QueuesCard } from './health-panels';

function Stat({ label, value, icon: Icon, children, to }: { label: string; value: number; icon: typeof Users; children?: ReactNode; to?: string }) {
  const body = (
    <CardContent className="grid gap-2">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span className="font-medium">{label}</span>
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{formatNumber(value)}</div>
      {children}
    </CardContent>
  );
  return (
    <Card className={to ? 'transition-colors hover:border-primary/40' : undefined}>
      {to ? (
        <Link to={to} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

export function PlatformDashboardPage() {
  const { canPlatform } = useAccess();
  const { data, isPending, error, refetch } = usePlatformDashboard();

  return (
    <>
      <PageHeader title="Platform dashboard" description="Tenants, accounts and system health across Daliz." />
      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
          <Skeleton className="h-64 sm:col-span-2" />
          <Skeleton className="h-64 sm:col-span-2" />
        </div>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Organizations" value={data.organizations} icon={Building} to={canPlatform('platform.organizations.read') ? '/platform/organizations' : undefined} />
            <Stat label="Tenants" value={data.tenants.total} icon={Server} to={canPlatform('platform.tenants.read') ? '/platform/tenants' : undefined}>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{data.tenants.active} active</span>
                <span>{data.tenants.suspended} suspended</span>
                <span>{data.tenants.provisioning} provisioning</span>
                {data.tenants.failed ? <span className="font-medium text-destructive">{data.tenants.failed} failed</span> : null}
              </div>
            </Stat>
            <Stat label="Active accounts" value={data.accounts} icon={Users} />
            <Card>
              <CardContent className="grid gap-2">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="font-medium">System status</span>
                  <CircleAlert className="size-4" aria-hidden />
                </div>
                <div>
                  <StatusBadge status={data.health.status} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {data.health.checks.filter((c) => c.status === 'ok').length}/{data.health.checks.length} checks passing
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <HealthChecksCard health={data.health} />
            <QueuesCard health={data.health} />
          </div>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Recent security events</CardTitle>
                {canPlatform('platform.audit.read') ? (
                  <Link to="/platform/security-events" className="text-sm font-medium text-primary hover:underline">
                    View all
                  </Link>
                ) : null}
              </div>
              <CardDescription>Sign-ins, lockouts, support sessions and admin changes.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-2 sm:px-0">
              {data.recentSecurityEvents.length === 0 ? (
                <EmptyState icon={ShieldAlert} title="No security events" />
              ) : (
                <ul className="divide-y border-t">
                  {data.recentSecurityEvents.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 sm:px-6">
                      <StatusBadge status={e.severity} />
                      <code className="font-mono text-xs">{e.type}</code>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{e.email ?? e.ipAddress ?? '—'}</span>
                      <time dateTime={e.createdAt} className="text-xs text-muted-foreground">
                        {ago(e.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
