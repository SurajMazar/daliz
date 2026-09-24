import { TASK_PRIORITIES, TASK_STATUS_LABELS, type ProjectRow, type TaskRow, type TaskStatus } from '@daliz/shared';
import { ChevronDown, MessageSquare, Paperclip } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn } from '@/lib/utils';
import { usePeople } from './api';
import { PRIORITY_LABELS, PRIORITY_RANK, QuickAddTask, STATUS_ORDER, StatusDot, useUpdateTask } from './task-bits';

type Sort = 'position' | 'due' | 'priority' | 'updated';

export function ListView({ project, tasks, onOpen }: { project: ProjectRow; tasks: TaskRow[]; onOpen: (id: string) => void }) {
  const { canWrite } = useAccess();
  const [sort, setSort] = useState<Sort>('position');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ cancelled: true });
  const canCreate = project.canEdit && canWrite('planner.create');

  const sorted = useMemo(() => {
    const list = [...tasks];
    if (sort === 'due') list.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
    if (sort === 'priority') list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    if (sort === 'updated') list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list;
  }, [tasks, sort]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {canCreate ? <QuickAddTask projectId={project.id} className="min-w-64 flex-1" placeholder="Add a task and press Enter…" /> : <span className="flex-1" />}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Sort
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 w-36 text-sm">
            <option value="position">Manual</option>
            <option value="due">Due date</option>
            <option value="priority">Priority</option>
            <option value="updated">Recently updated</option>
          </NativeSelect>
        </label>
      </div>
      {STATUS_ORDER.map((status) => {
        const group = sorted.filter((t) => t.status === status);
        const isCollapsed = collapsed[status] ?? false;
        return (
          <section key={status} aria-label={TASK_STATUS_LABELS[status]} className="overflow-hidden rounded-xl border bg-card">
            <button
              type="button"
              className="flex w-full items-center gap-2 bg-muted/40 px-4 py-2.5 text-left text-sm font-semibold"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((c) => ({ ...c, [status]: !isCollapsed }))}
            >
              <ChevronDown className={cn('size-4 transition-transform', isCollapsed && '-rotate-90')} aria-hidden />
              <StatusDot status={status} />
              {TASK_STATUS_LABELS[status]}
              <span className="font-normal text-muted-foreground">{group.length}</span>
            </button>
            {!isCollapsed ? (
              group.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">No tasks</p>
              ) : (
                <ul className="divide-y">
                  {group.map((t) => (
                    <ListRow key={t.id} task={t} onOpen={() => onOpen(t.id)} />
                  ))}
                </ul>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ListRow({ task, onOpen }: { task: TaskRow; onOpen: () => void }) {
  const { canWrite } = useAccess();
  const fmt = useTenantFormat();
  const people = usePeople();
  const update = useUpdateTask();
  const editable = task.canEdit && canWrite('planner.update');
  const today = fmt.today();
  const overdue = task.dueDate && task.dueDate < today && task.status !== 'done' && task.status !== 'cancelled';
  const set = (patch: Record<string, unknown>) => update.mutate({ task, patch });
  const peopleOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name, keywords: p.email }));

  return (
    <li className="grid items-center gap-2 px-4 py-2 md:grid-cols-[minmax(0,1fr)_140px_170px_120px_150px]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
        <button type="button" onClick={onOpen} className={cn('truncate text-left text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none', task.status === 'done' && 'text-muted-foreground line-through')}>
          {task.title}
        </button>
        {task.labels.map((l) => (
          <Badge key={l.id} variant="outline" className="hidden gap-1 lg:inline-flex">
            <span className="size-2 rounded-full" style={{ backgroundColor: l.color }} aria-hidden />
            {l.name}
          </Badge>
        ))}
        {task.commentCount ? (
          <span className="hidden items-center gap-0.5 text-xs text-muted-foreground sm:inline-flex" aria-label={`${task.commentCount} comments`}>
            <MessageSquare className="size-3" aria-hidden /> {task.commentCount}
          </span>
        ) : null}
        {task.attachmentCount ? (
          <span className="hidden items-center gap-0.5 text-xs text-muted-foreground sm:inline-flex" aria-label={`${task.attachmentCount} attachments`}>
            <Paperclip className="size-3" aria-hidden /> {task.attachmentCount}
          </span>
        ) : null}
        {task.subtaskCount ? (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {task.subtaskDoneCount}/{task.subtaskCount}
          </span>
        ) : null}
      </div>
      <NativeSelect aria-label={`Status of ${task.key}`} className="h-8 text-xs" value={task.status} disabled={!editable || update.isPending} onChange={(e) => set({ status: e.target.value as TaskStatus })}>
        {STATUS_ORDER.map((s) => (
          <option key={s} value={s}>
            {TASK_STATUS_LABELS[s]}
          </option>
        ))}
      </NativeSelect>
      <Combobox
        aria-label={`Assignee of ${task.key}`}
        className="h-8 text-xs"
        options={peopleOptions}
        value={task.assignee?.id ?? null}
        onChange={(v) => set({ assigneeId: v })}
        placeholder="Unassigned"
        allowClear
        disabled={!editable}
        searchPlaceholder="Search people…"
      />
      <NativeSelect aria-label={`Priority of ${task.key}`} className="h-8 text-xs" value={task.priority} disabled={!editable} onChange={(e) => set({ priority: e.target.value })}>
        {TASK_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </option>
        ))}
      </NativeSelect>
      <Input
        type="date"
        aria-label={`Due date of ${task.key}`}
        className={cn('h-8 text-xs', overdue && 'border-destructive/60 text-destructive')}
        value={task.dueDate ?? ''}
        min={task.startDate ?? undefined}
        disabled={!editable}
        onChange={(e) => set({ dueDate: e.target.value || null })}
      />
    </li>
  );
}
