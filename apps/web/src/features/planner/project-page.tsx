import { CalendarDays, ChartGantt, Kanban, List, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatIsoDate } from '@/lib/dates';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { humanize } from '@/lib/utils';
import { useProject, useProjectTasks, useWorkspaces } from './api';
import { BoardView } from './board-view';
import { CalendarView } from './calendar-view';
import { ListView } from './list-view';
import { TaskDrawer } from './task-drawer';
import { TimelineView } from './timeline-view';
import { ProjectDialog, projectProgress } from './workspace-page';

type View = 'list' | 'board' | 'calendar' | 'timeline';
const VIEWS: View[] = ['list', 'board', 'calendar', 'timeline'];

function readView(projectId: string): View {
  try {
    const v = localStorage.getItem(`daliz.planner.view.${projectId}`);
    return VIEWS.includes(v as View) ? (v as View) : 'board';
  } catch {
    return 'board';
  }
}

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { canWrite } = useAccess();
  const fmt = useTenantFormat();
  const [params, setParams] = useSearchParams();
  const project = useProject(projectId);
  const tasks = useProjectTasks(projectId);
  const workspaces = useWorkspaces();
  const [view, setViewState] = useState<View>(() => readView(projectId));
  const [editing, setEditing] = useState(false);
  useBreadcrumbTail(project.data?.name);

  const taskId = params.get('task');
  const openTask = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('task', id);
    else next.delete('task');
    setParams(next);
  };
  const setView = (v: string) => {
    setViewState(v as View);
    try {
      localStorage.setItem(`daliz.planner.view.${projectId}`, v);
    } catch {
      // Preference lasts for this visit only.
    }
  };

  if (project.isPending) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (project.isError)
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data;
  const { done, total } = projectProgress(p);
  const workspace = workspaces.data?.find((w) => w.id === p.workspaceId);

  return (
    <>
      <PageHeader
        title={p.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-sm"
                style={{ backgroundColor: p.color }}
                aria-hidden
              />
              <span className="font-mono text-xs">{p.key}</span>
            </span>
            {workspace ? (
              <Link to={`/planner/w/${workspace.id}`} className="hover:underline">
                {workspace.name}
              </Link>
            ) : null}
            <Badge variant={p.status === 'active' ? 'info' : 'muted'}>{humanize(p.status)}</Badge>
            {p.startDate || p.dueDate ? (
              <span>
                {formatIsoDate(p.startDate, { dateStyle: 'medium' }, fmt.locale)} →{' '}
                {formatIsoDate(p.dueDate, { dateStyle: 'medium' }, fmt.locale)}
              </span>
            ) : null}
            {p.owner ? <span>Owner: {p.owner.name}</span> : null}
          </span>
        }
        actions={
          <div className="flex items-center gap-3">
            <div className="hidden w-40 sm:block">
              <div className="mb-1 text-xs text-muted-foreground">
                {done}/{total} done
              </div>
              <Progress
                value={done}
                max={Math.max(1, total)}
                label="Project progress"
                tone={total && done === total ? 'success' : 'primary'}
              />
            </div>
            {p.canEdit && canWrite('planner.update') ? (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit project
              </Button>
            ) : null}
          </div>
        }
      />
      {p.description ? (
        <p className="-mt-3 mb-5 max-w-3xl text-sm whitespace-pre-line text-muted-foreground">
          {p.description}
        </p>
      ) : null}

      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label="Project views">
          <TabsTrigger value="list">
            <List /> List
          </TabsTrigger>
          <TabsTrigger value="board">
            <Kanban /> Board
          </TabsTrigger>
          <TabsTrigger value="calendar">
            <CalendarDays /> Calendar
          </TabsTrigger>
          <TabsTrigger value="timeline">
            <ChartGantt /> Timeline
          </TabsTrigger>
        </TabsList>
        {tasks.isPending ? (
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : tasks.isError ? (
          <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
        ) : (
          <>
            <TabsContent value="list">
              <ListView project={p} tasks={tasks.data} onOpen={openTask} />
            </TabsContent>
            <TabsContent value="board">
              <BoardView project={p} tasks={tasks.data} onOpen={openTask} />
            </TabsContent>
            <TabsContent value="calendar">
              <CalendarView project={p} tasks={tasks.data} onOpen={openTask} />
            </TabsContent>
            <TabsContent value="timeline">
              <TimelineView tasks={tasks.data} onOpen={openTask} />
            </TabsContent>
          </>
        )}
      </Tabs>

      <TaskDrawer taskId={taskId} onClose={() => openTask('')} onOpenTask={openTask} />
      {editing ? (
        <ProjectDialog workspaceId={p.workspaceId} project={p} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}
