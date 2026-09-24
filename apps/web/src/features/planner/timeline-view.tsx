import type { TaskRow } from '@daliz/shared';
import { CalendarRange } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { addDays, diffDays, formatIsoDate, parseIsoDate } from '@/lib/dates';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn } from '@/lib/utils';
import { STATUS_TONE } from './task-bits';

type Zoom = 'week' | 'month';
const DAY_WIDTH: Record<Zoom, number> = { week: 36, month: 12 };

/** Horizontal bars from start → due for every task with at least one date. */
export function TimelineView({
  tasks,
  onOpen,
}: {
  tasks: TaskRow[];
  onOpen: (id: string) => void;
}) {
  const fmt = useTenantFormat();
  const today = fmt.today();
  const [zoom, setZoom] = useState<Zoom>('week');
  const dayW = DAY_WIDTH[zoom];

  const dated = useMemo(
    () =>
      tasks
        .filter((t) => t.startDate || t.dueDate)
        .map((t) => ({
          task: t,
          start: (t.startDate ?? t.dueDate)!,
          end: (t.dueDate ?? t.startDate)!,
        }))
        .sort((a, b) => a.start.localeCompare(b.start)),
    [tasks],
  );

  const range = useMemo(() => {
    if (dated.length === 0) return null;
    let min = dated[0]!.start;
    let max = dated[0]!.end;
    for (const d of dated) {
      if (d.start < min) min = d.start;
      if (d.end > max) max = d.end;
    }
    if (today < min) min = today;
    if (today > max) max = today;
    const from = addDays(min, -3);
    const to = addDays(max, 7);
    const span = Math.max(diffDays(from, to) + 1, zoom === 'week' ? 28 : 90);
    return { from, days: span };
  }, [dated, today, zoom]);

  if (!range) {
    return (
      <EmptyState
        icon={CalendarRange}
        title="No scheduled tasks"
        description="Give tasks a start or due date to see them on the timeline."
      />
    );
  }

  const width = range.days * dayW;
  const days = Array.from({ length: range.days }, (_, i) => addDays(range.from, i));
  const months: { label: string; left: number; width: number }[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    if (i === 0 || d.endsWith('-01'))
      months.push({
        label: formatIsoDate(d, { month: 'short', year: 'numeric' }, fmt.locale),
        left: i * dayW,
        width: 0,
      });
  }
  months.forEach((m, i) => (m.width = (months[i + 1]?.left ?? width) - m.left));
  const todayLeft = diffDays(range.from, today) * dayW;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {dated.length} scheduled task{dated.length === 1 ? '' : 's'}
        </p>
        <Segmented
          label="Zoom"
          value={zoom}
          onChange={setZoom}
          options={[
            { value: 'week', label: 'Weeks' },
            { value: 'month', label: 'Months' },
          ]}
        />
      </div>
      <div className="overflow-hidden rounded-xl border">
        <div className="flex max-h-[calc(100dvh-18rem)] overflow-auto">
          <div className="sticky left-0 z-20 w-52 shrink-0 border-r bg-card">
            <div className="flex h-14 items-end border-b px-3 pb-2 text-xs font-medium text-muted-foreground">
              Task
            </div>
            {dated.map(({ task }) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onOpen(task.id)}
                className="flex h-10 w-full items-center gap-2 border-b px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <span className="font-mono text-[10px] text-muted-foreground">{task.key}</span>
                <span className="truncate">{task.title}</span>
              </button>
            ))}
          </div>
          <div className="relative shrink-0" style={{ width }}>
            <div className="sticky top-0 z-10 h-14 border-b bg-card">
              <div className="relative h-7 border-b">
                {months.map((m) => (
                  <div
                    key={m.left}
                    className="absolute top-0 flex h-7 items-center border-l px-2 text-xs font-medium whitespace-nowrap"
                    style={{ left: m.left, width: m.width }}
                  >
                    {m.label}
                  </div>
                ))}
              </div>
              <div className="relative h-7">
                {days.map((d, i) => {
                  const weekday = parseIsoDate(d).getUTCDay();
                  const show = zoom === 'week' || weekday === 1;
                  return show ? (
                    <div
                      key={d}
                      className={cn(
                        'absolute top-0 flex h-7 items-center justify-center text-[10px] text-muted-foreground tabular-nums',
                        d === today && 'font-semibold text-primary',
                      )}
                      style={{ left: i * dayW, width: zoom === 'week' ? dayW : dayW * 7 }}
                    >
                      {Number(d.slice(8))}
                    </div>
                  ) : null;
                })}
              </div>
            </div>
            {/* Weekend shading and today line */}
            <div className="pointer-events-none absolute inset-x-0 top-14 bottom-0">
              {zoom === 'week'
                ? days.map((d, i) => {
                    const wd = parseIsoDate(d).getUTCDay();
                    return wd === 0 || wd === 6 ? (
                      <div
                        key={d}
                        className="absolute top-0 bottom-0 bg-muted/40"
                        style={{ left: i * dayW, width: dayW }}
                      />
                    ) : null;
                  })
                : null}
              <div
                className="absolute top-0 bottom-0 w-px bg-primary"
                style={{ left: todayLeft + dayW / 2 }}
                aria-hidden
              />
            </div>
            {dated.map(({ task, start, end }) => {
              const left = diffDays(range.from, start) * dayW;
              const barW = Math.max(dayW, (diffDays(start, end) + 1) * dayW);
              return (
                <div key={task.id} className="relative h-10 border-b">
                  <button
                    type="button"
                    onClick={() => onOpen(task.id)}
                    title={`${task.title}: ${formatIsoDate(start, undefined, fmt.locale)} – ${formatIsoDate(end, undefined, fmt.locale)}`}
                    aria-label={`${task.key} ${task.title}, ${formatIsoDate(start, undefined, fmt.locale)} to ${formatIsoDate(end, undefined, fmt.locale)}`}
                    className={cn(
                      'absolute top-2 flex h-6 items-center gap-1.5 overflow-hidden rounded-md bg-secondary px-1.5 text-left text-[11px] font-medium text-secondary-foreground shadow-xs ring-1 ring-border outline-none hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring',
                      task.status === 'done' && 'opacity-70',
                    )}
                    style={{ left, width: barW }}
                  >
                    <span
                      className={cn('h-4 w-1 shrink-0 rounded-full', STATUS_TONE[task.status])}
                      aria-hidden
                    />
                    <span className="truncate">{barW > 60 ? task.title : ''}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
