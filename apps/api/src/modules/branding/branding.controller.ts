import { Controller, Get, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { themeInputSchema, uuidSchema } from '@daliz/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Errors } from '../../common/errors.js';
import { Public, RateLimit, RawResponse, RequirePermissions, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody } from '../../common/http/zod.js';
import { RATE_LIMITS } from '../../infra/redis.js';
import { BrandingService } from './branding.service.js';
import { LOGO_MAX_BYTES } from './logo-processor.js';

const saveBrandingSchema = z.object({
  theme: themeInputSchema,
  logoAssetId: uuidSchema.nullable(),
  loginMessage: z.string().trim().max(280).nullable(),
  version: z.number().int().min(0),
});

const VARIANT_FILE = /^([a-z0-9-]{3,20})\.png$/;

function sendImage(res: Response, obj: { body: NodeJS.ReadableStream; contentType: string; contentLength?: number }, cacheControl: string) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
  obj.body.pipe(res);
}

@ApiTags('branding')
@Controller()
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** Branding for the current host (login page, PWA manifest). No auth, no tenant input. */
  @Public()
  @Get('public/branding')
  publicBranding() {
    return this.branding.publicForHost();
  }

  @Public()
  @RawResponse()
  @Get('public/branding/assets/:tenantId/:assetId/:file')
  async publicAsset(
    @IdParam('tenantId') tenantId: string,
    @IdParam('assetId') assetId: string,
    @Param('file') file: string,
    @Query('s') sig: string | undefined,
    @Res() res: Response,
  ) {
    const m = VARIANT_FILE.exec(file);
    if (!m || typeof sig !== 'string') throw Errors.notFound();
    const obj = await this.branding.publicVariant(tenantId, assetId, m[1]!, sig);
    // Asset ids are immutable (a new upload gets a new id), so long caching is safe.
    sendImage(res, obj, 'public, max-age=31536000, immutable');
  }

  @TenantScoped()
  @Get('branding')
  current() {
    return this.branding.current();
  }

  @RequirePermissions('branding.update')
  @RateLimit(RATE_LIMITS.upload)
  @Post('branding/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 5, parts: 10 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw Errors.badRequest('Attach a logo file.');
    return this.branding.uploadLogo(file.buffer, file.mimetype);
  }

  @RequirePermissions('branding.read')
  @RawResponse()
  @Get('branding/uploads/:assetId/:file')
  async preview(@IdParam('assetId') assetId: string, @Param('file') file: string, @Res() res: Response) {
    const m = VARIANT_FILE.exec(file);
    if (!m) throw Errors.notFound();
    const obj = await this.branding.previewVariant(assetId, m[1]!);
    sendImage(res, obj, 'private, max-age=300');
  }

  @RequirePermissions('branding.update')
  @Put('branding')
  save(@ZBody(saveBrandingSchema) body: z.infer<typeof saveBrandingSchema>) {
    return this.branding.save(body);
  }
}
