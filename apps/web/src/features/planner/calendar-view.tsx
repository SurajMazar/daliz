import type { ProjectRow, TaskRow } from '@daliz/shared';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { addDays, addMonths, formatIsoDate, parseIsoDate, startOfMonth } from '@/lib/dates';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn } from '@/lib/utils';
import { QuickAddTask, STATUS_TONE } from './task-bits';

export function CalendarView({
  project,
  tasks,
  onOpen,
}: {
  project: ProjectRow;
  tasks: TaskRow[];
  onOpen: (id: string) => void;
}) {
  const { canWrite, me } = useAccess();
  const fmt = useTenantFormat();
  const today = fmt.today();
  const [month, setMonth] = useState(startOfMonth(today));
  const [createOn, setCreateOn] = useState<string | null>(null);
  const weekStart = me.tenant?.settings.weekStartsOn ?? 1;
  const canCreate = project.canEdit && canWrite('planner.create');

  const days = useMemo(() => {
    const first = parseIsoDate(month);
    const offset = (first.getUTCDay() - weekStart + 7) % 7;
    const start = addDays(month, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month, weekStart]);

  const byDay = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const t of tasks) if (t.dueDate) m.set(t.dueDate, [...(m.get(t.dueDate) ?? []), t]);
    return m;
  }, [tasks]);

  const weekdayNames = Array.from({ length: 7 }, (_, i) =>
    formatIsoDate(days[i]!, { weekday: 'short' }, fmt.locale),
  );
  const undated = tasks.filter(
    (t) => !t.dueDate && t.status !== 'done' && t.status !== 'cancelled',
  ).length;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-40 text-lg font-semibold" aria-live="polite">
          {formatIsoDate(month, { month: 'long', year: 'numeric' }, fmt.locale)}
        </h2>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous month"
          onClick={() => setMonth(addMonths(month, -1))}
        >
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setMonth(startOfMonth(today))}>
          Today
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next month"
          onClick={() => setMonth(addMonths(month, 1))}
        >
          <ChevronRight />
        </Button>
        {undated ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {undated} open task{undated === 1 ? '' : 's'} without a due date
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[720px] grid-cols-7 overflow-hidden rounded-xl border"
          role="grid"
          aria-label="Tasks by due date"
        >
          {weekdayNames.map((d) => (
            <div
              key={d}
              role="columnheader"
              className="border-b bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground"
            >
              {d}
            </div>
          ))}
          {days.map((day) => {
            const inMonth = day.slice(0, 7) === month.slice(0, 7);
            const list = byDay.get(day) ?? [];
            const isToday = day === today;
            return (
              <div
                key={day}
                role="gridcell"
                aria-label={formatIsoDate(day, { dateStyle: 'full' }, fmt.locale)}
                className={cn(
                  'group relative min-h-28 border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0',
                  !inMonth && 'bg-muted/30',
                )}
                onDoubleClick={() => canCreate && setCreateOn(day)}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full text-xs tabular-nums',
                      isToday
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : inMonth
                          ? 'text-foreground'
                          : 'text-muted-foreground',
                    )}
                  >
                    {Number(day.slice(8))}
                  </span>
                  {canCreate ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`Add task due ${formatIsoDate(day, { dateStyle: 'medium' }, fmt.locale)}`}
                      onClick={() => setCreateOn(day)}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <ul className="grid gap-1">
                  {list.slice(0, 4).map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className={cn(
                          'flex w-full items-center gap-1.5 truncate rounded-md bg-card px-1.5 py-1 text-left text-xs shadow-xs ring-1 ring-border hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                          t.status === 'done' && 'text-muted-foreground line-through',
                        )}
                      >
                        <span
                          className={cn('size-1.5 shrink-0 rounded-full', STATUS_TONE[t.status])}
                          aria-hidden
                        />
                        <span className="truncate">{t.title}</span>
                      </button>
                    </li>
                  ))}
                  {list.length > 4 ? (
                    <li className="px-1.5 text-xs text-muted-foreground">
                      +{list.length - 4} more
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
      <Dialog open={!!createOn} onOpenChange={(o) => !o && setCreateOn(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              Due {createOn ? formatIsoDate(createOn, { dateStyle: 'full' }, fmt.locale) : ''}
            </DialogDescription>
          </DialogHeader>
          {createOn ? (
            <QuickAddTask
              projectId={project.id}
              defaults={{ dueDate: createOn }}
              autoFocus
              placeholder="Task title, then Enter"
              onCreated={() => setCreateOn(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
