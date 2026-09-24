import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EventDetail } from '@daliz/shared';
import { Ban, CalendarClock, Check, HelpCircle, MapPin, Pencil, Repeat, Trash, Users, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn, humanize } from '@/lib/utils';
import { eventsKeys, useEvent } from './api';
import { EventDialog, type OccurrenceRef } from './event-dialog';
import { formatDateTimeIn, formatTime } from './tz';

const RESPONSE_TONE: Record<string, 'success' | 'destructive' | 'warning' | 'muted'> = { accepted: 'success', declined: 'destructive', tentative: 'warning', pending: 'muted' };

export function EventDrawer({ eventId, occurrence, onClose }: { eventId: string | null; occurrence: OccurrenceRef | null; onClose: () => void }) {
  const event = useEvent(eventId);
  return (
    <Sheet open={!!eventId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-lg sm:w-[480px]">
        {event.isPending ? (
          <div className="grid gap-4 p-6">
            <SheetTitle className="sr-only">Loading event</SheetTitle>
            <SheetDescription className="sr-only">Loading</SheetDescription>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-32" />
          </div>
        ) : event.isError ? (
          <div className="p-6">
            <SheetTitle className="sr-only">Event</SheetTitle>
            <SheetDescription className="sr-only">Could not load</SheetDescription>
            <ErrorState error={event.error} onRetry={() => void event.refetch()} />
          </div>
        ) : (
          <EventBody key={`${event.data.eventId}:${event.data.version}`} event={event.data} occurrence={occurrence} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

type Pending = { kind: 'edit' | 'cancel'; scope?: 'all' | 'occurrence' } | { kind: 'delete' } | null;

function EventBody({ event, occurrence, onClose }: { event: EventDetail; occurrence: OccurrenceRef | null; onClose: () => void }) {
  const { canWrite, me } = useAccess();
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [askScope, setAskScope] = useState<'edit' | 'cancel' | null>(null);
  const zone = fmt.timezone;
  const start = occurrence?.start ?? event.startsAt;
  const end = occurrence?.end ?? event.endsAt;
  const cancelled = event.status === 'cancelled';
  const canEdit = event.canEdit && canWrite('events.update');
  const invited = event.attendees.some((a) => a.id === me.tenant?.userId);
  const refresh = (d?: EventDetail) => {
    if (d) qc.setQueryData(eventsKeys.detail(d.eventId), d);
    void qc.invalidateQueries({ queryKey: eventsKeys.all });
  };

  const rsvp = useMutation({
    mutationFn: (response: 'accepted' | 'declined' | 'tentative') => api.post<EventDetail>(`/events/${event.eventId}/rsvp`, { response }),
    onSuccess: (d, r) => {
      refresh(d);
      toast.success(r === 'accepted' ? 'You’re going' : r === 'declined' ? 'You declined' : 'Marked as maybe');
    },
  });
  const cancelAll = useMutation({ mutationFn: () => api.patch<EventDetail>(`/events/${event.eventId}`, { status: 'cancelled', version: event.version }), onSuccess: (d) => refresh(d) });
  const cancelOne = useMutation({
    mutationFn: () => api.post<EventDetail>(`/events/${event.eventId}/occurrences`, { occurrenceStart: occurrence!.occurrenceStart, cancelled: true }),
    onSuccess: (d) => refresh(d),
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/events/${event.eventId}`), onSuccess: () => refresh() });

  const choose = (kind: 'edit' | 'cancel') => {
    if (event.recurring && occurrence) setAskScope(kind);
    else setPending({ kind, scope: 'all' });
  };

  const when = event.allDay
    ? `${formatDateTimeIn(start, zone, fmt.locale, { dateStyle: 'full' })}${new Date(end).getTime() - new Date(start).getTime() > 86_400_000 ? ` – ${formatDateTimeIn(new Date(new Date(end).getTime() - 1), zone, fmt.locale, { dateStyle: 'full' })}` : ''} · all day`
    : `${formatDateTimeIn(start, zone, fmt.locale, { dateStyle: 'full' })} · ${formatTime(start, zone, fmt.locale)} – ${formatTime(end, zone, fmt.locale)}`;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b p-5 pr-12">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant={event.kind === 'deadline' ? 'destructive' : event.kind === 'meeting' ? 'success' : 'info'}>{humanize(event.kind)}</Badge>
          {cancelled ? <Badge variant="muted">Cancelled</Badge> : event.status === 'tentative' ? <Badge variant="warning">Tentative</Badge> : null}
          {event.visibility === 'private' ? <Badge variant="outline">Private</Badge> : null}
        </div>
        <SheetTitle className={cn('text-xl font-semibold', cancelled && 'line-through')}>{occurrence?.title ?? event.title}</SheetTitle>
        <SheetDescription className="mt-1 flex items-start gap-2 text-sm text-muted-foreground">
          <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {when}
            {event.timezone !== zone ? <span className="block text-xs">Organised in {event.timezone.replace(/_/g, ' ')}</span> : null}
          </span>
        </SheetDescription>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
        {event.recurring ? (
          <p className="flex items-center gap-2">
            <Repeat className="size-4 text-muted-foreground" aria-hidden /> {event.recurrenceText}
          </p>
        ) : null}
        {event.location ? (
          <p className="flex items-center gap-2">
            <MapPin className="size-4 text-muted-foreground" aria-hidden /> {event.location}
          </p>
        ) : null}
        {event.description ? <p className="whitespace-pre-wrap">{event.description}</p> : null}

        {invited && !cancelled ? (
          <section aria-labelledby="rsvp-h" className="rounded-lg border p-3">
            <h3 id="rsvp-h" className="mb-2 font-medium">
              Going?
            </h3>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Your response">
              {(
                [
                  { r: 'accepted', label: 'Yes', icon: Check },
                  { r: 'tentative', label: 'Maybe', icon: HelpCircle },
                  { r: 'declined', label: 'No', icon: X },
                ] as const
              ).map((o) => (
                <Button
                  key={o.r}
                  size="sm"
                  variant={event.myResponse === o.r ? 'default' : 'outline'}
                  aria-pressed={event.myResponse === o.r}
                  loading={rsvp.isPending && rsvp.variables === o.r}
                  onClick={() => rsvp.mutate(o.r)}
                >
                  <o.icon /> {o.label}
                </Button>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="attendees-h">
          <h3 id="attendees-h" className="mb-2 flex items-center gap-2 font-medium">
            <Users className="size-4 text-muted-foreground" aria-hidden /> People
          </h3>
          <ul className="grid gap-2">
            {event.organizer ? (
              <li className="flex items-center gap-2">
                <Avatar name={event.organizer.name} />
                <span className="flex-1">{event.organizer.name}</span>
                <Badge variant="outline">Organiser</Badge>
              </li>
            ) : null}
            {event.attendees.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <Avatar name={a.name} />
                <span className="flex-1">{a.name}</span>
                <Badge variant={RESPONSE_TONE[a.response] ?? 'muted'}>{a.response === 'pending' ? 'No reply' : humanize(a.response)}</Badge>
              </li>
            ))}
            {event.attendees.length === 0 ? <li className="text-muted-foreground">No attendees.</li> : null}
          </ul>
        </section>
      </div>
      {(canEdit && !cancelled) || canWrite('events.delete') ? (
        <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">
          {canWrite('events.delete') && event.canEdit ? (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setPending({ kind: 'delete' })}>
              <Trash /> Delete
            </Button>
          ) : null}
          {canEdit && !cancelled ? (
            <>
              <Button variant="outline" onClick={() => choose('cancel')}>
                <Ban /> Cancel event
              </Button>
              <Button onClick={() => choose('edit')}>
                <Pencil /> Edit
              </Button>
            </>
          ) : null}
        </footer>
      ) : null}

      <Dialog open={!!askScope} onOpenChange={(o) => !o && setAskScope(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{askScope === 'edit' ? 'Edit recurring event' : 'Cancel recurring event'}</DialogTitle>
            <DialogDescription>Apply the change to this occurrence only, or to every occurrence?</DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-col sm:items-stretch">
            <Button
              variant="outline"
              onClick={() => {
                setPending({ kind: askScope!, scope: 'occurrence' });
                setAskScope(null);
              }}
            >
              This occurrence
            </Button>
            <Button
              onClick={() => {
                setPending({ kind: askScope!, scope: 'all' });
                setAskScope(null);
              }}
            >
              All occurrences
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pending?.kind === 'edit' ? <EventDialog event={event} occurrence={occurrence ?? undefined} scope={pending.scope} onClose={() => setPending(null)} /> : null}
      <ConfirmDialog
        open={pending?.kind === 'cancel'}
        onOpenChange={(o) => !o && setPending(null)}
        destructive
        title={pending?.kind === 'cancel' && pending.scope === 'occurrence' ? 'Cancel this occurrence?' : 'Cancel this event?'}
        description="Attendees are notified. The event stays in the calendar as cancelled."
        confirmLabel="Cancel event"
        onConfirm={async () => {
          if (pending?.kind === 'cancel' && pending.scope === 'occurrence') {
            await cancelOne.mutateAsync();
            toast.success('Occurrence cancelled');
            onClose();
          } else {
            await cancelAll.mutateAsync();
            toast.success('Event cancelled');
          }
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(o) => !o && setPending(null)}
        destructive
        title="Delete this event?"
        description={event.recurring ? 'Every occurrence of the series is deleted.' : 'This can’t be undone.'}
        confirmLabel="Delete event"
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Event deleted');
          onClose();
        }}
      />
    </div>
  );
}
