import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { PROJECT_STATUSES, projectInputSchema, type ProjectRow } from '@daliz/shared';
import { ArrowLeft, CalendarRange, FolderKanban, Lock, Pencil, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Controlled } from '@/components/app/controlled';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ColorInput } from '@/components/ui/color-input';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatIsoDate } from '@/lib/dates';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { humanize } from '@/lib/utils';
import { plannerKeys, usePeople, useProjects, useWorkspaces } from './api';
import { MembersDialog, WorkspaceDialog } from './planner-home-page';

export function projectProgress(p: ProjectRow): { done: number; total: number } {
  const c = p.taskCounts;
  const total = c.todo + c.in_progress + c.in_review + c.done;
  return { done: c.done, total };
}

export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const { canWrite } = useAccess();
  const fmt = useTenantFormat();
  const workspaces = useWorkspaces();
  const projects = useProjects(workspaceId);
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  useBreadcrumbTail(workspace?.name);
  const [creating, setCreating] = useState(false);
  const [editingWs, setEditingWs] = useState(false);
  const [members, setMembers] = useState(false);

  if (workspaces.isPending) return <Skeleton className="h-64" />;
  if (workspaces.isError) return <ErrorState error={workspaces.error} onRetry={() => void workspaces.refetch()} />;
  if (!workspace) return <ErrorState error={new Error('This workspace doesn’t exist or you don’t have access to it.')} title="Workspace not found" />;
  const manage = workspace.myRole === 'owner' || canWrite('planner.delete');

  return (
    <>
      <PageHeader
        title={workspace.name}
        description={workspace.description || undefined}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/planner">
                <ArrowLeft /> Workspaces
              </Link>
            </Button>
            {manage && canWrite('planner.update') ? (
              <>
                <Button variant="outline" onClick={() => setMembers(true)}>
                  <Users /> Members
                </Button>
                <Button variant="outline" onClick={() => setEditingWs(true)}>
                  <Pencil /> Edit
                </Button>
              </>
            ) : null}
            {workspace.canEdit && canWrite('planner.create') ? (
              <Button onClick={() => setCreating(true)}>
                <Plus /> New project
              </Button>
            ) : null}
          </>
        }
      />
      {workspace.visibility === 'private' ? (
        <Badge variant="outline" className="-mt-3 mb-5">
          <Lock /> Private workspace
        </Badge>
      ) : null}
      {projects.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : projects.isError ? (
        <Card>
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        </Card>
      ) : projects.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            action={
              workspace.canEdit && canWrite('planner.create') ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus /> New project
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data.map((p) => {
            const { done, total } = projectProgress(p);
            return (
              <li key={p.id}>
                <Link to={`/planner/p/${p.id}`} className="block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Card className="flex h-full flex-col gap-3 p-5 transition-colors hover:border-primary/40">
                    <div className="flex items-center gap-2">
                      <span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: p.color }} aria-hidden />
                      <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
                      <Badge variant={p.status === 'active' ? 'info' : p.status === 'completed' ? 'success' : 'muted'} className="ml-auto">
                        {humanize(p.status)}
                      </Badge>
                    </div>
                    <h2 className="font-semibold">{p.name}</h2>
                    {p.description ? <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p> : null}
                    <div className="mt-auto grid gap-1.5">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {done}/{total} done
                        </span>
                        {p.dueDate ? (
                          <span className="inline-flex items-center gap-1">
                            <CalendarRange className="size-3" aria-hidden /> {formatIsoDate(p.dueDate, { dateStyle: 'medium' }, fmt.locale)}
                          </span>
                        ) : null}
                      </div>
                      <Progress value={done} max={Math.max(total, 1)} label={`${p.name} progress`} tone={total && done === total ? 'success' : 'primary'} />
                      {p.owner ? <div className="text-xs text-muted-foreground">Owner: {p.owner.name}</div> : null}
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {creating ? <ProjectDialog workspaceId={workspace.id} onClose={() => setCreating(false)} /> : null}
      {editingWs ? <WorkspaceDialog workspace={workspace} onClose={() => setEditingWs(false)} /> : null}
      {members ? <MembersDialog workspace={workspace} onClose={() => setMembers(false)} /> : null}
    </>
  );
}

const projectFormSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.enum(PROJECT_STATUSES),
    ownerId: z.string().nullable(),
    startDate: z.string(),
    dueDate: z.string(),
    color: z.string(),
  })
  .superRefine((v, ctx) => {
    // Validate with the shared schema; empty dates mean "none".
    const parsed = projectInputSchema.safeParse({ ...v, workspaceId: '00000000-0000-4000-8000-000000000000', startDate: v.startDate || null, dueDate: v.dueDate || null });
    if (!parsed.success) for (const i of parsed.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
  });
type ProjectValues = z.infer<typeof projectFormSchema>;

export function ProjectDialog({ workspaceId, project, onClose }: { workspaceId: string; project?: ProjectRow; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const people = usePeople();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ProjectValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      key: project?.key ?? '',
      name: project?.name ?? '',
      description: project?.description ?? '',
      status: project?.status ?? 'active',
      ownerId: project?.owner?.id ?? null,
      startDate: project?.startDate ?? '',
      dueDate: project?.dueDate ?? '',
      color: project?.color ?? '#2753d7',
    },
  });
  const nameField = form.register('name');
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const common = { name: v.name.trim(), description: v.description, status: v.status, ownerId: v.ownerId, startDate: v.startDate || null, dueDate: v.dueDate || null, color: v.color };
    try {
      if (project) {
        const saved = await api.patch<ProjectRow>(`/planner/projects/${project.id}`, { ...common, version: project.version });
        qc.setQueryData(plannerKeys.project(project.id), saved);
      } else {
        const created = await api.post<ProjectRow>('/planner/projects', { ...common, workspaceId, key: v.key.trim().toUpperCase() });
        navigate(`/planner/p/${created.id}`);
      }
      void qc.invalidateQueries({ queryKey: plannerKeys.all });
      toast.success(project ? 'Project updated' : 'Project created');
      onClose();
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['key', 'name', 'description', 'status', 'ownerId', 'startDate', 'dueDate', 'color'], { toastUnmatched: false })) setError(errorMessage(e));
    }
  });
  const peopleOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name, keywords: p.email }));
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent className="max-w-xl">
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{project ? 'Edit project' : 'New project'}</DialogTitle>
          </DialogHeader>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
            <FormField label="Name" required error={e.name?.message}>
              <Input
                autoFocus
                maxLength={120}
                {...nameField}
                onChange={(ev) => {
                  void nameField.onChange(ev);
                  if (!project && !form.formState.dirtyFields.key) {
                    const key = ev.target.value
                      .replace(/[^A-Za-z0-9 ]/g, '')
                      .split(/\s+/)
                      .filter(Boolean)
                      .map((w) => w[0])
                      .join('')
                      .toUpperCase()
                      .slice(0, 5);
                    form.setValue('key', key.length >= 2 ? key : ev.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase());
                  }
                }}
              />
            </FormField>
            <FormField label="Key" required hint={project ? 'Keys can’t change.' : 'Prefix for task numbers.'} error={e.key?.message}>
              <Input className="font-mono uppercase" maxLength={10} disabled={!!project} {...form.register('key')} />
            </FormField>
          </div>
          <FormField label="Description" error={e.description?.message}>
            <Textarea rows={3} maxLength={5000} {...form.register('description')} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Status" error={e.status?.message}>
              <NativeSelect {...form.register('status')}>
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Owner" error={e.ownerId?.message}>
              <Controlled control={form.control} name="ownerId" render={(field, props) => <Combobox {...props} options={peopleOptions} value={field.value} onChange={field.onChange} placeholder="No owner" allowClear searchPlaceholder="Search people…" />} />
            </FormField>
            <FormField label="Start date" error={e.startDate?.message}>
              <Input type="date" {...form.register('startDate')} />
            </FormField>
            <FormField label="Due date" error={e.dueDate?.message}>
              <Input type="date" {...form.register('dueDate')} />
            </FormField>
          </div>
          <FormField label="Color" error={e.color?.message}>
            <Controlled control={form.control} name="color" render={(field, props) => <ColorInput id={props.id as string} label="Project color" value={field.value} onChange={field.onChange} />} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {project ? 'Save project' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
