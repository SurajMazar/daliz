import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public, RawResponse } from '../../common/http/decorators.js';
import { HealthService } from './health.service.js';

/** Unauthenticated probes for orchestrators. They reveal no internal detail. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @RawResponse()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @RawResponse()
  @Get('ready')
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) res: Response) {
    const ok = await this.health.ready();
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'unavailable' };
  }
}
