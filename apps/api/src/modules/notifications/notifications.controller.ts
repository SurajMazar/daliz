import { Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { notificationPreferencesSchema, paginationQuerySchema, pushSubscriptionSchema } from '@daliz/shared';
import { z } from 'zod';
import { TenantScoped } from '../../common/http/decorators.js';
import { ZBody, ZQuery } from '../../common/http/zod.js';
import { NotificationsService } from './notifications.service.js';

const listQuery = paginationQuerySchema.extend({ unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
const markReadSchema = z.object({ ids: z.union([z.literal('all'), z.array(z.string().uuid()).min(1).max(500)]) });
const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });

/** The caller's own notification centre. Every member of a workspace has one. */
@ApiTags('notifications')
@TenantScoped()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@ZQuery(listQuery) q: z.infer<typeof listQuery>) {
    return this.notifications.list(q);
  }

  @Get('unread-count')
  unread() {
    return this.notifications.unreadCount();
  }

  @Post('read')
  @HttpCode(200)
  markRead(@ZBody(markReadSchema) body: z.infer<typeof markReadSchema>) {
    return this.notifications.markRead(body.ids);
  }

  @Get('preferences')
  preferences() {
    return this.notifications.preferences();
  }

  @Put('preferences')
  setPreferences(@ZBody(notificationPreferencesSchema) body: z.infer<typeof notificationPreferencesSchema>) {
    return this.notifications.setPreferences(body.preferences);
  }

  @Get('push')
  pushConfig() {
    return this.notifications.pushConfig();
  }

  @Post('push/subscribe')
  @HttpCode(200)
  async subscribe(@ZBody(pushSubscriptionSchema) body: z.infer<typeof pushSubscriptionSchema>) {
    await this.notifications.subscribePush(body);
    return { ok: true };
  }

  @Post('push/unsubscribe')
  @HttpCode(200)
  async unsubscribe(@ZBody(unsubscribeSchema) body: z.infer<typeof unsubscribeSchema>) {
    await this.notifications.unsubscribePush(body.endpoint);
    return { ok: true };
  }
}
