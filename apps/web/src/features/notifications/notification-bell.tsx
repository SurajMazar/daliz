import { Bell, CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { safeLink, useMarkRead, useNotifications, useUnreadCount } from './api';
import { NotificationItem } from './notification-item';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const list = useNotifications({ page: 1, pageSize: 8 }, open);
  const markRead = useMarkRead();
  const count = unread.data?.unread ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}>
          <Bell />
          {count ? (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground tabular-nums" aria-hidden>
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <Button variant="ghost" size="sm" disabled={!count || markRead.isPending} onClick={() => markRead.mutate('all')}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto" aria-live="polite">
          {list.isPending ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : list.isError ? (
            <p className="p-4 text-sm text-muted-foreground">Couldn’t load notifications.</p>
          ) : list.data.items.length === 0 ? (
            <EmptyState icon={Bell} title="You’re all caught up" className="py-10" />
          ) : (
            <ul className="divide-y">
              {list.data.items.map((n) => (
                <li key={n.id}>
                  <NotificationItem
                    compact
                    n={n}
                    onOpen={() => {
                      if (!n.readAt) markRead.mutate([n.id]);
                      const link = safeLink(n.link);
                      setOpen(false);
                      if (link) navigate(link);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t p-2 text-center">
          <Button asChild variant="link" size="sm" onClick={() => setOpen(false)}>
            <Link to="/notifications">See all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
