import { useQuery } from '@tanstack/react-query';
import type { EventDetail, EventOccurrenceRow, ReminderRow } from '@daliz/shared';
import { api } from '@/lib/api';
import { cachedQuery } from '@/offline/cache';

export const eventsKeys = {
  all: ['events'] as const,
  range: (from: string, to: string, mine: boolean) => ['events', 'range', from, to, mine] as const,
  detail: (id: string) => ['events', 'detail', id] as const,
  reminders: ['events', 'reminders'] as const,
};

export function useOccurrences(from: Date, to: Date, mine: boolean) {
  const f = from.toISOString();
  const t = to.toISOString();
  const key = eventsKeys.range(f, t, mine);
  return useQuery({
    queryKey: key,
    queryFn: () => cachedQuery(key, () => api.get<EventOccurrenceRow[]>('/events', { from: f, to: t, mine: mine ? 'true' : undefined, includeCancelled: 'true' })),
    placeholderData: (prev) => prev,
  });
}

export function useEvent(id: string | null) {
  return useQuery({ queryKey: eventsKeys.detail(id ?? ''), queryFn: () => api.get<EventDetail>(`/events/${id}`), enabled: !!id });
}

export function useReminders(enabled = true) {
  return useQuery({ queryKey: eventsKeys.reminders, queryFn: () => cachedQuery(eventsKeys.reminders, () => api.get<ReminderRow[]>('/reminders')), enabled });
}

export const KIND_TONE: Record<EventOccurrenceRow['kind'], string> = {
  event: 'border-l-primary bg-primary/10 text-foreground',
  meeting: 'border-l-success bg-success/10 text-foreground',
  deadline: 'border-l-destructive bg-destructive/10 text-foreground',
};
