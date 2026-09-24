import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationPreferenceRow, NotificationRow } from '@daliz/shared';
import { api, type Query } from '@/lib/api';

export const notificationKeys = {
  all: ['notifications'] as const,
  unread: ['notifications', 'unread'] as const,
  list: (q: Query) => ['notifications', 'list', q] as const,
  preferences: ['notifications', 'preferences'] as const,
  push: ['notifications', 'push'] as const,
};

export function useUnreadCount(enabled = true) {
  return useQuery({ queryKey: notificationKeys.unread, queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'), enabled, refetchInterval: 120_000 });
}

export function useNotifications(q: Query, enabled = true) {
  return useQuery({ queryKey: notificationKeys.list(q), queryFn: () => api.list<NotificationRow>('/notifications', q), placeholderData: keepPreviousData, enabled });
}

export function usePreferences() {
  return useQuery({ queryKey: notificationKeys.preferences, queryFn: () => api.get<NotificationPreferenceRow[]>('/notifications/preferences') });
}

export function usePushConfig() {
  return useQuery({ queryKey: notificationKeys.push, queryFn: () => api.get<{ enabled: boolean; publicKey: string | null }>('/notifications/push'), staleTime: Infinity });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | 'all') => api.post<{ unread: number }>('/notifications/read', { ids }),
    onSuccess: (r) => {
      qc.setQueryData(notificationKeys.unread, r);
      void qc.invalidateQueries({ queryKey: ['notifications', 'list'] });
    },
  });
}

/** Notification links are in-app routes; anything else (absolute, protocol-relative) is ignored. */
export function safeLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\')) return null;
  return link;
}
