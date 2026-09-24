import type { JournalStatus } from '@daliz/shared';
import { Badge } from '@/components/ui/badge';
import { JOURNAL_STATUS_LABELS } from './api';

const VARIANT: Record<JournalStatus, 'muted' | 'warning' | 'info' | 'success' | 'outline'> = {
  draft: 'muted',
  pending: 'warning',
  approved: 'info',
  posted: 'success',
  reversed: 'outline',
};

export function JournalStatusBadge({ status }: { status: JournalStatus }) {
  return (
    <Badge variant={VARIANT[status]}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {JOURNAL_STATUS_LABELS[status]}
    </Badge>
  );
}
