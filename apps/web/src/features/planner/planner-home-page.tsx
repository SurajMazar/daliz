import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspaceInputSchema, type WorkspaceRow } from '@daliz/shared';
import { Archive, Ellipsis, FolderKanban, Lock, Pencil, Plus, Trash, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, Navigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Controlled } from '@/components/app/controlled';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ColorInput } from '@/components/ui/color-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { plannerKeys, useMembers, usePeople, useTask, useWorkspaces, type MemberRow } from './api';

/** Notification links point at /planner?task=<id>; resolve the project and open the task there. */
function TaskRedirect({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  if (task.isPending) return <Skeleton className="h-40" />;
  if (task.isError) return <ErrorState error={task.error} title="Task not found" />;
  return <Navigate to={`/planner/p/${task.data.projectId}?task=${taskId}`} replace />;
}

export function PlannerHomePage() {
  const [params] = useSearchParams();
  const taskId = params.get('task');
  if (taskId) return <TaskRedirect taskId={taskId} />;
  return <PlannerHome />;
}

function PlannerHome() {
  const { canWrite } = useAccess();
  const workspaces = useWorkspaces();
  const [editing, setEditing] = useState<WorkspaceRow | 'new' | null>(null);
  const [members, setMembers] = useState<WorkspaceRow | null>(null);
  const [archiving, setArchiving] = useState<WorkspaceRow | null>(null);
  const qc = useQueryClient();
  const archive = useMutation({ mutationFn: (id: string) => api.delete(`/planner/workspaces/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: plannerKeys.all }) });

  return (
    <>
      <PageHeader
        title="Planner"
        description="Workspaces group related projects. Private workspaces are visible to their members only."
        actions={
          canWrite('planner.create') ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> New workspace
            </Button>
          ) : null
        }
      />
      {workspaces.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : workspaces.isError ? (
        <Card>
          <ErrorState error={workspaces.error} onRetry={() => void workspaces.refetch()} />
        </Card>
      ) : workspaces.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderKanban}
            title="No workspaces yet"
            description="Create a workspace for a team or an area of work, then add projects to it."
            action={
              canWrite('planner.create') ? (
                <Button size="sm" onClick={() => setEditing('new')}>
                  <Plus /> New workspace
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.data.map((w) => (
            <li key={w.id}>
              <Card className="relative flex h-full flex-col overflow-hidden transition-colors hover:border-primary/40">
                <span className="h-1.5 w-full" style={{ backgroundColor: w.color }} aria-hidden />
                <Link to={`/planner/w/${w.id}`} className="flex flex-1 flex-col gap-2 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                  <div className="flex items-center gap-2 pr-8">
                    <h2 className="truncate font-semibold">{w.name}</h2>
                    {w.visibility === 'private' ? (
                      <Badge variant="outline">
                        <Lock /> Private
                      </Badge>
                    ) : null}
                  </div>
                  {w.description ? <p className="line-clamp-2 text-sm text-muted-foreground">{w.description}</p> : null}
                  <div className="mt-auto flex gap-4 pt-2 text-xs text-muted-foreground">
                    <span>
                      {w.projectCount} project{w.projectCount === 1 ? '' : 's'}
                    </span>
                    <span>{w.openTaskCount} open tasks</span>
                    {w.myRole ? <span className="capitalize">{w.myRole}</span> : null}
                  </div>
                </Link>
                <WorkspaceMenu workspace={w} onEdit={() => setEditing(w)} onMembers={() => setMembers(w)} onArchive={() => setArchiving(w)} />
              </Card>
            </li>
          ))}
        </ul>
      )}
      {editing ? <WorkspaceDialog workspace={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
      {members ? <MembersDialog workspace={members} onClose={() => setMembers(null)} /> : null}
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        destructive
        title={`Archive ${archiving?.name}?`}
        description="The workspace and its projects are hidden from everyone."
        confirmLabel="Archive workspace"
        onConfirm={async () => {
          if (!archiving) return;
          await archive.mutateAsync(archiving.id);
          toast.success('Workspace archived');
        }}
      />
    </>
  );
}

export function WorkspaceMenu({ workspace, onEdit, onMembers, onArchive }: { workspace: WorkspaceRow; onEdit: () => void; onMembers: () => void; onArchive: () => void }) {
  const { canWrite } = useAccess();
  const manage = workspace.myRole === 'owner' || canWrite('planner.delete');
  const items = {
    edit: workspace.canEdit && canWrite('planner.update') && manage,
    members: manage && canWrite('planner.update'),
    archive: canWrite('planner.delete'),
  };
  if (!items.edit && !items.members && !items.archive) return null;
  return (
    <div className="absolute top-4 right-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${workspace.name}`}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {items.edit ? (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Edit workspace
            </DropdownMenuItem>
          ) : null}
          {items.members ? (
            <DropdownMenuItem onSelect={onMembers}>
              <Users /> Members
            </DropdownMenuItem>
          ) : null}
          {items.archive ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onArchive}>
                <Archive /> Archive
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type WsValues = z.input<typeof workspaceInputSchema>;

export function WorkspaceDialog({ workspace, onClose }: { workspace: WorkspaceRow | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<WsValues, unknown, z.output<typeof workspaceInputSchema>>({
    resolver: zodResolver(workspaceInputSchema),
    defaultValues: {
      name: workspace?.name ?? '',
      description: workspace?.description ?? '',
      color: workspace?.color ?? '#2753d7',
      visibility: workspace?.visibility ?? 'workspace',
    },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      if (workspace) await api.patch(`/planner/workspaces/${workspace.id}`, { ...v, version: workspace.version });
      else await api.post('/planner/workspaces', v);
      void qc.invalidateQueries({ queryKey: plannerKeys.workspaces });
      toast.success(workspace ? 'Workspace updated' : 'Workspace created');
      onClose();
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['name', 'description', 'color', 'visibility'], { toastUnmatched: false })) setError(errorMessage(e));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{workspace ? 'Edit workspace' : 'New workspace'}</DialogTitle>
          </DialogHeader>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <FormField label="Name" required error={form.formState.errors.name?.message}>
            <Input autoFocus maxLength={120} {...form.register('name')} />
          </FormField>
          <FormField label="Description" error={form.formState.errors.description?.message}>
            <Textarea rows={2} maxLength={1000} {...form.register('description')} />
          </FormField>
          <FormField label="Color" error={form.formState.errors.color?.message}>
            <Controlled control={form.control} name="color" render={(field, props) => <ColorInput id={props.id as string} label="Workspace color" value={field.value ?? '#2753d7'} onChange={field.onChange} />} />
          </FormField>
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-1">
              <Label htmlFor="ws-private">Private workspace</Label>
              <p className="text-sm text-muted-foreground">Only members you add can see its projects and tasks.</p>
            </div>
            <Controller
              control={form.control}
              name="visibility"
              render={({ field }) => <Switch id="ws-private" checked={field.value === 'private'} onCheckedChange={(c) => field.onChange(c ? 'private' : 'workspace')} />}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {workspace ? 'Save' : 'Create workspace'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MembersDialog({ workspace, onClose }: { workspace: WorkspaceRow; onClose: () => void }) {
  const qc = useQueryClient();
  const members = useMembers(workspace.id);
  const people = usePeople();
  const [draft, setDraft] = useState<MemberRow[] | null>(null);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (members.data && draft === null) setDraft(members.data);
  }, [members.data, draft]);
  const list = draft ?? [];
  const available = (people.data ?? []).filter((p) => !list.some((m) => m.userId === p.id));

  const save = async () => {
    setError(null);
    if (!list.some((m) => m.role === 'owner')) {
      setError('A workspace needs at least one owner.');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/planner/workspaces/${workspace.id}/members`, { members: list.map((m) => ({ userId: m.userId, role: m.role })) });
      void qc.invalidateQueries({ queryKey: plannerKeys.members(workspace.id) });
      void qc.invalidateQueries({ queryKey: plannerKeys.workspaces });
      toast.success('Members updated');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Members of {workspace.name}</DialogTitle>
          <DialogDescription>
            {workspace.visibility === 'private' ? 'Only these people can see this workspace.' : 'Everyone can see this workspace; members get the role you choose.'}
          </DialogDescription>
        </DialogHeader>
        {error ? <Alert variant="destructive" title={error} /> : null}
        <div className="flex gap-2">
          <NativeSelect aria-label="Person to add" value={adding} onChange={(e) => setAdding(e.target.value)} disabled={people.isPending}>
            <option value="">{people.isPending ? 'Loading people…' : 'Add a person…'}</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.email})
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="outline"
            disabled={!adding}
            onClick={() => {
              const p = people.data?.find((x) => x.id === adding);
              if (!p) return;
              setDraft([...list, { userId: p.id, name: p.name, email: p.email, role: 'editor' }]);
              setAdding('');
            }}
          >
            <UserPlus /> Add
          </Button>
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          {members.isPending ? (
            <div className="p-3">
              <Skeleton className="h-10" />
            </div>
          ) : members.isError ? (
            <ErrorState error={members.error} className="py-6" />
          ) : (
            <ul className="divide-y">
              {list.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                  <Avatar name={m.name} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                  </div>
                  <NativeSelect
                    aria-label={`Role for ${m.name}`}
                    className="h-8 w-28 text-xs"
                    value={m.role}
                    onChange={(e) => setDraft(list.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value as MemberRow['role'] } : x)))}
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </NativeSelect>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => setDraft(list.filter((x) => x.userId !== m.userId))}>
                    <Trash />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!draft}>
            Save members
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
