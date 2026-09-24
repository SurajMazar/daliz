import { useQueryClient } from '@tanstack/react-query';
import { TASK_STATUS_LABELS, type ProjectRow, type TaskDetail, type TaskRow, type TaskStatus } from '@daliz/shared';
import { ArrowRightLeft, Ellipsis, MessageSquare, Paperclip, Plus } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage, isApiError } from '@/lib/api';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn } from '@/lib/utils';
import { plannerKeys, projectTasksQuery } from './api';
import { AssigneeAvatar, DueLabel, PriorityIcon, QuickAddTask, STATUS_ORDER, StatusDot, useTaskCache } from './task-bits';

interface DropTarget {
  status: TaskStatus;
  index: number;
}

/** Applies a move to a task list (optimistic update): same algorithm the server uses for ordering. */
function applyMove(list: TaskRow[], id: string, status: TaskStatus, afterId: string | null, beforeId: string | null): TaskRow[] {
  const task = list.find((t) => t.id === id);
  if (!task) return list;
  const rest = list.filter((t) => t.id !== id);
  const moved = { ...task, status };
  let idx: number;
  if (afterId) idx = rest.findIndex((t) => t.id === afterId) + 1;
  else if (beforeId) idx = rest.findIndex((t) => t.id === beforeId);
  else {
    // End of the target column.
    const lastInColumn = [...rest].reverse().find((t) => t.status === status);
    idx = lastInColumn ? rest.indexOf(lastInColumn) + 1 : rest.length;
  }
  rest.splice(Math.max(0, idx), 0, moved);
  return rest;
}

export function BoardView({ project, tasks, onOpen }: { project: ProjectRow; tasks: TaskRow[]; onOpen: (id: string) => void }) {
  const { canWrite } = useAccess();
  const qc = useQueryClient();
  const write = useTaskCache();
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const columnRefs = useRef<Record<string, HTMLOListElement | null>>({});
  const canMove = project.canEdit && canWrite('planner.update');
  const canCreate = project.canEdit && canWrite('planner.create');
  const listKey = plannerKeys.tasks(projectTasksQuery(project.id));

  const move = async (task: TaskRow, status: TaskStatus, afterId: string | null, beforeId: string | null) => {
    if (afterId === task.id || beforeId === task.id) return;
    const snapshot = qc.getQueryData<TaskRow[]>(listKey);
    qc.setQueryData<TaskRow[]>(listKey, (old) => (old ? applyMove(old, task.id, status, afterId, beforeId) : old));
    try {
      const updated = await api.post<TaskDetail>(`/planner/tasks/${task.id}/move`, { status, afterTaskId: afterId, beforeTaskId: beforeId, version: task.version }, { silent: false });
      write(updated);
      void qc.invalidateQueries({ queryKey: plannerKeys.project(project.id) });
      void qc.invalidateQueries({ queryKey: plannerKeys.summary });
    } catch (e) {
      // Roll back the optimistic move.
      qc.setQueryData(listKey, snapshot);
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') void qc.invalidateQueries({ queryKey: plannerKeys.tasksAll });
      else toast.error(`Couldn’t move ${task.key}`, { description: errorMessage(e) });
    }
  };

  const columnTasks = (status: TaskStatus) => tasks.filter((t) => t.status === status);

  const indexFromPointer = (status: TaskStatus, clientY: number): number => {
    const el = columnRefs.current[status];
    if (!el) return 0;
    const cards = Array.from(el.querySelectorAll<HTMLElement>('[data-task-id]')).filter((c) => c.dataset.taskId !== dragId);
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i]!.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return cards.length;
  };

  const onColumnDragOver = (status: TaskStatus) => (e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const index = indexFromPointer(status, e.clientY);
    if (!drop || drop.status !== status || drop.index !== index) setDrop({ status, index });
  };

  const onColumnDrop = (status: TaskStatus) => (e: DragEvent) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData('text/plain');
    const task = tasks.find((t) => t.id === id);
    const index = indexFromPointer(status, e.clientY);
    setDragId(null);
    setDrop(null);
    if (!task) return;
    const col = columnTasks(status).filter((t) => t.id !== task.id);
    const after = col[index - 1]?.id ?? null;
    const before = col[index]?.id ?? null;
    const current = columnTasks(task.status);
    const unchanged = task.status === status && current.findIndex((t) => t.id === task.id) === index;
    if (unchanged) return;
    void move(task, status, after, before);
  };

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
      <div className="grid min-w-max auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3">
        {STATUS_ORDER.map((status) => {
          const col = columnTasks(status);
          const showDrop = drop?.status === status;
          return (
            <section
              key={status}
              aria-label={`${TASK_STATUS_LABELS[status]} column`}
              className={cn('flex max-h-[calc(100dvh-16rem)] min-h-48 w-[280px] flex-col rounded-xl border bg-muted/30', showDrop && 'border-primary/60 bg-primary/5')}
              onDragOver={onColumnDragOver(status)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((d) => (d?.status === status ? null : d));
              }}
              onDrop={onColumnDrop(status)}
            >
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <StatusDot status={status} />
                <h3 className="text-sm font-semibold">{TASK_STATUS_LABELS[status]}</h3>
                <span className="text-xs text-muted-foreground">{col.length}</span>
                {canCreate ? (
                  <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Add task to ${TASK_STATUS_LABELS[status]}`} onClick={() => setAdding(adding === status ? null : status)}>
                    <Plus />
                  </Button>
                ) : null}
              </header>
              {adding === status ? (
                <div className="px-3 pb-2">
                  <QuickAddTask projectId={project.id} defaults={{ status }} autoFocus placeholder="Task title, then Enter" onCreated={() => undefined} />
                </div>
              ) : null}
              <ol ref={(el) => void (columnRefs.current[status] = el)} className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
                {col.map((t, i) => (
                  <li key={t.id}>
                    {showDrop && drop.index === i && dragId !== t.id ? <DropIndicator /> : null}
                    <BoardCard
                      task={t}
                      draggable={canMove}
                      dragging={dragId === t.id}
                      onOpen={() => onOpen(t.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', t.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(t.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDrop(null);
                      }}
                      onMoveTo={(s) => {
                        const target = columnTasks(s).filter((x) => x.id !== t.id);
                        void move(t, s, target[target.length - 1]?.id ?? null, null);
                      }}
                      onReorder={(dir) => {
                        const siblings = col.filter((x) => x.id !== t.id);
                        const idx = col.findIndex((x) => x.id === t.id) + dir;
                        if (idx < 0 || idx > siblings.length) return;
                        void move(t, status, siblings[idx - 1]?.id ?? null, siblings[idx]?.id ?? null);
                      }}
                      canMove={canMove}
                      first={i === 0}
                      last={i === col.length - 1}
                    />
                  </li>
                ))}
                {showDrop && drop.index >= col.filter((x) => x.id !== dragId).length ? <DropIndicator /> : null}
                {col.length === 0 && !showDrop ? <li className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">No tasks</li> : null}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function DropIndicator() {
  return <div className="my-1 h-0.5 rounded-full bg-primary" aria-hidden />;
}

function BoardCard({
  task,
  draggable,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onMoveTo,
  onReorder,
  canMove,
  first,
  last,
}: {
  task: TaskRow;
  draggable: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onMoveTo: (s: TaskStatus) => void;
  onReorder: (dir: -1 | 1) => void;
  canMove: boolean;
  first: boolean;
  last: boolean;
}) {
  const fmt = useTenantFormat();
  return (
    <article
      data-task-id={task.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-roledescription={draggable ? 'Draggable task card' : undefined}
      className={cn('group relative rounded-lg border bg-card p-3 shadow-xs transition-shadow hover:shadow-md', draggable && 'cursor-grab active:cursor-grabbing', dragging && 'opacity-40')}
    >
      <button type="button" onClick={onOpen} className="block w-full pr-7 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{task.key}</span>
          <PriorityIcon priority={task.priority} />
        </div>
        <div className={cn('mt-1 text-sm leading-snug font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</div>
        {task.labels.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {task.labels.map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${l.color}22`, color: 'var(--foreground)' }}>
                <span className="size-1.5 rounded-full" style={{ backgroundColor: l.color }} aria-hidden />
                {l.name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <DueLabel due={task.dueDate} status={task.status} today={fmt.today()} locale={fmt.locale} />
          {task.subtaskCount ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {task.subtaskDoneCount}/{task.subtaskCount}
            </span>
          ) : null}
          {task.commentCount ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" aria-label={`${task.commentCount} comments`}>
              <MessageSquare className="size-3" aria-hidden /> {task.commentCount}
            </span>
          ) : null}
          {task.attachmentCount ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" aria-label={`${task.attachmentCount} attachments`}>
              <Paperclip className="size-3" aria-hidden /> {task.attachmentCount}
            </span>
          ) : null}
          <span className="ml-auto">
            <AssigneeAvatar person={task.assignee} />
          </span>
        </div>
      </button>
      {canMove ? (
        <div className="absolute top-2 right-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`Move ${task.key}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <ArrowRightLeft className="size-3.5" aria-hidden /> Move to…
              </DropdownMenuLabel>
              {STATUS_ORDER.filter((s) => s !== task.status).map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onMoveTo(s)}>
                  <StatusDot status={s} /> {TASK_STATUS_LABELS[s]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={first} onSelect={() => onReorder(-1)}>
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={last} onSelect={() => onReorder(1)}>
                Move down
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </article>
  );
}
