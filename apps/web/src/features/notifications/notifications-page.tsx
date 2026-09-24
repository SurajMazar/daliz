import { Bell, CheckCheck, Settings } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Segmented } from '@/components/ui/segmented';
import { SkeletonRows } from '@/components/ui/skeleton';
import { safeLink, useMarkRead, useNotifications, useUnreadCount } from './api';
import { NotificationItem } from './notification-item';

export function NotificationsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState(1);
  const list = useNotifications({ page, pageSize: 25, unread: filter === 'unread' ? 'true' : undefined });
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Invitations, assignments, comments and reminders."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/account#notifications">
                <Settings /> Preferences
              </Link>
            </Button>
            <Button variant="outline" disabled={!unread.data?.unread || markRead.isPending} onClick={() => markRead.mutate('all')}>
              <CheckCheck /> Mark all read
            </Button>
          </>
        }
      />
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b p-4">
          <Segmented
            label="Filter"
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: `Unread${unread.data?.unread ? ` (${unread.data.unread})` : ''}` },
            ]}
          />
        </div>
        {list.isPending ? (
          <SkeletonRows rows={6} cols={2} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={Bell} title={filter === 'unread' ? 'No unread notifications' : 'No notifications yet'} />
        ) : (
          <ul className="divide-y">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  n={n}
                  onOpen={() => {
                    if (!n.readAt) markRead.mutate([n.id]);
                    const link = safeLink(n.link);
                    if (link) navigate(link);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.meta.total > 0 ? <Pagination meta={list.data.meta} onPageChange={setPage} noun="notifications" /> : null}
      </Card>
    </>
  );
}
