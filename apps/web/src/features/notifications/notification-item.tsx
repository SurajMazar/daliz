import type { NotificationRow } from '@daliz/shared';
import { Bell, CalendarDays, CheckSquare, MessageSquare, Receipt } from 'lucide-react';
import { ago, cn, formatDateTime } from '@/lib/utils';

function iconFor(type: string) {
  if (type.startsWith('event.')) return CalendarDays;
  if (type === 'task.commented') return MessageSquare;
  if (type.startsWith('task.')) return CheckSquare;
  if (type.startsWith('accounting.')) return Receipt;
  return Bell;
}

export function NotificationItem({ n, onOpen, compact }: { n: NotificationRow; onOpen: () => void; compact?: boolean }) {
  const Icon = iconFor(n.type);
  const unread = !n.readAt;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn('flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted', unread && 'bg-primary/5')}
    >
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', unread ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', unread ? 'font-semibold' : 'font-medium')}>{n.title}</span>
        {n.body ? <span className={cn('block text-sm text-muted-foreground', compact && 'line-clamp-2')}>{n.body}</span> : null}
        <time className="mt-0.5 block text-xs text-muted-foreground" dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
          {ago(n.createdAt)}
        </time>
      </span>
      {unread ? <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
    </button>
  );
}
