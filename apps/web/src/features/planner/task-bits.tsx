import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  TASK_STATUS_LABELS,
  type TaskDetail,
  type TaskPriority,
  type TaskRow,
  type TaskStatus,
} from '@daliz/shared';
import { ArrowDown, ArrowUp, ChevronsUp, Minus, Plus, SignalHigh } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatIsoDate } from '@/lib/dates';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { cn } from '@/lib/utils';
import { plannerKeys } from './api';
import { createTask, isOfflinePatch, updateTaskOffline } from './offline';
import { isNetworkError } from '@/offline/cache';
import { isOffline } from '@/offline/connectivity';

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];

export const STATUS_TONE: Record<TaskStatus, string> = {
  todo: 'bg-muted-foreground/60',
  in_progress: 'bg-primary',
  in_review: 'bg-warning',
  done: 'bg-success',
  cancelled: 'bg-muted-foreground/30',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_TONE[status])}
      aria-hidden
    />
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <StatusDot status={status} />
      {TASK_STATUS_LABELS[status]}
    </Badge>
  );
}

export function PriorityIcon({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  if (priority === 'none') return null;
  const Icon =
    priority === 'urgent'
      ? ChevronsUp
      : priority === 'high'
        ? ArrowUp
        : priority === 'medium'
          ? SignalHigh
          : ArrowDown;
  const tone =
    priority === 'urgent'
      ? 'text-destructive'
      : priority === 'high'
        ? 'text-warning'
        : priority === 'medium'
          ? 'text-primary'
          : 'text-muted-foreground';
  return (
    <Tooltip content={`${PRIORITY_LABELS[priority]} priority`}>
      <span
        className={cn('inline-flex', tone, className)}
        role="img"
        aria-label={`${PRIORITY_LABELS[priority]} priority`}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
    </Tooltip>
  );
}

export function AssigneeAvatar({
  person,
  size = 'sm',
}: {
  person: { name: string } | null;
  size?: 'sm' | 'md';
}) {
  if (!person) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full border border-dashed text-muted-foreground',
          size === 'sm' ? 'size-6' : 'size-8',
        )}
        aria-label="Unassigned"
        role="img"
      >
        <Minus className="size-3" aria-hidden />
      </span>
    );
  }
  return (
    <Tooltip content={person.name}>
      <span role="img" aria-label={`Assigned to ${person.name}`}>
        <Avatar name={person.name} className={size === 'sm' ? 'size-6 text-[10px]' : 'size-8'} />
      </span>
    </Tooltip>
  );
}

export function DueLabel({
  due,
  status,
  today,
  locale,
}: {
  due: string | null;
  status: TaskStatus;
  today: string;
  locale?: string;
}) {
  if (!due) return null;
  const overdue = due < today && status !== 'done' && status !== 'cancelled';
  const isToday = due === today;
  return (
    <span
      className={cn(
        'text-xs whitespace-nowrap tabular-nums',
        overdue
          ? 'font-medium text-destructive'
          : isToday
            ? 'font-medium text-warning'
            : 'text-muted-foreground',
      )}
    >
      {isToday ? 'Today' : formatIsoDate(due, { month: 'short', day: 'numeric' }, locale)}
      {overdue ? <span className="sr-only"> (overdue)</span> : null}
    </span>
  );
}

/** Replaces a task in every cached task list and the detail cache. */
export function useTaskCache() {
  const qc = useQueryClient();
  return (task: TaskRow | TaskDetail) => {
    qc.setQueriesData<TaskRow[]>({ queryKey: plannerKeys.tasksAll }, (old) =>
      Array.isArray(old) ? old.map((t) => (t.id === task.id ? { ...t, ...task } : t)) : old,
    );
    qc.setQueryData<TaskDetail>(plannerKeys.task(task.id), (old) =>
      old ? { ...old, ...task } : old,
    );
  };
}

/** PATCH a task with optimistic concurrency; on VERSION_CONFLICT refetches and tells the user. */
export function useUpdateTask() {
  const qc = useQueryClient();
  const write = useTaskCache();
  return useMutation({
    mutationFn: async ({
      task,
      patch,
    }: {
      task: Pick<TaskRow, 'id' | 'version' | 'title'>;
      patch: Record<string, unknown>;
    }): Promise<TaskDetail | null> => {
      // Status/title changes are queued offline (with the version they were based on).
      if (isOfflinePatch(patch) && isOffline()) {
        await updateTaskOffline(task, patch);
        return null;
      }
      try {
        return await api.patch<TaskDetail>(`/planner/tasks/${task.id}`, {
          ...patch,
          version: task.version,
        });
      } catch (e) {
        if (isOfflinePatch(patch) && isNetworkError(e)) {
          await updateTaskOffline(task, patch);
          return null;
        }
        throw e;
      }
    },
    meta: { silent: true },
    onSuccess: (updated, { task, patch }) => {
      if (!updated) {
        toast('Saved offline', {
          id: 'offline-saved',
          description: 'The change will sync when you’re back online.',
        });
        write({
          ...(qc.getQueryData<TaskDetail>(plannerKeys.task(task.id)) ?? {}),
          ...task,
          ...patch,
        } as TaskRow);
        return;
      }
      write(updated);
      void qc.invalidateQueries({ queryKey: plannerKeys.activity(updated.id) });
      void qc.invalidateQueries({ queryKey: plannerKeys.summary });
      if (updated.parentTaskId)
        void qc.invalidateQueries({ queryKey: plannerKeys.task(updated.parentTaskId) });
    },
    onError: (e, { task }) => {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
        // The global handler shows the conflict message; reload the latest copy.
        void qc.invalidateQueries({ queryKey: plannerKeys.task(task.id) });
        void qc.invalidateQueries({ queryKey: plannerKeys.tasksAll });
        return;
      }
      toast.error(errorMessage(e));
    },
  });
}

/** Inline "add a task" input; Enter creates it. */
export function QuickAddTask({
  projectId,
  defaults,
  placeholder = 'Add a task…',
  autoFocus,
  onCreated,
  className,
}: {
  projectId: string;
  defaults?: Partial<{ status: TaskStatus; dueDate: string; parentTaskId: string }>;
  placeholder?: string;
  autoFocus?: boolean;
  onCreated?: (t: TaskDetail) => void;
  className?: string;
}) {
  const qc = useQueryClient();
  const idem = useIdempotencyKey();
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || pending) return;
    const body = { projectId, title: t, ...defaults };
    setPending(true);
    try {
      const res = await withIdempotency(idem, body, (key) => createTask(body, key));
      setTitle('');
      if (res.queued) {
        toast('Task saved offline', {
          id: 'offline-saved',
          description: 'It will be created when you’re back online.',
        });
        return;
      }
      const created = res.result;
      void qc.invalidateQueries({ queryKey: plannerKeys.tasksAll });
      void qc.invalidateQueries({ queryKey: plannerKeys.project(projectId) });
      if (defaults?.parentTaskId)
        void qc.invalidateQueries({ queryKey: plannerKeys.task(defaults.parentTaskId) });
      onCreated?.(created);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
      // Stay in the input so several tasks can be added in a row.
      inputRef.current?.focus();
    }
  };
  return (
    <form onSubmit={submit} className={cn('relative', className)} aria-busy={pending || undefined}>
      <Plus
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={300}
        autoFocus={autoFocus}
        readOnly={pending}
        className="h-8 border-dashed bg-transparent pl-8 text-sm shadow-none"
      />
    </form>
  );
}
