import { useQueryClient } from '@tanstack/react-query';
import { describeRRule, eventInputSchema, formatRRule, parseRRule, WEEKDAYS, type EventDetail, type Frequency, type Weekday } from '@daliz/shared';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PeoplePicker } from '@/components/app/people-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { TIME_ZONES } from '@/features/admin/settings-page';
import { usePeople } from '@/features/planner/api';
import { api, ApiError, errorMessage } from '@/lib/api';
import { addDays } from '@/lib/dates';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { useTenantFormat } from '@/lib/tenant-format';
import { useUnsavedChanges } from '@/lib/unsaved';
import { cn } from '@/lib/utils';
import { eventsKeys } from './api';
import { dayKey, fromLocalInput, startOfDayUtc, toLocalInput } from './tz';

const WEEKDAY_LABEL: Record<Weekday, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const REMINDER_OPTIONS = [
  { value: '', label: 'No reminder' },
  { value: '5', label: '5 minutes before' },
  { value: '15', label: '15 minutes before' },
  { value: '30', label: '30 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
];

export interface OccurrenceRef {
  occurrenceStart: string;
  start: string;
  end: string;
  title: string;
}

interface RepeatState {
  freq: 'NONE' | Frequency;
  interval: number;
  byDay: Weekday[];
  ends: 'never' | 'count' | 'until';
  count: number;
  until: string;
}

function repeatFrom(rrule: string | null): RepeatState {
  const base: RepeatState = { freq: 'NONE', interval: 1, byDay: [], ends: 'never', count: 10, until: '' };
  if (!rrule) return base;
  try {
    const r = parseRRule(rrule);
    return {
      freq: r.freq,
      interval: r.interval,
      byDay: r.byDay ?? [],
      ends: r.count ? 'count' : r.until ? 'until' : 'never',
      count: r.count ?? 10,
      until: r.until ? r.until.toISOString().slice(0, 10) : '',
    };
  } catch {
    return base;
  }
}

function buildRRule(r: RepeatState, startWeekday: Weekday): string | null {
  if (r.freq === 'NONE') return null;
  return formatRRule({
    freq: r.freq,
    interval: Math.max(1, Math.min(366, r.interval || 1)),
    byDay: r.freq === 'WEEKLY' ? (r.byDay.length ? r.byDay : [startWeekday]) : undefined,
    count: r.ends === 'count' ? Math.max(1, Math.min(1000, r.count || 1)) : undefined,
    until: r.ends === 'until' && r.until ? new Date(`${r.until}T23:59:59Z`) : undefined,
  });
}

/**
 * Create / edit an event. Times are entered as wall-clock time in the chosen zone (default:
 * the workspace zone) and sent as UTC instants. Editing "this occurrence" of a series only
 * changes its title and time via POST /events/:id/occurrences.
 */
export function EventDialog({
  event,
  occurrence,
  scope = 'all',
  defaultDay,
  onClose,
}: {
  event?: EventDetail;
  occurrence?: OccurrenceRef;
  scope?: 'all' | 'occurrence';
  defaultDay?: string;
  onClose: () => void;
}) {
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const idem = useIdempotencyKey();
  const people = usePeople();
  const workspaceZone = fmt.timezone;
  const onlyOccurrence = !!event && scope === 'occurrence' && !!occurrence;

  const initial = useMemo(() => {
    const tz = event?.timezone ?? workspaceZone;
    if (onlyOccurrence && occurrence) return { tz, start: occurrence.start, end: occurrence.end };
    if (event) return { tz, start: event.startsAt, end: event.endsAt };
    const day = defaultDay ?? fmt.today();
    const now = new Date();
    const startLocal = defaultDay ? `${day}T09:00` : toLocalInput(new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000), tz);
    const s = fromLocalInput(startLocal, tz)!;
    return { tz, start: s.toISOString(), end: new Date(s.getTime() + 3_600_000).toISOString() };
  }, [event, occurrence, onlyOccurrence, defaultDay, workspaceZone, fmt]);

  const [title, setTitle] = useState(onlyOccurrence ? (occurrence?.title ?? event?.title ?? '') : (event?.title ?? ''));
  const [kind, setKind] = useState<EventDetail['kind']>(event?.kind ?? 'event');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [timezone, setTimezone] = useState(initial.tz);
  const [startLocal, setStartLocal] = useState(toLocalInput(initial.start, initial.tz));
  const [endLocal, setEndLocal] = useState(toLocalInput(initial.end, initial.tz));
  const [startDay, setStartDay] = useState(dayKey(initial.start, initial.tz));
  // All-day end is exclusive on the server; the form shows the inclusive last day.
  const [endDay, setEndDay] = useState(() => (event?.allDay ? addDays(dayKey(initial.end, initial.tz), -1) : dayKey(initial.start, initial.tz)));
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [attendees, setAttendees] = useState<string[]>(event?.attendees.map((a) => a.id) ?? []);
  const [visibility, setVisibility] = useState<'workspace' | 'private'>(event?.visibility ?? 'workspace');
  const [reminder, setReminder] = useState('15');
  const [repeat, setRepeat] = useState<RepeatState>(() => repeatFrom(event?.recurrence ?? null));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  const times = (): { startsAt: Date; endsAt: Date } | null => {
    if (allDay) {
      if (!startDay || !endDay) return null;
      return { startsAt: startOfDayUtc(startDay, timezone), endsAt: startOfDayUtc(addDays(endDay, 1), timezone) };
    }
    const s = fromLocalInput(startLocal, timezone);
    const e = fromLocalInput(endLocal, timezone);
    return s && e ? { startsAt: s, endsAt: e } : null;
  };

  const startWeekday: Weekday = (() => {
    const t = times();
    const d = t ? dayKey(t.startsAt, timezone) : fmt.today();
    return WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]!;
  })();
  const rrule = buildRRule(repeat, startWeekday);
  let rruleText = 'Does not repeat';
  try {
    rruleText = describeRRule(rrule);
  } catch {
    rruleText = 'Invalid repeat rule';
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const t = times();
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Required';
    if (!t) errs.startsAt = 'Choose a start and end';
    else if (t.endsAt <= t.startsAt) errs.endsAt = 'End must be after start';
    if (repeat.ends === 'until' && repeat.freq !== 'NONE' && !repeat.until) errs.rrule = 'Choose an end date';
    setErrors(errs);
    if (Object.keys(errs).length || !t) return;

    setSaving(true);
    try {
      if (onlyOccurrence && event && occurrence) {
        await api.post<EventDetail>(`/events/${event.eventId}/occurrences`, {
          occurrenceStart: occurrence.occurrenceStart,
          startsAt: t.startsAt.toISOString(),
          endsAt: t.endsAt.toISOString(),
          title: title.trim(),
        });
        toast.success('This occurrence was updated');
      } else {
        const body = {
          title: title.trim(),
          description,
          location: location.trim(),
          kind,
          startsAt: t.startsAt.toISOString(),
          endsAt: t.endsAt.toISOString(),
          allDay,
          timezone,
          rrule,
          visibility,
          attendeeIds: attendees,
        };
        const parsed = eventInputSchema.safeParse({ ...body, reminderMinutes: reminder ? [Number(reminder)] : [] });
        if (!parsed.success) {
          const map: Record<string, string> = {};
          for (const i of parsed.error.issues) map[String(i.path[0] ?? 'form')] = i.message;
          setErrors(map);
          setSaving(false);
          return;
        }
        if (event) {
          await api.patch<EventDetail>(`/events/${event.eventId}`, { ...body, version: event.version });
          toast.success('Event updated');
        } else {
          const createBody = { ...body, reminderMinutes: reminder ? [Number(reminder)] : [] };
          await withIdempotency(idem, createBody, (key) => api.post<EventDetail>('/events', createBody, { idempotencyKey: key }));
          toast.success('Event created');
        }
      }
      setDirty(false);
      void qc.invalidateQueries({ queryKey: eventsKeys.all });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.details.length) {
        setServerError(`${err.message} ${err.details.map((d) => d.message).join(' · ')}`);
      } else setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const peopleList = (people.data ?? []).map((p) => ({ id: p.id, name: p.name, email: p.email }));

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{event ? (onlyOccurrence ? 'Edit this occurrence' : 'Edit event') : 'New event'}</DialogTitle>
            <DialogDescription>Times are in {timezone.replace(/_/g, ' ')}.</DialogDescription>
          </DialogHeader>
          {serverError ? <Alert variant="destructive" title={serverError} /> : null}
          <FormField label="Title" required error={errors.title}>
            <Input autoFocus maxLength={200} value={title} onChange={(e) => touch(setTitle)(e.target.value)} />
          </FormField>

          {!onlyOccurrence ? (
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <FormField label="Kind">
                <NativeSelect value={kind} onChange={(e) => touch(setKind)(e.target.value as EventDetail['kind'])}>
                  <option value="event">Event</option>
                  <option value="meeting">Meeting</option>
                  <option value="deadline">Deadline</option>
                </NativeSelect>
              </FormField>
              <div className="flex items-end gap-2 pb-2">
                <Switch id="all-day" checked={allDay} onCheckedChange={touch(setAllDay)} />
                <Label htmlFor="all-day">All day</Label>
              </div>
            </div>
          ) : null}

          {allDay && !onlyOccurrence ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="First day" required error={errors.startsAt}>
                <Input type="date" value={startDay} onChange={(e) => {
                  touch(setStartDay)(e.target.value);
                  if (e.target.value > endDay) setEndDay(e.target.value);
                }} />
              </FormField>
              <FormField label="Last day" required error={errors.endsAt}>
                <Input type="date" value={endDay} min={startDay} onChange={(e) => touch(setEndDay)(e.target.value)} />
              </FormField>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Starts" required error={errors.startsAt}>
                <Input
                  type="datetime-local"
                  value={startLocal}
                  onChange={(e) => {
                    const prevStart = fromLocalInput(startLocal, timezone);
                    const prevEnd = fromLocalInput(endLocal, timezone);
                    touch(setStartLocal)(e.target.value);
                    const next = fromLocalInput(e.target.value, timezone);
                    // Keep the duration when the start moves.
                    if (prevStart && prevEnd && next) setEndLocal(toLocalInput(new Date(next.getTime() + (prevEnd.getTime() - prevStart.getTime())), timezone));
                  }}
                />
              </FormField>
              <FormField label="Ends" required error={errors.endsAt}>
                <Input type="datetime-local" value={endLocal} min={startLocal} onChange={(e) => touch(setEndLocal)(e.target.value)} />
              </FormField>
            </div>
          )}

          {!onlyOccurrence ? (
            <>
              <FormField label="Time zone" hint="Wall-clock times stay the same if you change the zone.">
                <NativeSelect value={timezone} onChange={(e) => touch(setTimezone)(e.target.value)}>
                  {(TIME_ZONES.includes(timezone) ? TIME_ZONES : [timezone, ...TIME_ZONES]).map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                      {z === workspaceZone ? ' (workspace)' : ''}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>

              <fieldset className="grid gap-3 rounded-lg border p-4">
                <legend className="px-1 text-sm font-medium">Repeat</legend>
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect aria-label="Repeat frequency" className="w-36" value={repeat.freq} onChange={(e) => touch(setRepeat)({ ...repeat, freq: e.target.value as RepeatState['freq'] })}>
                    <option value="NONE">Doesn’t repeat</option>
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                    <option value="YEARLY">Yearly</option>
                  </NativeSelect>
                  {repeat.freq !== 'NONE' ? (
                    <label className="flex items-center gap-2 text-sm">
                      every
                      <Input
                        type="number"
                        min={1}
                        max={366}
                        className="w-20"
                        value={repeat.interval}
                        onChange={(e) => touch(setRepeat)({ ...repeat, interval: Number(e.target.value) })}
                        aria-label="Repeat interval"
                      />
                      {{ DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)', YEARLY: 'year(s)' }[repeat.freq]}
                    </label>
                  ) : null}
                </div>
                {repeat.freq === 'WEEKLY' ? (
                  <div role="group" aria-label="Repeat on" className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => {
                      const on = repeat.byDay.length ? repeat.byDay.includes(d) : d === startWeekday;
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            const current = repeat.byDay.length ? repeat.byDay : [startWeekday];
                            const next = on ? current.filter((x) => x !== d) : [...current, d];
                            touch(setRepeat)({ ...repeat, byDay: next });
                          }}
                          className={cn(
                            'h-8 w-11 rounded-md border text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                          )}
                        >
                          {WEEKDAY_LABEL[d]}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {repeat.freq !== 'NONE' ? (
                  <div role="radiogroup" aria-label="Ends" className="flex flex-wrap items-center gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input type="radio" name="ends" checked={repeat.ends === 'never'} onChange={() => touch(setRepeat)({ ...repeat, ends: 'never' })} /> Never
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="ends" checked={repeat.ends === 'count'} onChange={() => touch(setRepeat)({ ...repeat, ends: 'count' })} /> After
                      <Input type="number" min={1} max={1000} className="h-8 w-20" value={repeat.count} disabled={repeat.ends !== 'count'} onChange={(e) => touch(setRepeat)({ ...repeat, count: Number(e.target.value) })} aria-label="Number of occurrences" />
                      times
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="ends" checked={repeat.ends === 'until'} onChange={() => touch(setRepeat)({ ...repeat, ends: 'until' })} /> On
                      <Input type="date" className="h-8 w-40" value={repeat.until} disabled={repeat.ends !== 'until'} onChange={(e) => touch(setRepeat)({ ...repeat, until: e.target.value })} aria-label="Last date" />
                    </label>
                  </div>
                ) : null}
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {rruleText}
                </p>
                {errors.rrule ? <p className="text-xs text-destructive">{errors.rrule}</p> : null}
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Location">
                  <Input maxLength={300} value={location} onChange={(e) => touch(setLocation)(e.target.value)} />
                </FormField>
                <FormField label="Visibility">
                  <NativeSelect value={visibility} onChange={(e) => touch(setVisibility)(e.target.value as 'workspace' | 'private')}>
                    <option value="workspace">Everyone in the workspace</option>
                    <option value="private">Private (organiser and attendees)</option>
                  </NativeSelect>
                </FormField>
              </div>
              <FormField label="Attendees" id="event-attendees">
                <PeoplePicker id="event-attendees" people={peopleList} value={attendees} onChange={touch(setAttendees)} />
              </FormField>
              {!event ? (
                <FormField label="Reminder">
                  <NativeSelect value={reminder} onChange={(e) => touch(setReminder)(e.target.value)}>
                    {REMINDER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              ) : null}
              <FormField label="Description">
                <Textarea rows={3} maxLength={10000} value={description} onChange={(e) => touch(setDescription)(e.target.value)} />
              </FormField>
            </>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {event ? 'Save' : 'Create event'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
