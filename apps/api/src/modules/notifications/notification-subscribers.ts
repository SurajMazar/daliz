import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TASK_STATUS_LABELS, type TaskStatus } from '@daliz/shared';
import { and, eq, ne } from 'drizzle-orm';
import { DomainEvents } from '../../common/domain-events.js';
import { rolePermissions, userRoles, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import { RealtimePublisher } from '../../infra/realtime.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Turns domain events into notifications and real-time invalidations. Runs after the change
 * committed; failures here never undo the business operation (they're logged by the bus).
 */
@Injectable()
export class NotificationSubscribers implements OnModuleInit {
  constructor(
    private readonly events: DomainEvents,
    private readonly notifications: NotificationsService,
    private readonly connections: TenantConnectionManager,
    private readonly realtime: RealtimePublisher,
  ) {}

  private async actorName(tenantId: string, actorId: string | null): Promise<string> {
    if (!actorId) return 'Someone';
    const db = await this.connections.get(tenantId);
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
    return u?.name ?? 'Someone';
  }

  /** "Thu, Oct 1, 2026, 7:00 AM EDT" in the event's own time zone (date only for all-day events). */
  private when(e: { startsAt: string; timezone: string; allDay: boolean }): string {
    const date = new Date(e.startsAt);
    const opts: Intl.DateTimeFormatOptions = e.allDay
      ? { timeZone: e.timezone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
      : { timeZone: e.timezone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    try {
      return new Intl.DateTimeFormat('en-US', opts).format(date);
    } catch {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(date);
    }
  }

  onModuleInit(): void {
    this.events.on('task.assigned', async (e) => {
      const who = await this.actorName(e.tenantId, e.actorId);
      await this.notifications.notify(e.tenantId, { userIds: [e.assigneeId], type: 'task.assigned', title: `${who} assigned ${e.taskKey} to you`, body: e.title, link: `/planner?task=${e.taskId}`, data: { taskId: e.taskId } });
    });
    this.events.on('task.status_changed', async (e) => {
      const who = await this.actorName(e.tenantId, e.actorId);
      await this.notifications.notify(e.tenantId, {
        userIds: e.watcherIds,
        type: 'task.status_changed',
        title: `${who} moved ${e.taskKey} to ${TASK_STATUS_LABELS[e.to as TaskStatus] ?? e.to}`,
        body: e.title,
        link: `/planner?task=${e.taskId}`,
        data: { taskId: e.taskId, from: e.from, to: e.to },
      });
    });
    this.events.on('task.commented', async (e) => {
      const who = await this.actorName(e.tenantId, e.actorId);
      await this.notifications.notify(e.tenantId, { userIds: e.watcherIds, type: 'task.commented', title: `${who} commented on ${e.taskKey}`, body: e.title, link: `/planner?task=${e.taskId}`, data: { taskId: e.taskId, commentId: e.commentId } });
    });
    this.events.on('event.invited', async (e) => {
      const who = await this.actorName(e.tenantId, e.actorId);
      await this.notifications.notify(e.tenantId, { userIds: e.attendeeIds, type: 'event.invited', title: `${who} invited you to “${e.title}”`, body: this.when(e), link: `/events?event=${e.eventId}`, data: { eventId: e.eventId } });
    });
    this.events.on('event.updated', async (e) => {
      await this.notifications.notify(e.tenantId, { userIds: e.attendeeIds, type: 'event.updated', title: `“${e.title}” was updated`, body: this.when(e), link: `/events?event=${e.eventId}`, data: { eventId: e.eventId } });
    });
    this.events.on('event.cancelled', async (e) => {
      await this.notifications.notify(e.tenantId, { userIds: e.attendeeIds, type: 'event.cancelled', title: `“${e.title}” was cancelled`, body: this.when(e), link: `/events?event=${e.eventId}`, data: { eventId: e.eventId } });
    });
    this.events.on('accounting.entry_submitted', async (e) => {
      const db = await this.connections.get(e.tenantId);
      const approvers = await db
        .selectDistinct({ id: users.id })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
        .where(and(eq(rolePermissions.permissionKey, 'accounting.approve'), eq(users.status, 'active'), e.actorId ? ne(users.id, e.actorId) : undefined));
      const who = await this.actorName(e.tenantId, e.actorId);
      // Amounts are deliberately left out of notification text.
      await this.notifications.notify(e.tenantId, { userIds: approvers.map((a) => a.id), type: 'accounting.entry_submitted', title: `${who} submitted a journal entry for approval`, body: e.description, link: `/accounting/journal/${e.entryId}`, data: { entryId: e.entryId } });
    });
    this.events.on('realtime.invalidate', async (e) => {
      await this.realtime.publish({ tenantId: e.tenantId, userIds: e.userIds, message: { type: 'invalidate', topics: e.topics } });
    });
  }
}
