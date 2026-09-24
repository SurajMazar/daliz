import type { EventOccurrenceRow } from '@daliz/shared';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Repeat } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { OnlineOnly } from '@/components/app/online-only';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { addDays, addMonths, formatIsoDate, parseIsoDate, startOfMonth } from '@/lib/dates';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { useShortcutAction } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { KIND_TONE, useOccurrences } from './api';
import { EventDialog } from './event-dialog';
import { EventDrawer } from './event-drawer';
import { RemindersPanel } from './reminders-panel';
import { dayKey, formatTime, minutesOfDay, startOfDayUtc } from './tz';

type View = 'month' | 'week' | 'agenda';
const VIEW_KEY = 'daliz.events.view';
const HOUR_PX = 44;

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'week' || v === 'agenda' ? v : 'month';
  } catch {
    return 'month';
  }
}

export function EventsPage() {
  const { canWrite, me } = useAccess();
  const fmt = useTenantFormat();
  const zone = fmt.timezone;
  const today = fmt.today();
  const weekStart = me.tenant?.settings.weekStartsOn ?? 1;
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'reminders' ? 'reminders' : 'calendar';
  const [view, setViewState] = useState<View>(readView);
  const [anchor, setAnchor] = useState(today);
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState<string | null | undefined>(undefined);

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  };
  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      setParams(next);
    },
    [params, setParams],
  );

  useShortcutAction('new', () => canWrite('events.create') && setCreating(null));

  const range = useMemo(() => {
    const weekday = (d: string) => (parseIsoDate(d).getUTCDay() - weekStart + 7) % 7;
    if (view === 'month') {
      const first = startOfMonth(anchor);
      const start = addDays(first, -weekday(first));
      return { startDay: start, days: 42 };
    }
    if (view === 'week') {
      const start = addDays(anchor, -weekday(anchor));
      return { startDay: start, days: 7 };
    }
    return { startDay: anchor, days: 30 };
  }, [view, anchor, weekStart]);

  const from = useMemo(() => startOfDayUtc(range.startDay, zone), [range, zone]);
  const to = useMemo(() => startOfDayUtc(addDays(range.startDay, range.days), zone), [range, zone]);
  const occurrences = useOccurrences(from, to, mine);

  const open = (o: EventOccurrenceRow) =>
    setParam({
      event: o.eventId,
      occ: o.recurring ? o.occurrenceStart : null,
      ostart: o.start,
      oend: o.end,
      otitle: o.title,
    });
  const eventId = params.get('event');
  const occRef =
    eventId && params.get('occ')
      ? {
          occurrenceStart: params.get('occ')!,
          start: params.get('ostart') ?? params.get('occ')!,
          end: params.get('oend') ?? params.get('occ')!,
          title: params.get('otitle') ?? '',
        }
      : null;

  const step = (dir: -1 | 1) =>
    setAnchor((a) =>
      view === 'month' ? addMonths(a, dir) : addDays(a, dir * (view === 'week' ? 7 : 30)),
    );
  const title =
    view === 'month'
      ? formatIsoDate(startOfMonth(anchor), { month: 'long', year: 'numeric' }, fmt.locale)
      : `${formatIsoDate(range.startDay, { month: 'short', day: 'numeric' }, fmt.locale)} – ${formatIsoDate(addDays(range.startDay, range.days - 1), { month: 'short', day: 'numeric', year: 'numeric' }, fmt.locale)}`;

  return (
    <>
      <PageHeader
        title="Events"
        description={`Calendar and reminders · times shown in ${zone.replace(/_/g, ' ')}`}
        actions={
          canWrite('events.create') && tab === 'calendar' ? (
            <OnlineOnly>
              <Button onClick={() => setCreating(null)}>
                <Plus /> New event
              </Button>
            </OnlineOnly>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setParam({ tab: v === 'reminders' ? 'reminders' : null })}
      >
        <TabsList>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
          <TabsTrigger value="reminders">Reminders</TabsTrigger>
        </TabsList>
        <TabsContent value="calendar">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="min-w-44 text-lg font-semibold" aria-live="polite">
              {title}
            </h2>
            <Button variant="outline" size="icon-sm" aria-label="Previous" onClick={() => step(-1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(today)}>
              Today
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Next" onClick={() => step(1)}>
              <ChevronRight />
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="mine-only"
                  checked={mine}
                  onCheckedChange={(c) => setMine(c === true)}
                />
                <Label htmlFor="mine-only" className="font-normal">
                  Only mine
                </Label>
              </div>
              <Segmented
                label="Calendar view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'month', label: 'Month' },
                  { value: 'week', label: 'Week' },
                  { value: 'agenda', label: 'Agenda' },
                ]}
              />
            </div>
          </div>
          {occurrences.isError ? (
            <Card>
              <ErrorState error={occurrences.error} onRetry={() => void occurrences.refetch()} />
            </Card>
          ) : occurrences.isPending ? (
            <Skeleton className="h-[480px] w-full" />
          ) : view === 'month' ? (
            <MonthView
              startDay={range.startDay}
              anchor={anchor}
              occurrences={occurrences.data}
              onOpen={open}
              onCreate={canWrite('events.create') ? (d) => setCreating(d) : undefined}
            />
          ) : view === 'week' ? (
            <WeekView
              startDay={range.startDay}
              occurrences={occurrences.data}
              onOpen={open}
              onCreate={canWrite('events.create') ? (d) => setCreating(d) : undefined}
            />
          ) : (
            <AgendaView occurrences={occurrences.data} onOpen={open} />
          )}
        </TabsContent>
        <TabsContent value="reminders">
          <RemindersPanel />
        </TabsContent>
      </Tabs>
      {creating !== undefined ? (
        <EventDialog defaultDay={creating ?? undefined} onClose={() => setCreating(undefined)} />
      ) : null}
      <EventDrawer
        eventId={eventId}
        occurrence={occRef}
        onClose={() => setParam({ event: null, occ: null, ostart: null, oend: null, otitle: null })}
      />
    </>
  );
}

/** Groups occurrences by the workspace-zone days they cover (all-day events span days). */
function useByDay(occurrences: EventOccurrenceRow[]) {
  const { timezone } = useTenantFormat();
  return useMemo(() => {
    const map = new Map<string, EventOccurrenceRow[]>();
    for (const o of occurrences) {
      const first = dayKey(o.start, timezone);
      // End is exclusive: the last covered day is the day of (end - 1ms).
      const last = dayKey(new Date(new Date(o.end).getTime() - 1), timezone);
      let d = first;
      for (let i = 0; i < 15 && d <= last; i++) {
        map.set(d, [...(map.get(d) ?? []), o]);
        d = addDays(d, 1);
      }
    }
    for (const list of map.values())
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    return map;
  }, [occurrences, timezone]);
}

function Chip({
  o,
  onOpen,
  compact,
}: {
  o: EventOccurrenceRow;
  onOpen: () => void;
  compact?: boolean;
}) {
  const fmt = useTenantFormat();
  const cancelled = o.status === 'cancelled';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-1 truncate rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-xs outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring',
        KIND_TONE[o.kind],
        o.allDay && 'font-medium',
        cancelled && 'text-muted-foreground line-through opacity-70',
      )}
      title={o.title}
    >
      {!o.allDay && !compact ? (
        <span className="shrink-0 tabular-nums opacity-80">
          {formatTime(o.start, fmt.timezone, fmt.locale)}
        </span>
      ) : null}
      <span className="truncate">{o.title}</span>
      {o.recurring ? (
        <Repeat className="ml-auto size-3 shrink-0 opacity-60" aria-label="Recurring" />
      ) : null}
    </button>
  );
}

function MonthView({
  startDay,
  anchor,
  occurrences,
  onOpen,
  onCreate,
}: {
  startDay: string;
  anchor: string;
  occurrences: EventOccurrenceRow[];
  onOpen: (o: EventOccurrenceRow) => void;
  onCreate?: (day: string) => void;
}) {
  const fmt = useTenantFormat();
  const byDay = useByDay(occurrences);
  const today = fmt.today();
  const days = Array.from({ length: 42 }, (_, i) => addDays(startDay, i));
  return (
    <div className="overflow-x-auto">
      <div
        role="grid"
        aria-label="Month"
        className="grid min-w-[720px] grid-cols-7 overflow-hidden rounded-xl border"
      >
        {days.slice(0, 7).map((d) => (
          <div
            key={d}
            role="columnheader"
            className="border-b bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground"
          >
            {formatIsoDate(d, { weekday: 'short' }, fmt.locale)}
          </div>
        ))}
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
          return (
            <div
              key={d}
              role="gridcell"
              aria-label={formatIsoDate(d, { dateStyle: 'full' }, fmt.locale)}
              className={cn(
                'group min-h-28 min-w-0 border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0',
                !inMonth && 'bg-muted/30',
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <span
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full text-xs tabular-nums',
                    d === today
                      ? 'bg-primary font-semibold text-primary-foreground'
                      : inMonth
                        ? ''
                        : 'text-muted-foreground',
                  )}
                >
                  {Number(d.slice(8))}
                </span>
                {onCreate ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`New event on ${formatIsoDate(d, { dateStyle: 'medium' }, fmt.locale)}`}
                    onClick={() => onCreate(d)}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <ul className="grid grid-cols-1 gap-1">
                {list.slice(0, 4).map((o) => (
                  <li key={o.occurrenceId} className="min-w-0">
                    <Chip o={o} onOpen={() => onOpen(o)} />
                  </li>
                ))}
                {list.length > 4 ? (
                  <li className="px-1.5 text-xs text-muted-foreground">+{list.length - 4} more</li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Assigns overlapping timed events to side-by-side lanes. */
function lanes(list: EventOccurrenceRow[]): Map<string, { lane: number; count: number }> {
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
  const result = new Map<string, { lane: number; count: number }>();
  let cluster: EventOccurrenceRow[] = [];
  let clusterEnd = '';
  const flush = () => {
    const ends: string[] = [];
    const assigned: [EventOccurrenceRow, number][] = [];
    for (const o of cluster) {
      let lane = ends.findIndex((e) => e <= o.start);
      if (lane === -1) lane = ends.length;
      ends[lane] = o.end;
      assigned.push([o, lane]);
    }
    for (const [o, lane] of assigned) result.set(o.occurrenceId, { lane, count: ends.length });
    cluster = [];
  };
  for (const o of sorted) {
    if (cluster.length && o.start >= clusterEnd) flush();
    cluster.push(o);
    if (o.end > clusterEnd || cluster.length === 1)
      clusterEnd = o.end > clusterEnd ? o.end : clusterEnd;
  }
  if (cluster.length) flush();
  return result;
}

function WeekView({
  startDay,
  occurrences,
  onOpen,
  onCreate,
}: {
  startDay: string;
  occurrences: EventOccurrenceRow[];
  onOpen: (o: EventOccurrenceRow) => void;
  onCreate?: (day: string) => void;
}) {
  const fmt = useTenantFormat();
  const zone = fmt.timezone;
  const byDay = useByDay(occurrences);
  const today = fmt.today();
  const days = Array.from({ length: 7 }, (_, i) => addDays(startDay, i));
  const [nowMin, setNowMin] = useState(() => minutesOfDay(new Date(), zone));
  useEffect(() => {
    const t = window.setInterval(() => setNowMin(minutesOfDay(new Date(), zone)), 60_000);
    return () => window.clearInterval(t);
  }, [zone]);

  return (
    <div className="overflow-x-auto rounded-xl border">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b bg-muted/40">
          <div />
          {days.map((d) => (
            <div
              key={d}
              className={cn(
                'border-l px-2 py-1.5 text-xs font-medium',
                d === today ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {formatIsoDate(d, { weekday: 'short', day: 'numeric' }, fmt.locale)}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b">
          <div className="px-1 py-1 text-right text-[10px] text-muted-foreground">all day</div>
          {days.map((d) => (
            <div key={d} className="grid min-h-8 gap-1 border-l p-1">
              {(byDay.get(d) ?? [])
                .filter((o) => o.allDay)
                .map((o) => (
                  <Chip key={o.occurrenceId} o={o} onOpen={() => onOpen(o)} compact />
                ))}
            </div>
          ))}
        </div>
        <div className="relative max-h-[600px] overflow-y-auto">
          <div
            className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]"
            style={{ height: HOUR_PX * 24 }}
          >
            <div className="relative">
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
                  style={{ top: h * HOUR_PX }}
                >
                  {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
                </div>
              ))}
            </div>
            {days.map((d) => {
              const timed = (byDay.get(d) ?? []).filter((o) => !o.allDay);
              const laneMap = lanes(timed);
              return (
                <div
                  key={d}
                  className="relative border-l"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${HOUR_PX}px)`,
                  }}
                  onDoubleClick={() => onCreate?.(d)}
                >
                  {d === today ? (
                    <div
                      className="absolute inset-x-0 z-10 h-px bg-destructive"
                      style={{ top: (nowMin / 60) * HOUR_PX }}
                      aria-hidden
                    />
                  ) : null}
                  {timed.map((o) => {
                    const startDayKey = dayKey(o.start, zone);
                    const endMs = new Date(o.end).getTime();
                    const startMin = startDayKey < d ? 0 : minutesOfDay(o.start, zone);
                    const endMin =
                      dayKey(new Date(endMs - 1), zone) > d
                        ? 24 * 60
                        : minutesOfDay(o.end, zone) || 24 * 60;
                    const l = laneMap.get(o.occurrenceId) ?? { lane: 0, count: 1 };
                    return (
                      <button
                        key={o.occurrenceId}
                        type="button"
                        onClick={() => onOpen(o)}
                        className={cn(
                          'absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          KIND_TONE[o.kind],
                          o.status === 'cancelled' && 'line-through opacity-60',
                        )}
                        style={{
                          top: (startMin / 60) * HOUR_PX,
                          height: Math.max(18, ((endMin - startMin) / 60) * HOUR_PX - 2),
                          left: `calc(${(l.lane / l.count) * 100}% + 2px)`,
                          width: `calc(${100 / l.count}% - 4px)`,
                        }}
                      >
                        <div className="truncate font-medium">{o.title}</div>
                        <div className="truncate opacity-80">
                          {formatTime(o.start, zone, fmt.locale)} –{' '}
                          {formatTime(o.end, zone, fmt.locale)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgendaView({
  occurrences,
  onOpen,
}: {
  occurrences: EventOccurrenceRow[];
  onOpen: (o: EventOccurrenceRow) => void;
}) {
  const fmt = useTenantFormat();
  const zone = fmt.timezone;
  const groups = useMemo(() => {
    const m = new Map<string, EventOccurrenceRow[]>();
    for (const o of [...occurrences].sort((a, b) => a.start.localeCompare(b.start))) {
      const d = dayKey(o.start, zone);
      m.set(d, [...(m.get(d) ?? []), o]);
    }
    return [...m.entries()];
  }, [occurrences, zone]);
  if (groups.length === 0)
    return (
      <Card>
        <EmptyState icon={CalendarDays} title="Nothing scheduled in the next 30 days" />
      </Card>
    );
  return (
    <Card className="divide-y overflow-hidden">
      {groups.map(([d, list]) => (
        <section
          key={d}
          aria-label={formatIsoDate(d, { dateStyle: 'full' }, fmt.locale)}
          className="grid gap-2 p-4 sm:grid-cols-[180px_minmax(0,1fr)]"
        >
          <h3 className={cn('text-sm font-semibold', d === fmt.today() && 'text-primary')}>
            {formatIsoDate(d, { weekday: 'long', month: 'short', day: 'numeric' }, fmt.locale)}
          </h3>
          <ul className="grid gap-1.5">
            {list.map((o) => (
              <li key={o.occurrenceId}>
                <button
                  type="button"
                  onClick={() => onOpen(o)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md border-l-[3px] px-3 py-2 text-left text-sm outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring',
                    KIND_TONE[o.kind],
                    o.status === 'cancelled' && 'line-through opacity-60',
                  )}
                >
                  <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {o.allDay
                      ? 'All day'
                      : `${formatTime(o.start, zone, fmt.locale)} – ${formatTime(o.end, zone, fmt.locale)}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{o.title}</span>
                  {o.location ? (
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                      {o.location}
                    </span>
                  ) : null}
                  {o.recurring ? (
                    <Repeat className="size-3.5 text-muted-foreground" aria-label="Recurring" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}
