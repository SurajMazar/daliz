import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { API_KEY_SCOPES, apiKeyCreateSchema } from '@daliz/shared';
import { z } from 'zod';
import { RequirePermissions, RequireStepUp, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody } from '../../common/http/zod.js';
import { ApiKeysService } from './api-keys.service.js';

/** Managed by workspace administrators. Creating or rotating a key needs a fresh step-up. */
@ApiTags('integrations')
@TenantScoped()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @RequirePermissions('settings.update')
  @Get()
  list() {
    return this.keys.list();
  }

  @RequirePermissions('settings.update')
  @Get('scopes')
  scopes() {
    return API_KEY_SCOPES;
  }

  @RequirePermissions('settings.update')
  @RequireStepUp()
  @Post()
  create(@ZBody(apiKeyCreateSchema) body: z.infer<typeof apiKeyCreateSchema>) {
    return this.keys.create(body);
  }

  @RequirePermissions('settings.update')
  @RequireStepUp()
  @Post(':id/rotate')
  @HttpCode(200)
  rotate(@IdParam() id: string) {
    return this.keys.rotate(id);
  }

  @RequirePermissions('settings.update')
  @Post(':id/revoke')
  @HttpCode(200)
  async revoke(@IdParam() id: string) {
    await this.keys.revoke(id);
    return { ok: true };
  }
}
