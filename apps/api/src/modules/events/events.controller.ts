import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { eventInputSchema, eventRangeSchema, occurrenceChangeSchema, reminderInputSchema, rsvpSchema, updateEventSchema } from '@daliz/shared';
import { z } from 'zod';
import { Idempotent, RequirePermissions, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod.js';
import { EventsService } from './events.service.js';
import { RemindersService } from './reminders.service.js';

const reminderUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
  remindAt: z.coerce.date().optional(),
  channel: z.enum(['in_app', 'email', 'both']).optional(),
});

@ApiTags('events')
@TenantScoped()
@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly reminders: RemindersService,
  ) {}

  @RequirePermissions('events.read')
  @Get('events')
  occurrences(@ZQuery(eventRangeSchema) q: z.infer<typeof eventRangeSchema>) {
    return this.events.occurrences(q.from, q.to, q.mine, q.includeCancelled);
  }

  @RequirePermissions('events.read')
  @Get('events/:id')
  get(@IdParam() id: string) {
    return this.events.get(id);
  }

  @RequirePermissions('events.create')
  @Idempotent()
  @Post('events')
  create(@ZBody(eventInputSchema) body: z.infer<typeof eventInputSchema>) {
    return this.events.create(body);
  }

  @RequirePermissions('events.update')
  @Patch('events/:id')
  update(@IdParam() id: string, @ZBody(updateEventSchema) body: z.infer<typeof updateEventSchema>) {
    return this.events.update(id, body);
  }

  @RequirePermissions('events.update')
  @Post('events/:id/occurrences')
  @HttpCode(200)
  occurrence(@IdParam() id: string, @ZBody(occurrenceChangeSchema) body: z.infer<typeof occurrenceChangeSchema>) {
    return this.events.changeOccurrence(id, body);
  }

  @RequirePermissions('events.read')
  @Post('events/:id/rsvp')
  @HttpCode(200)
  rsvp(@IdParam() id: string, @ZBody(rsvpSchema) body: z.infer<typeof rsvpSchema>) {
    return this.events.rsvp(id, body.response);
  }

  @RequirePermissions('events.delete')
  @Delete('events/:id')
  async remove(@IdParam() id: string) {
    await this.events.remove(id);
    return { ok: true };
  }

  // --- Reminders (always the caller's own) ---------------------------------------

  @RequirePermissions('events.read')
  @Get('reminders')
  listReminders() {
    return this.reminders.list();
  }

  @RequirePermissions('events.read')
  @Idempotent()
  @Post('reminders')
  createReminder(@ZBody(reminderInputSchema) body: z.infer<typeof reminderInputSchema>) {
    return this.reminders.create(body);
  }

  @RequirePermissions('events.read')
  @Patch('reminders/:id')
  updateReminder(@IdParam() id: string, @ZBody(reminderUpdateSchema) body: z.infer<typeof reminderUpdateSchema>) {
    return this.reminders.update(id, body);
  }

  @RequirePermissions('events.read')
  @Delete('reminders/:id')
  async dismissReminder(@IdParam() id: string) {
    await this.reminders.dismiss(id);
    return { ok: true };
  }
}
