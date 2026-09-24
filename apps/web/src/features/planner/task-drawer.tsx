import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TASK_PRIORITIES, TASK_STATUS_LABELS, type ActivityRow, type CommentRow, type LabelRow, type TaskDetail, type TaskRow } from '@daliz/shared';
import { Check, MessageSquare, Paperclip, Pencil, Plus, Tag, Trash, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { FilePickerDialog } from '@/features/files/file-picker-dialog';
import { downloadFile, formatBytes } from '@/features/files/api';
import { api, errorMessage } from '@/lib/api';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { useAccess } from '@/lib/session';
import { ago, cn, formatDateTime, humanize } from '@/lib/utils';
import { plannerKeys, useActivity, useComments, useLabels, usePeople, useTask } from './api';
import { PRIORITY_LABELS, QuickAddTask, STATUS_ORDER, useTaskCache, useUpdateTask } from './task-bits';

const LABEL_COLORS = ['#2753d7', '#0f766e', '#b91c1c', '#9a5b00', '#7c3aed', '#be185d', '#15803d', '#475569'];

export function TaskDrawer({ taskId, onClose, onOpenTask }: { taskId: string | null; onClose: () => void; onOpenTask: (id: string) => void }) {
  const task = useTask(taskId);
  return (
    <Sheet open={!!taskId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-2xl sm:w-[640px]">
        {task.isPending ? (
          <div className="grid gap-4 p-6">
            <SheetTitle className="sr-only">Loading task</SheetTitle>
            <SheetDescription className="sr-only">Loading</SheetDescription>
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : task.isError ? (
          <div className="p-6">
            <SheetTitle className="sr-only">Task</SheetTitle>
            <SheetDescription className="sr-only">Could not load the task</SheetDescription>
            <ErrorState error={task.error} onRetry={() => void task.refetch()} />
          </div>
        ) : (
          <TaskDetailBody key={task.data.id} task={task.data} onOpenTask={onOpenTask} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function TaskDetailBody({ task, onOpenTask }: { task: TaskDetail; onOpenTask: (id: string) => void }) {
  const { canWrite, can } = useAccess();
  const qc = useQueryClient();
  const update = useUpdateTask();
  const people = usePeople();
  const editable = task.canEdit && canWrite('planner.update');
  const set = (patch: Record<string, unknown>) => update.mutate({ task, patch });
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description), [task.description]);
  const remove = useMutation({
    mutationFn: () => api.delete(`/planner/tasks/${task.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: plannerKeys.all });
    },
  });

  const peopleOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name, keywords: p.email }));
  const hours = task.estimateMinutes === null ? '' : String(Math.round((task.estimateMinutes / 60) * 100) / 100);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b p-5 pr-12">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{task.key}</span>
          <span aria-hidden>·</span>
          <span>{task.projectName}</span>
          {task.parentTaskId ? (
            <Button variant="link" className="h-auto text-xs" onClick={() => onOpenTask(task.parentTaskId!)}>
              Open parent task
            </Button>
          ) : null}
        </div>
        <SheetTitle asChild>
          <h2 className="sr-only">{task.title}</h2>
        </SheetTitle>
        <SheetDescription className="sr-only">Task details</SheetDescription>
        <Input
          aria-label="Task title"
          value={title}
          readOnly={!editable}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const t = title.trim();
            if (t && t !== task.title) set({ title: t });
            else setTitle(task.title);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setTitle(task.title);
          }}
          className="h-auto border-transparent px-1 text-xl font-semibold shadow-none hover:border-input focus-visible:border-ring"
        />
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
          <Field label="Status" id="task-status">
            <NativeSelect id="task-status" className="h-8" value={task.status} disabled={!editable} onChange={(e) => set({ status: e.target.value })}>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Assignee" id="task-assignee">
            <Combobox id="task-assignee" className="h-8" options={peopleOptions} value={task.assignee?.id ?? null} onChange={(v) => set({ assigneeId: v })} placeholder="Unassigned" allowClear disabled={!editable} searchPlaceholder="Search people…" />
          </Field>
          <Field label="Priority" id="task-priority">
            <NativeSelect id="task-priority" className="h-8" value={task.priority} disabled={!editable} onChange={(e) => set({ priority: e.target.value })}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Dates" id="task-start">
            <div className="flex items-center gap-2">
              <Input id="task-start" aria-label="Start date" type="date" className="h-8" value={task.startDate ?? ''} max={task.dueDate ?? undefined} disabled={!editable} onChange={(e) => set({ startDate: e.target.value || null })} />
              <span className="text-muted-foreground">→</span>
              <Input aria-label="Due date" type="date" className="h-8" value={task.dueDate ?? ''} min={task.startDate ?? undefined} disabled={!editable} onChange={(e) => set({ dueDate: e.target.value || null })} />
            </div>
          </Field>
          <Field label="Estimate" id="task-estimate">
            <div className="flex items-center gap-2">
              <Input
                id="task-estimate"
                type="number"
                min={0}
                step={0.25}
                className="h-8 w-28"
                defaultValue={hours}
                key={hours}
                disabled={!editable}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const minutes = v === '' ? null : Math.round(Number(v) * 60);
                  if (minutes !== task.estimateMinutes && (minutes === null || (Number.isFinite(minutes) && minutes >= 0))) set({ estimateMinutes: minutes });
                }}
              />
              <span className="text-muted-foreground">hours</span>
            </div>
          </Field>
          <Field label="Labels" id="task-labels">
            <LabelsEditor task={task} editable={editable} onChange={(ids) => set({ labelIds: ids })} />
          </Field>
          <dt className="text-muted-foreground">Reporter</dt>
          <dd className="text-sm">{task.reporter?.name ?? '—'}</dd>
        </dl>

        <section className="mt-6 grid gap-2">
          <Label htmlFor="task-description">Description</Label>
          <Textarea id="task-description" rows={5} value={description} readOnly={!editable} onChange={(e) => setDescription(e.target.value)} placeholder={editable ? 'Add more detail…' : 'No description'} />
          {editable && description !== task.description ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => set({ description })} loading={update.isPending}>
                Save description
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDescription(task.description)}>
                Cancel
              </Button>
            </div>
          ) : null}
        </section>

        {!task.parentTaskId ? <Subtasks task={task} onOpenTask={onOpenTask} editable={editable} /> : null}
        <Attachments task={task} editable={editable && can('files.read')} />

        <Tabs defaultValue="comments" className="mt-6">
          <TabsList>
            <TabsTrigger value="comments">
              <MessageSquare /> Comments
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="comments">
            <Comments taskId={task.id} />
          </TabsContent>
          <TabsContent value="activity">
            <Activity taskId={task.id} />
          </TabsContent>
        </Tabs>
      </div>
      <footer className="flex items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>
          Created {ago(task.createdAt)} · updated <time title={formatDateTime(task.updatedAt)}>{ago(task.updatedAt)}</time>
          {task.completedAt ? ` · completed ${ago(task.completedAt)}` : ''}
        </span>
        {task.canEdit && canWrite('planner.delete') ? (
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash /> Delete
          </Button>
        ) : null}
      </footer>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        title={`Delete ${task.key}?`}
        description="The task, its subtasks and comments are removed."
        confirmLabel="Delete task"
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success(`${task.key} deleted`);
          if (task.parentTaskId) onOpenTask(task.parentTaskId);
          else onOpenTask('');
        }}
      />
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <>
      <dt>
        <Label htmlFor={id} className="font-normal text-muted-foreground">
          {label}
        </Label>
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function LabelsEditor({ task, editable, onChange }: { task: TaskDetail; editable: boolean; onChange: (ids: string[]) => void }) {
  const { canWrite } = useAccess();
  const labels = useLabels();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const selected = new Set(task.labels.map((l) => l.id));
  const create = useMutation({
    mutationFn: (n: string) => api.post<LabelRow>('/planner/labels', { name: n, color: LABEL_COLORS[(labels.data?.length ?? 0) % LABEL_COLORS.length] }),
    onSuccess: (label) => {
      void qc.invalidateQueries({ queryKey: plannerKeys.labels });
      setName('');
      onChange([...selected, label.id]);
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {task.labels.map((l) => (
        <Badge key={l.id} variant="outline" className="gap-1">
          <span className="size-2 rounded-full" style={{ backgroundColor: l.color }} aria-hidden />
          {l.name}
          {editable ? (
            <button type="button" aria-label={`Remove label ${l.name}`} className="ml-0.5 rounded hover:text-destructive" onClick={() => onChange([...selected].filter((id) => id !== l.id))}>
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </Badge>
      ))}
      {editable ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" id="task-labels">
              <Tag /> {task.labels.length ? 'Edit' : 'Add label'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2">
            <div className="max-h-56 overflow-y-auto" role="group" aria-label="Labels">
              {labels.data?.length ? (
                labels.data.map((l) => (
                  <label key={l.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                    <Checkbox checked={selected.has(l.id)} onCheckedChange={(c) => onChange(c === true ? [...selected, l.id] : [...selected].filter((id) => id !== l.id))} />
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: l.color }} aria-hidden />
                    {l.name}
                  </label>
                ))
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No labels yet.</p>
              )}
            </div>
            {canWrite('planner.create') ? (
              <form
                className="mt-2 flex gap-1 border-t pt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) create.mutate(name.trim());
                }}
              >
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" aria-label="New label name" maxLength={40} className="h-8" />
                <Button type="submit" size="icon-sm" aria-label="Create label" disabled={!name.trim()} loading={create.isPending}>
                  <Plus />
                </Button>
              </form>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : task.labels.length === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : null}
    </div>
  );
}

function Subtasks({ task, onOpenTask, editable }: { task: TaskDetail; onOpenTask: (id: string) => void; editable: boolean }) {
  const { canWrite } = useAccess();
  const update = useUpdateTask();
  const qc = useQueryClient();
  const toggle = (s: TaskRow) =>
    update.mutate(
      { task: s, patch: { status: s.status === 'done' ? 'todo' : 'done' } },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: plannerKeys.task(task.id) }) },
    );
  return (
    <section className="mt-6 grid gap-2" aria-labelledby="subtasks-heading">
      <h3 id="subtasks-heading" className="text-sm font-medium">
        Subtasks{' '}
        <span className="font-normal text-muted-foreground">
          {task.subtaskDoneCount}/{task.subtaskCount}
        </span>
      </h3>
      {task.subtasks.length ? (
        <ul className="divide-y rounded-lg border">
          {task.subtasks.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-3 py-2">
              <Checkbox
                checked={s.status === 'done'}
                disabled={!(s.canEdit && canWrite('planner.update'))}
                onCheckedChange={() => toggle(s)}
                aria-label={`Mark ${s.title} ${s.status === 'done' ? 'not done' : 'done'}`}
              />
              <button type="button" className={cn('flex-1 truncate text-left text-sm hover:underline', s.status === 'done' && 'text-muted-foreground line-through')} onClick={() => onOpenTask(s.id)}>
                {s.title}
              </button>
              <span className="font-mono text-[10px] text-muted-foreground">{s.key}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {editable && canWrite('planner.create') ? <QuickAddTask projectId={task.projectId} defaults={{ parentTaskId: task.id }} placeholder="Add a subtask…" /> : null}
    </section>
  );
}

function Attachments({ task, editable }: { task: TaskDetail; editable: boolean }) {
  const qc = useQueryClient();
  const write = useTaskCache();
  const [picking, setPicking] = useState(false);
  const remove = useMutation({
    mutationFn: (fileId: string) => api.delete(`/planner/tasks/${task.id}/attachments/${fileId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: plannerKeys.task(task.id) });
      void qc.invalidateQueries({ queryKey: plannerKeys.tasksAll });
    },
  });
  return (
    <section className="mt-6 grid gap-2" aria-labelledby="attachments-heading">
      <div className="flex items-center justify-between">
        <h3 id="attachments-heading" className="text-sm font-medium">
          Attachments <span className="font-normal text-muted-foreground">{task.attachments.length}</span>
        </h3>
        {editable ? (
          <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
            <Paperclip /> Attach file
          </Button>
        ) : null}
      </div>
      {task.attachments.length ? (
        <ul className="divide-y rounded-lg border">
          {task.attachments.map((a) => (
            <li key={a.fileId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Paperclip className="size-4 text-muted-foreground" aria-hidden />
              <button type="button" className="flex-1 truncate text-left hover:underline" onClick={() => void downloadFile(a.fileId).catch((e: unknown) => toast.error(errorMessage(e)))}>
                {a.name}
              </button>
              <span className="text-xs text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
              {editable ? (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${a.name}`} onClick={() => remove.mutate(a.fileId)} disabled={remove.isPending}>
                  <X />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No attachments.</p>
      )}
      {picking ? (
        <FilePickerDialog
          exclude={task.attachments.map((a) => a.fileId)}
          onClose={() => setPicking(false)}
          onPick={async (file) => {
            try {
              const updated = await api.post<TaskDetail>(`/planner/tasks/${task.id}/attachments`, { fileId: file.id });
              qc.setQueryData(plannerKeys.task(task.id), updated);
              write(updated);
              toast.success(`Attached ${file.name}`);
            } catch (e) {
              toast.error(errorMessage(e));
              throw e;
            }
          }}
        />
      ) : null}
    </section>
  );
}

function Comments({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const comments = useComments(taskId);
  const idem = useIdempotencyKey();
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const setList = (rows: CommentRow[]) => {
    qc.setQueryData(plannerKeys.comments(taskId), rows);
    void qc.invalidateQueries({ queryKey: plannerKeys.activity(taskId) });
    void qc.invalidateQueries({ queryKey: plannerKeys.tasksAll });
  };
  const post = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setPosting(true);
    try {
      const rows = await withIdempotency(idem, { taskId, body: text }, (key) => api.post<CommentRow[]>(`/planner/tasks/${taskId}/comments`, { body: text }, { idempotencyKey: key }));
      setList(rows);
      setBody('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPosting(false);
    }
  };
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/planner/tasks/${taskId}/comments/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: plannerKeys.comments(taskId) }),
  });
  const save = useMutation({
    mutationFn: (c: { id: string; body: string }) => api.patch<CommentRow[]>(`/planner/tasks/${taskId}/comments/${c.id}`, { body: c.body }),
    onSuccess: (rows) => {
      setList(rows);
      setEditing(null);
    },
  });

  return (
    <div className="grid gap-4">
      <form onSubmit={post} className="grid gap-2">
        <Label htmlFor="new-comment" className="sr-only">
          Add a comment
        </Label>
        <Textarea
          id="new-comment"
          rows={3}
          value={body}
          maxLength={10000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment… (Ctrl+Enter to post)"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post(e);
          }}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={posting} disabled={!body.trim()}>
            Comment
          </Button>
        </div>
      </form>
      {comments.isPending ? (
        <Skeleton className="h-16" />
      ) : comments.isError ? (
        <ErrorState error={comments.error} className="py-4" />
      ) : comments.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="grid gap-4">
          {comments.data.map((c) => (
            <li key={c.id} className="flex gap-3">
              <Avatar name={c.author?.name ?? '?'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.author?.name ?? 'Former member'}</span>
                  <time className="text-xs text-muted-foreground" dateTime={c.createdAt} title={formatDateTime(c.createdAt)}>
                    {ago(c.createdAt)}
                  </time>
                  {c.editedAt ? <span className="text-xs text-muted-foreground">(edited)</span> : null}
                  {c.mine && editing?.id !== c.id ? (
                    <span className="ml-auto flex gap-1">
                      <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Edit comment" onClick={() => setEditing({ id: c.id, body: c.body })}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Delete comment" onClick={() => del.mutate(c.id)} disabled={del.isPending}>
                        <Trash className="size-3.5" />
                      </Button>
                    </span>
                  ) : null}
                </div>
                {editing?.id === c.id ? (
                  <div className="mt-1 grid gap-2">
                    <Textarea rows={3} aria-label="Edit comment" value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} autoFocus />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => save.mutate(editing)} loading={save.isPending} disabled={!editing.body.trim()}>
                        <Check /> Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-0.5 text-sm whitespace-pre-wrap">{c.body}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeActivity(a: ActivityRow): string {
  const d = a.data as Record<string, unknown>;
  switch (a.type) {
    case 'created':
      return 'created the task';
    case 'commented':
      return 'commented';
    case 'updated': {
      const changes = (d.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>;
      const status = changes.status?.to as keyof typeof TASK_STATUS_LABELS | undefined;
      const others = Object.keys(changes).filter((k) => k !== 'status');
      const parts = [
        ...(status ? [`moved it to ${TASK_STATUS_LABELS[status] ?? String(status)}`] : []),
        ...(others.length ? [`changed ${others.map((f) => humanize(f.replace(/Id$/, '')).toLowerCase()).join(', ')}`] : []),
      ];
      return parts.length ? parts.join(' and ') : 'updated the task';
    }
    case 'attachment_added':
      return 'attached a file';
    case 'attachment_removed':
      return 'removed an attachment';
    default:
      return humanize(a.type).toLowerCase();
  }
}

function Activity({ taskId }: { taskId: string }) {
  const activity = useActivity(taskId);
  if (activity.isPending) return <Skeleton className="h-16" />;
  if (activity.isError) return <ErrorState error={activity.error} className="py-4" />;
  if (activity.data.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="grid gap-3">
      {activity.data.map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-medium">{a.actor?.name ?? 'System'}</span> {describeActivity(a)}{' '}
            <time className="text-xs text-muted-foreground" dateTime={a.createdAt} title={formatDateTime(a.createdAt)}>
              {ago(a.createdAt)}
            </time>
          </p>
        </li>
      ))}
    </ol>
  );
}

