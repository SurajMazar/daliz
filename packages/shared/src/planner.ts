/**
 * Planner / workspace contract.
 */
import { z } from 'zod';
import { isoDateSchema } from './accounting.js';
import { hexColorSchema } from './theme.js';

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const name = z.string().trim().min(1, 'Required').max(120);

export const workspaceInputSchema = z.object({
  name,
  description: z.string().trim().max(1000).default(''),
  color: hexColorSchema.default('#2753d7'),
  visibility: z.enum(['workspace', 'private']).default('workspace'),
});
export const updateWorkspaceSchema = workspaceInputSchema.partial().extend({ version: z.number().int().min(1) });

export const workspaceMembersSchema = z.object({
  members: z
    .array(z.object({ userId: z.string().uuid(), role: z.enum(['owner', 'editor', 'viewer']) }))
    .min(1)
    .max(500),
});

export const projectInputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    key: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/, '2–10 letters or digits, starting with a letter'),
    name,
    description: z.string().trim().max(5000).default(''),
    status: z.enum(PROJECT_STATUSES).default('active'),
    ownerId: z.string().uuid().nullable().default(null),
    startDate: isoDateSchema.nullable().default(null),
    dueDate: isoDateSchema.nullable().default(null),
    color: hexColorSchema.default('#2753d7'),
  })
  .refine((p) => !p.startDate || !p.dueDate || p.startDate <= p.dueDate, { message: 'Due date must be after the start date', path: ['dueDate'] });

export const updateProjectSchema = z.object({
  name: name.optional(),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  color: hexColorSchema.optional(),
  version: z.number().int().min(1),
});

export const taskInputSchema = z
  .object({
    projectId: z.string().uuid(),
    parentTaskId: z.string().uuid().nullable().default(null),
    title: z.string().trim().min(1, 'Required').max(300),
    description: z.string().max(20_000).default(''),
    status: z.enum(TASK_STATUSES).default('todo'),
    priority: z.enum(TASK_PRIORITIES).default('none'),
    assigneeId: z.string().uuid().nullable().default(null),
    startDate: isoDateSchema.nullable().default(null),
    dueDate: isoDateSchema.nullable().default(null),
    estimateMinutes: z.number().int().min(0).max(100_000).nullable().default(null),
    labelIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .refine((t) => !t.startDate || !t.dueDate || t.startDate <= t.dueDate, { message: 'Due date must be after the start date', path: ['dueDate'] });
export type TaskInput = z.infer<typeof taskInputSchema>;

export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  estimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  labelIds: z.array(z.string().uuid()).max(20).optional(),
  version: z.number().int().min(1),
});

/** Board drag and drop: new column and the neighbours it was dropped between. */
export const moveTaskSchema = z.object({
  status: z.enum(TASK_STATUSES),
  afterTaskId: z.string().uuid().nullable().default(null),
  beforeTaskId: z.string().uuid().nullable().default(null),
  version: z.number().int().min(1),
});

export const taskQuerySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  status: z
    .union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labelId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  dueFrom: isoDateSchema.optional(),
  dueTo: isoDateSchema.optional(),
  includeSubtasks: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  includeDone: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  sort: z.enum(['position', 'due', 'priority', 'updated', 'created']).default('position'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const commentInputSchema = z.object({ body: z.string().trim().min(1, 'Write something').max(10_000) });
export const attachmentInputSchema = z.object({ fileId: z.string().uuid() });
export const labelInputSchema = z.object({ name: z.string().trim().min(1).max(40), color: hexColorSchema });

export interface PersonRef {
  id: string;
  name: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  description: string;
  color: string;
  visibility: 'workspace' | 'private';
  myRole: 'owner' | 'editor' | 'viewer' | null;
  canEdit: boolean;
  projectCount: number;
  openTaskCount: number;
  createdAt: string;
  version: number;
}

export interface ProjectRow {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  owner: PersonRef | null;
  startDate: string | null;
  dueDate: string | null;
  color: string;
  taskCounts: Record<TaskStatus, number>;
  canEdit: boolean;
  createdAt: string;
  version: number;
}

export interface LabelRow {
  id: string;
  name: string;
  color: string;
}

export interface TaskRow {
  id: string;
  key: string;
  projectId: string;
  projectName: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: PersonRef | null;
  reporter: PersonRef | null;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  position: string;
  labels: LabelRow[];
  subtaskCount: number;
  subtaskDoneCount: number;
  commentCount: number;
  attachmentCount: number;
  completedAt: string | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TaskDetail extends TaskRow {
  subtasks: TaskRow[];
  attachments: { fileId: string; name: string; extension: string; sizeBytes: number; addedAt: string }[];
}

export interface CommentRow {
  id: string;
  author: PersonRef | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}

export interface ActivityRow {
  id: string;
  actor: PersonRef | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface PlannerSummary {
  assignedToMe: number;
  dueToday: number;
  overdue: number;
  dueThisWeek: number;
  upcoming: TaskRow[];
}
