import type { TenantStatus } from '@daliz/shared';
import { Badge } from '@/components/ui/badge';
import { humanize } from '@/lib/utils';

type Variant = 'success' | 'warning' | 'destructive' | 'muted' | 'info' | 'outline';

const MAP: Record<string, Variant> = {
  active: 'success',
  ready: 'success',
  ok: 'success',
  success: 'success',
  succeeded: 'success',
  done: 'success',
  verified: 'success',
  invited: 'info',
  provisioning: 'info',
  creating: 'info',
  migrating: 'info',
  running: 'info',
  queued: 'info',
  pending: 'muted',
  info: 'muted',
  suspended: 'warning',
  degraded: 'warning',
  warning: 'warning',
  decommissioning: 'warning',
  denied: 'warning',
  disabled: 'muted',
  decommissioned: 'muted',
  dropped: 'muted',
  provisioning_failed: 'destructive',
  failed: 'destructive',
  failure: 'destructive',
  down: 'destructive',
  critical: 'destructive',
};

export function StatusBadge({ status, label }: { status: TenantStatus | string; label?: string }) {
  return (
    <Badge variant={MAP[status] ?? 'outline'}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label ?? humanize(status)}
    </Badge>
  );
}
