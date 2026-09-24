import { Injectable, Logger } from '@nestjs/common';
import type { ReminderRow } from '@daliz/shared';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import { RequestContext, type TenantContext } from '../../common/request-context.js';
import { reminders, tasks } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PlannerAccessService } from '../planner/planner-access.js';
import { EventsService } from './events.service.js';
import { ReminderIndex } from './reminder-index.js';

const toRow = (r: typeof reminders.$inferSelect): ReminderRow => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  remindAt: r.remindAt.toISOString(),
  eventId: r.eventId,
  taskId: r.taskId,
  minutesBefore: r.minutesBefore,
  channel: r.channel,
  status: r.status,
  lastSentAt: r.lastSentAt?.toISOString() ?? null,
});

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly index: ReminderIndex,
    private readonly eventsService: EventsService,
    private readonly notifications: NotificationsService,
    private readonly connections: TenantConnectionManager,
    private readonly plannerAccess: PlannerAccessService,
  ) {}

  private me(): { ctx: TenantContext; userId: string } {
    const ctx = RequestContext.tenant();
    if (ctx.actor.type !== 'user') throw Errors.forbidden('Reminders belong to workspace users.');
    return { ctx, userId: ctx.actor.userId };
  }

  async list(): Promise<ReminderRow[]> {
    const { ctx, userId } = this.me();
    const rows = await ctx.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), or(eq(reminders.status, 'scheduled'), and(eq(reminders.status, 'sent'), gt(reminders.lastSentAt, new Date(Date.now() - 7 * 86400_000))))))
      .orderBy(asc(reminders.remindAt))
      .limit(500);
    return rows.map(toRow);
  }

  async create(input: { title: string; notes: string; remindAt?: Date; eventId: string | null; taskId: string | null; minutesBefore: number | null; channel: 'in_app' | 'email' | 'both' }): Promise<ReminderRow> {
    const { ctx, userId } = this.me();
    if (input.eventId) {
      await this.eventsService.get(input.eventId); // visibility check
      if (input.minutesBefore !== null && !input.remindAt) {
        const id = await this.eventsService.createEventReminder(ctx, input.eventId, userId, input.title, input.minutesBefore, input.channel);
        if (!id) throw Errors.badRequest('That event has no upcoming occurrences.');
        const [row] = await ctx.db.update(reminders).set({ notes: input.notes }).where(eq(reminders.id, id)).returning();
        return toRow(row!);
      }
    }
    if (input.taskId) {
      const [task] = await ctx.db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, input.taskId));
      if (!task) throw Errors.notFound();
      await this.plannerAccess.requireProject(ctx, task.projectId, 'view');
    }
    if (!input.remindAt || input.remindAt.getTime() < Date.now() - 60_000) throw Errors.badRequest('Pick a time in the future.');
    const [row] = await ctx.db
      .insert(reminders)
      .values({ userId, title: input.title, notes: input.notes, remindAt: input.remindAt, eventId: input.eventId, taskId: input.taskId, channel: input.channel })
      .returning();
    await this.index.schedule(ctx.tenantId, row!.id, row!.remindAt);
    return toRow(row!);
  }

  async update(id: string, patch: { title?: string; notes?: string; remindAt?: Date; channel?: 'in_app' | 'email' | 'both' }): Promise<ReminderRow> {
    const { ctx, userId } = this.me();
    if (patch.remindAt && patch.remindAt.getTime() < Date.now() - 60_000) throw Errors.badRequest('Pick a time in the future.');
    const [row] = await ctx.db
      .update(reminders)
      .set({ ...patch, ...(patch.remindAt ? { status: 'scheduled' as const } : {}), updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
      .returning();
    if (!row) throw Errors.notFound();
    if (row.status === 'scheduled') await this.index.schedule(ctx.tenantId, id, row.remindAt);
    return toRow(row);
  }

  async dismiss(id: string): Promise<void> {
    const { ctx, userId } = this.me();
    const [row] = await ctx.db
      .update(reminders)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
      .returning({ id: reminders.id });
    if (!row) throw Errors.notFound();
    await this.index.unschedule(ctx.tenantId, id);
  }

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  /** Fires every due reminder. Safe to run concurrently on several workers. */
  async fireDue(now = new Date()): Promise<number> {
    const due = await this.index.claimDue(now);
    let fired = 0;
    for (const { tenantId, reminderId } of due) {
      try {
        if (await this.fire(tenantId, reminderId, now)) fired++;
      } catch (err) {
        // Put it back so the next tick retries.
        await this.index.schedule(tenantId, reminderId, new Date(now.getTime() + 60_000));
        this.logger.error({ tenantId, reminderId, err: (err as Error).message }, 'reminder failed');
      }
    }
    return fired;
  }

  private async fire(tenantId: string, reminderId: string, now: Date): Promise<boolean> {
    const db = await this.connections.get(tenantId);
    const [r] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
    if (!r || r.status !== 'scheduled') return false;
    if (r.remindAt.getTime() > now.getTime() + 1000) {
      await this.index.schedule(tenantId, r.id, r.remindAt); // moved later since indexing
      return false;
    }
    const link = r.eventId ? `/events?event=${r.eventId}` : r.taskId ? `/planner?task=${r.taskId}` : '/events?tab=reminders';
    await this.notifications.notify(tenantId, {
      userIds: [r.userId],
      type: 'reminder.due',
      title: r.title,
      body: r.notes || (r.minutesBefore ? `Starts in ${r.minutesBefore} minutes` : ''),
      link,
      data: { reminderId: r.id, eventId: r.eventId, taskId: r.taskId },
      dedupeKey: `reminder:${r.id}:${r.remindAt.getTime()}`,
      channels: { email: r.channel !== 'in_app' },
    });
    // Recurring event reminders roll forward to the next occurrence instead of being cloned.
    const next = r.eventId && r.minutesBefore !== null ? await this.eventsService.nextReminderTime({ db }, r.eventId, r.minutesBefore, r.remindAt) : null;
    await db
      .update(reminders)
      .set(next ? { remindAt: next, lastSentAt: now, updatedAt: now } : { status: 'sent', lastSentAt: now, updatedAt: now })
      .where(eq(reminders.id, r.id));
    if (next) await this.index.schedule(tenantId, r.id, next);
    return true;
  }

  /** Re-indexes scheduled reminders from the database (recovers from a Redis flush). */
  async reindexTenant(tenantId: string, horizon: Date): Promise<number> {
    const db = await this.connections.get(tenantId);
    const rows = await db
      .select({ id: reminders.id, remindAt: reminders.remindAt })
      .from(reminders)
      .where(and(eq(reminders.status, 'scheduled'), lt(reminders.remindAt, horizon)))
      .orderBy(desc(reminders.remindAt))
      .limit(10_000);
    for (const r of rows) await this.index.schedule(tenantId, r.id, r.remindAt);
    return rows.length;
  }
}
