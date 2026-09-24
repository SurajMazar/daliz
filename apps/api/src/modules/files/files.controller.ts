import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { copyFileSchema, createFolderSchema, fileQuerySchema, shareSchema, updateFileSchema, updateFolderSchema } from '@daliz/shared';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { Errors } from '../../common/errors.js';
import { RateLimit, RequirePermissions, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod.js';
import { RATE_LIMITS } from '../../infra/redis.js';
import { FilesService } from './files.service.js';

const uploadTargetSchema = z.object({ folderId: z.string().uuid().nullable().default(null) });
const MAX_UPLOAD = loadEnv().FILE_MAX_UPLOAD_MB * 1024 * 1024;

/**
 * File library. Every operation checks the tenant permission (route) *and* the caller's
 * access to the specific folder or file (service), so restricted folders stay private.
 */
@ApiTags('files')
@TenantScoped()
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @RequirePermissions('files.read')
  @Get()
  list(@ZQuery(fileQuerySchema) q: z.infer<typeof fileQuerySchema>) {
    return this.files.contents(q);
  }

  @RequirePermissions('files.read')
  @Get('usage')
  usage() {
    return this.files.usage();
  }

  @RequirePermissions('files.read')
  @Get('share-targets')
  shareTargets() {
    return this.files.shareTargets();
  }

  @RequirePermissions('files.read')
  @Get('trash')
  trash() {
    return this.files.trash();
  }

  // --- Folders ---------------------------------------------------------------------

  @RequirePermissions('files.upload')
  @Post('folders')
  createFolder(@ZBody(createFolderSchema) body: z.infer<typeof createFolderSchema>) {
    return this.files.createFolder(body);
  }

  @RequirePermissions('files.update')
  @Patch('folders/:id')
  updateFolder(@IdParam() id: string, @ZBody(updateFolderSchema) body: z.infer<typeof updateFolderSchema>) {
    return this.files.updateFolder(id, body);
  }

  @RequirePermissions('files.delete')
  @Delete('folders/:id')
  async trashFolder(@IdParam() id: string) {
    await this.files.trashFolder(id);
    return { ok: true };
  }

  @RequirePermissions('files.delete')
  @Post('folders/:id/restore')
  @HttpCode(200)
  async restoreFolder(@IdParam() id: string) {
    await this.files.restore('folder', id);
    return { ok: true };
  }

  @RequirePermissions('files.delete')
  @Delete('folders/:id/purge')
  async purgeFolder(@IdParam() id: string) {
    await this.files.purge('folder', id);
    return { ok: true };
  }

  @RequirePermissions('files.read')
  @Get('folders/:id/shares')
  folderShares(@IdParam() id: string) {
    return this.files.listShares('folder', id);
  }

  @RequirePermissions('files.read')
  @Post('folders/:id/shares')
  shareFolder(@IdParam() id: string, @ZBody(shareSchema) body: z.infer<typeof shareSchema>) {
    return this.files.addShare('folder', id, body);
  }

  @RequirePermissions('files.read')
  @Delete('folders/:id/shares/:shareId')
  async unshareFolder(@IdParam() id: string, @IdParam('shareId') shareId: string) {
    await this.files.removeShare('folder', id, shareId);
    return { ok: true };
  }

  // --- Files -----------------------------------------------------------------------------

  @RequirePermissions('files.upload')
  @RateLimit(RATE_LIMITS.upload)
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5, parts: 10 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, unknown>) {
    if (!file) throw Errors.badRequest('Attach a file.');
    const target = uploadTargetSchema.safeParse({ folderId: body.folderId || null });
    if (!target.success) throw Errors.badRequest('Invalid folder.');
    return this.files.upload(file.buffer, Buffer.from(file.originalname, 'latin1').toString('utf8'), { folderId: target.data.folderId });
  }

  @RequirePermissions('files.read')
  @Get(':id')
  get(@IdParam() id: string) {
    return this.files.getFile(id);
  }

  @RequirePermissions('files.update')
  @Patch(':id')
  update(@IdParam() id: string, @ZBody(updateFileSchema) body: z.infer<typeof updateFileSchema>) {
    return this.files.updateFile(id, body);
  }

  @RequirePermissions('files.upload')
  @Post(':id/copy')
  copy(@IdParam() id: string, @ZBody(copyFileSchema) body: z.infer<typeof copyFileSchema>) {
    return this.files.copyFile(id, body);
  }

  @RequirePermissions('files.update')
  @RateLimit(RATE_LIMITS.upload)
  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5, parts: 10 } }))
  uploadVersion(@IdParam() id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw Errors.badRequest('Attach a file.');
    return this.files.upload(file.buffer, Buffer.from(file.originalname, 'latin1').toString('utf8'), { folderId: null, fileId: id });
  }

  @RequirePermissions('files.read')
  @Get(':id/versions')
  versions(@IdParam() id: string) {
    return this.files.versions(id);
  }

  @RequirePermissions('files.read')
  @Get(':id/download')
  download(@IdParam() id: string, @Query('versionId') versionId?: string) {
    if (versionId !== undefined && !z.string().uuid().safeParse(versionId).success) throw Errors.notFound();
    return this.files.downloadUrl(id, versionId);
  }

  @RequirePermissions('files.read')
  @Get(':id/preview')
  preview(@IdParam() id: string) {
    return this.files.previewUrl(id);
  }

  @RequirePermissions('files.delete')
  @Delete(':id')
  async trashFile(@IdParam() id: string) {
    await this.files.trashFile(id);
    return { ok: true };
  }

  @RequirePermissions('files.delete')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(@IdParam() id: string) {
    await this.files.restore('file', id);
    return { ok: true };
  }

  @RequirePermissions('files.delete')
  @Delete(':id/purge')
  async purge(@IdParam() id: string) {
    await this.files.purge('file', id);
    return { ok: true };
  }

  @RequirePermissions('files.read')
  @Get(':id/shares')
  shares(@IdParam() id: string) {
    return this.files.listShares('file', id);
  }

  @RequirePermissions('files.read')
  @Post(':id/shares')
  share(@IdParam() id: string, @ZBody(shareSchema) body: z.infer<typeof shareSchema>) {
    return this.files.addShare('file', id, body);
  }

  @RequirePermissions('files.read')
  @Delete(':id/shares/:shareId')
  async unshare(@IdParam() id: string, @IdParam('shareId') shareId: string) {
    await this.files.removeShare('file', id, shareId);
    return { ok: true };
  }
}
