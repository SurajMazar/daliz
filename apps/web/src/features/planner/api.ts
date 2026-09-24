import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  ActivityRow,
  CommentRow,
  LabelRow,
  PlannerSummary,
  ProjectRow,
  TaskDetail,
  TaskRow,
  WorkspaceRow,
} from '@daliz/shared';
import { api, type Query } from '@/lib/api';
import { cachedQuery } from '@/offline/cache';
import { useQueueState } from '@/offline/queue';
import { isOfflineId, overlayComments, overlayTask, overlayTasks } from './offline';

export interface PersonOption {
  id: string;
  name: string;
  email: string;
}

export interface MemberRow {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  name: string;
  email: string;
}

export const plannerKeys = {
  all: ['planner'] as const,
  workspaces: ['planner', 'workspaces'] as const,
  members: (id: string) => ['planner', 'members', id] as const,
  projects: (workspaceId?: string) => ['planner', 'projects', workspaceId ?? 'all'] as const,
  project: (id: string) => ['planner', 'project', id] as const,
  tasks: (q: Query) => ['planner', 'tasks', q] as const,
  tasksAll: ['planner', 'tasks'] as const,
  task: (id: string) => ['planner', 'task', id] as const,
  comments: (id: string) => ['planner', 'comments', id] as const,
  activity: (id: string) => ['planner', 'activity', id] as const,
  people: ['planner', 'people'] as const,
  labels: ['planner', 'labels'] as const,
  summary: ['planner', 'summary'] as const,
};

export function useWorkspaces() {
  return useQuery({
    queryKey: plannerKeys.workspaces,
    queryFn: () =>
      cachedQuery(plannerKeys.workspaces, () => api.get<WorkspaceRow[]>('/planner/workspaces')),
  });
}

export function useMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: plannerKeys.members(workspaceId ?? ''),
    queryFn: () => api.get<MemberRow[]>(`/planner/workspaces/${workspaceId}/members`),
    enabled: !!workspaceId,
  });
}

export function useProjects(workspaceId?: string) {
  return useQuery({
    queryKey: plannerKeys.projects(workspaceId),
    queryFn: () =>
      cachedQuery(plannerKeys.projects(workspaceId), () =>
        api.get<ProjectRow[]>('/planner/projects', workspaceId ? { workspaceId } : undefined),
      ),
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: plannerKeys.project(id),
    queryFn: () =>
      cachedQuery(plannerKeys.project(id), () => api.get<ProjectRow>(`/planner/projects/${id}`)),
  });
}

/** All top-level tasks of a project, in board order. */
export function projectTasksQuery(projectId: string): Query {
  return { projectId, pageSize: 500, sort: 'position' };
}

/** Shows queued offline changes on top of the server data. */
function useOverlay<T>(
  query: UseQueryResult<T>,
  apply: (data: T | undefined) => T | undefined,
): UseQueryResult<T> {
  const data = useMemo(() => apply(query.data), [query.data, apply]);
  return data === query.data ? query : ({ ...query, data } as UseQueryResult<T>);
}

export function useProjectTasks(projectId: string) {
  const q = projectTasksQuery(projectId);
  const { pending } = useQueueState();
  const apply = useMemo(
    () => (rows: TaskRow[] | undefined) => overlayTasks(rows, pending, projectId),
    [pending, projectId],
  );
  return useOverlay(useProjectTasksRaw(q), apply);
}

function useProjectTasksRaw(q: Query) {
  return useQuery({
    queryKey: plannerKeys.tasks(q),
    queryFn: () =>
      cachedQuery(
        plannerKeys.tasks(q),
        async () => (await api.list<TaskRow>('/planner/tasks', q)).items,
      ),
  });
}

export function useTask(id: string | null) {
  const { pending } = useQueueState();
  const apply = useMemo(() => (t: TaskDetail | undefined) => overlayTask(t, pending), [pending]);
  return useOverlay(useTaskRaw(id), apply);
}

function useTaskRaw(id: string | null) {
  return useQuery({
    queryKey: plannerKeys.task(id ?? ''),
    queryFn: () =>
      cachedQuery(plannerKeys.task(id ?? ''), () => api.get<TaskDetail>(`/planner/tasks/${id}`)),
    enabled: !!id && !isOfflineId(id),
  });
}

export function useComments(id: string | null) {
  const { pending } = useQueueState();
  const apply = useMemo(
    () => (rows: CommentRow[] | undefined) => overlayComments(rows, pending, id ?? ''),
    [pending, id],
  );
  return useOverlay(useCommentsRaw(id), apply);
}

function useCommentsRaw(id: string | null) {
  return useQuery({
    queryKey: plannerKeys.comments(id ?? ''),
    queryFn: () =>
      cachedQuery(plannerKeys.comments(id ?? ''), () =>
        api.get<CommentRow[]>(`/planner/tasks/${id}/comments`),
      ),
    enabled: !!id && !isOfflineId(id),
  });
}

export function useActivity(id: string | null) {
  return useQuery({
    queryKey: plannerKeys.activity(id ?? ''),
    queryFn: () => api.get<ActivityRow[]>(`/planner/tasks/${id}/activity`),
    enabled: !!id,
  });
}

export function usePeople(enabled = true) {
  return useQuery({
    queryKey: plannerKeys.people,
    queryFn: () =>
      cachedQuery(plannerKeys.people, () => api.get<PersonOption[]>('/planner/people')),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useLabels() {
  return useQuery({
    queryKey: plannerKeys.labels,
    queryFn: () => cachedQuery(plannerKeys.labels, () => api.get<LabelRow[]>('/planner/labels')),
    staleTime: 5 * 60_000,
  });
}

export function usePlannerSummary(enabled = true) {
  return useQuery({
    queryKey: plannerKeys.summary,
    queryFn: () =>
      cachedQuery(plannerKeys.summary, () => api.get<PlannerSummary>('/planner/summary')),
    enabled,
  });
}
