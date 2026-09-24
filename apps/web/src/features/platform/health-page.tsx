import { RefreshCw } from 'lucide-react';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/utils';
import { useHealth } from './api';
import { HealthChecksCard, QueuesCard } from './health-panels';

export function HealthPage() {
  const health = useHealth();
  return (
    <>
      <PageHeader
        title="System health"
        description={health.dataUpdatedAt ? `Refreshes every 15 seconds · last checked ${formatDateTime(new Date(health.dataUpdatedAt).toISOString())}` : 'Refreshes every 15 seconds.'}
        actions={
          <Button variant="outline" onClick={() => void health.refetch()} loading={health.isFetching}>
            <RefreshCw /> Refresh
          </Button>
        }
      />
      {health.isPending ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : health.isError ? (
        <Card>
          <ErrorState error={health.error} onRetry={() => void health.refetch()} />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <HealthChecksCard health={health.data} />
          <QueuesCard health={health.data} />
        </div>
      )}
    </>
  );
}
