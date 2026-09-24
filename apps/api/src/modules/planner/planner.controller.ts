import { Controller, Delete, Get, HttpCode, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  attachmentInputSchema,
  commentInputSchema,
  labelInputSchema,
  moveTaskSchema,
  projectInputSchema,
  taskInputSchema,
  taskQuerySchema,
  updateProjectSchema,
  updateTaskSchema,
  updateWorkspaceSchema,
  workspaceInputSchema,
  workspaceMembersSchema,
} from '@daliz/shared';
import { z } from 'zod';
import { Errors } from '../../common/errors.js';
import { Idempotent, RequirePermissions, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod.js';
import { TenantSettingsService } from '../tenant-admin/settings.service.js';
import { PlannerService } from './planner.service.js';
import { TasksService } from './tasks.service.js';

@ApiTags('planner')
@TenantScoped()
@Controller('planner')
export class PlannerController {
  constructor(
    private readonly planner: PlannerService,
    private readonly tasks: TasksService,
    private readonly settings: TenantSettingsService,
  ) {}

  // --- Workspaces ---------------------------------------------------------------

  @RequirePermissions('planner.read')
  @Get('workspaces')
  workspaces() {
    return this.planner.listWorkspaces();
  }

  @RequirePermissions('planner.create')
  @Post('workspaces')
  createWorkspace(@ZBody(workspaceInputSchema) body: z.infer<typeof workspaceInputSchema>) {
    return this.planner.createWorkspace(body);
  }

  @RequirePermissions('planner.update')
  @Patch('workspaces/:id')
  async updateWorkspace(@IdParam() id: string, @ZBody(updateWorkspaceSchema) body: z.infer<typeof updateWorkspaceSchema>) {
    await this.planner.updateWorkspace(id, body);
    return { ok: true };
  }

  @RequirePermissions('planner.delete')
  @Delete('workspaces/:id')
  async archiveWorkspace(@IdParam() id: string) {
    await this.planner.archiveWorkspace(id);
    return { ok: true };
  }

  @RequirePermissions('planner.read')
  @Get('workspaces/:id/members')
  members(@IdParam() id: string) {
    return this.planner.members(id);
  }

  @RequirePermissions('planner.update')
  @Put('workspaces/:id/members')
  async setMembers(@IdParam() id: string, @ZBody(workspaceMembersSchema) body: z.infer<typeof workspaceMembersSchema>) {
    await this.planner.setMembers(id, body.members);
    return { ok: true };
  }

  // --- Projects ----------------------------------------------------------------------

  @RequirePermissions('planner.read')
  @Get('projects')
  projects(@Query('workspaceId') workspaceId?: string) {
    if (workspaceId !== undefined && !z.string().uuid().safeParse(workspaceId).success) throw Errors.notFound();
    return this.planner.listProjects(workspaceId);
  }

  @RequirePermissions('planner.read')
  @Get('projects/:id')
  project(@IdParam() id: string) {
    return this.planner.getProject(id);
  }

  @RequirePermissions('planner.create')
  @Post('projects')
  createProject(@ZBody(projectInputSchema) body: z.infer<typeof projectInputSchema>) {
    return this.planner.createProject(body);
  }

  @RequirePermissions('planner.update')
  @Patch('projects/:id')
  updateProject(@IdParam() id: string, @ZBody(updateProjectSchema) body: z.infer<typeof updateProjectSchema>) {
    return this.planner.updateProject(id, body);
  }

  // --- Tasks -----------------------------------------------------------------------------

  @RequirePermissions('planner.read')
  @Get('tasks')
  list(@ZQuery(taskQuerySchema) q: z.infer<typeof taskQuerySchema>) {
    return this.tasks.list(q);
  }

  @RequirePermissions('planner.read')
  @Get('summary')
  async summary() {
    const general = await this.settings.general();
    return this.tasks.summary(general.timezone);
  }

  @RequirePermissions('planner.read')
  @Get('tasks/:id')
  get(@IdParam() id: string) {
    return this.tasks.get(id);
  }

  /** Offline clients send their operation id as the Idempotency-Key when syncing. */
  @RequirePermissions('planner.create')
  @Idempotent()
  @Post('tasks')
  create(@ZBody(taskInputSchema) body: z.infer<typeof taskInputSchema>) {
    return this.tasks.create(body);
  }

  @RequirePermissions('planner.update')
  @Patch('tasks/:id')
  update(@IdParam() id: string, @ZBody(updateTaskSchema) body: z.infer<typeof updateTaskSchema>) {
    return this.tasks.update(id, body);
  }

  @RequirePermissions('planner.update')
  @Post('tasks/:id/move')
  @HttpCode(200)
  move(@IdParam() id: string, @ZBody(moveTaskSchema) body: z.infer<typeof moveTaskSchema>) {
    return this.tasks.move(id, body);
  }

  @RequirePermissions('planner.delete')
  @Delete('tasks/:id')
  async remove(@IdParam() id: string) {
    await this.tasks.remove(id);
    return { ok: true };
  }

  @RequirePermissions('planner.read')
  @Get('tasks/:id/comments')
  comments(@IdParam() id: string) {
    return this.tasks.comments(id);
  }

  @RequirePermissions('planner.read')
  @Idempotent()
  @Post('tasks/:id/comments')
  addComment(@IdParam() id: string, @ZBody(commentInputSchema) body: z.infer<typeof commentInputSchema>) {
    return this.tasks.addComment(id, body.body);
  }

  @RequirePermissions('planner.read')
  @Patch('tasks/:id/comments/:commentId')
  editComment(@IdParam() id: string, @IdParam('commentId') commentId: string, @ZBody(commentInputSchema) body: z.infer<typeof commentInputSchema>) {
    return this.tasks.editComment(id, commentId, body.body);
  }

  @RequirePermissions('planner.read')
  @Delete('tasks/:id/comments/:commentId')
  async deleteComment(@IdParam() id: string, @IdParam('commentId') commentId: string) {
    await this.tasks.deleteComment(id, commentId);
    return { ok: true };
  }

  @RequirePermissions('planner.update', 'files.read')
  @Post('tasks/:id/attachments')
  addAttachment(@IdParam() id: string, @ZBody(attachmentInputSchema) body: z.infer<typeof attachmentInputSchema>) {
    return this.tasks.addAttachment(id, body.fileId);
  }

  @RequirePermissions('planner.update')
  @Delete('tasks/:id/attachments/:fileId')
  async removeAttachment(@IdParam() id: string, @IdParam('fileId') fileId: string) {
    await this.tasks.removeAttachment(id, fileId);
    return { ok: true };
  }

  @RequirePermissions('planner.read')
  @Get('tasks/:id/activity')
  activity(@IdParam() id: string) {
    return this.tasks.activityLog(id);
  }

  @RequirePermissions('planner.read')
  @Get('people')
  people() {
    return this.planner.people();
  }

  // --- Labels -------------------------------------------------------------------------------

  @RequirePermissions('planner.read')
  @Get('labels')
  labels() {
    return this.planner.listLabels();
  }

  @RequirePermissions('planner.create')
  @Post('labels')
  createLabel(@ZBody(labelInputSchema) body: z.infer<typeof labelInputSchema>) {
    return this.planner.createLabel(body);
  }

  @RequirePermissions('planner.delete')
  @Delete('labels/:id')
  async deleteLabel(@IdParam() id: string) {
    await this.planner.deleteLabel(id);
    return { ok: true };
  }
}
