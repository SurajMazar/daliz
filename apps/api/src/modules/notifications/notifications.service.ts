import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
  type NotificationPreferenceRow,
  type NotificationRow,
  type NotificationType,
  type Paginated,
} from '@daliz/shared';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import webpush from 'web-push';
import { ENV, type Env } from '../../config/env.js';
import { Errors } from '../../common/errors.js';
import { RequestContext } from '../../common/request-context.js';
import { notificationDeliveries, notificationPreferences, notifications, pushSubscriptions, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { QueueService } from '../../infra/queue.js';
import { RealtimePublisher } from '../../infra/realtime.js';

export interface NotifyInput {
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string;
  /** In-app route only (must start with "/"). */
  link?: string | null;
  data?: Record<string, unknown>;
  /** Prevents duplicates when the same event is processed twice. */
  dedupeKey?: string;
  /** Override channels (e.g. a reminder's own channel choice). */
  channels?: { email?: boolean };
}

const toRow = (n: typeof notifications.$inferSelect): NotificationRow => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  link: n.link,
  data: n.data,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

/**
 * Central notification system. Every notification is stored (history), then delivered per
 * the user's preferences: live over WebSocket (in-app), by email and by web push, each
 * through queued, retried, tracked deliveries.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  readonly pushEnabled: boolean;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly connections: TenantConnectionManager,
    private readonly queue: QueueService,
    private readonly realtime: RealtimePublisher,
  ) {
    this.pushEnabled = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    if (this.pushEnabled) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  }

  async notify(tenantId: string, input: NotifyInput): Promise<number> {
    if (input.link && !input.link.startsWith('/')) throw new Error('Notification links must be in-app routes');
    const ids = [...new Set(input.userIds)];
    if (!ids.length) return 0;
    const db = await this.connections.get(tenantId);
    const recipients = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, 'active')));
    const prefs = await db
      .select()
      .from(notificationPreferences)
      .where(and(inArray(notificationPreferences.userId, ids), eq(notificationPreferences.type, input.type)));
    let created = 0;
    for (const r of recipients) {
      const p = prefs.find((x) => x.userId === r.id) ?? NOTIFICATION_DEFAULTS[input.type];
      const email = input.channels?.email ?? p.email;
      if (!p.inApp && !email && !p.push) continue;
      const [n] = await db
        .insert(notifications)
        .values({
          userId: r.id,
          type: input.type,
          title: input.title.slice(0, 300),
          body: (input.body ?? '').slice(0, 1000),
          link: input.link ?? null,
          data: input.data ?? {},
          dedupeKey: input.dedupeKey ?? null,
          // Muted in-app notifications are kept for history but don't count as unread.
          readAt: p.inApp ? null : new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!n) continue;
      created++;
      if (p.inApp) {
        await this.realtime.publish({ tenantId, userIds: [r.id], message: { type: 'notification', notification: toRow(n), unread: await this.unread(db, r.id) } });
      }
      if (email) {
        const [d] = await db.insert(notificationDeliveries).values({ notificationId: n.id, channel: 'email' }).returning({ id: notificationDeliveries.id });
        await this.queue.enqueueNotificationDelivery({ tenantId, deliveryId: d!.id });
      }
      if (p.push && this.pushEnabled) {
        const subs = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, r.id));
        if (subs.length) {
          const [d] = await db.insert(notificationDeliveries).values({ notificationId: n.id, channel: 'push' }).returning({ id: notificationDeliveries.id });
          await this.queue.enqueueNotificationDelivery({ tenantId, deliveryId: d!.id });
        }
      }
    }
    return created;
  }

  private async unread(db: TenantDb, userId: string): Promise<number> {
    const [n] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Number(n?.n ?? 0);
  }

  // -------------------------------------------------------------------------
  // Worker: deliveries
  // -------------------------------------------------------------------------

  /** Sends one queued email/push delivery. Throws to let the queue retry. */
  async deliver(tenantId: string, deliveryId: string, finalAttempt: boolean, sendEmail: (to: string, data: Record<string, string>) => Promise<void>, brand: () => Promise<Record<string, string>>): Promise<void> {
    const db = await this.connections.get(tenantId);
    const [row] = await db
      .select({ d: notificationDeliveries, n: notifications, email: users.email })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(eq(notificationDeliveries.id, deliveryId));
    if (!row || row.d.status === 'sent') return;
    try {
      if (row.d.channel === 'email') {
        await sendEmail(row.email, {
          ...(await brand()),
          title: row.n.title,
          body: row.n.body,
          url: row.n.link ? `${this.env.APP_BASE_URL}${row.n.link}` : this.env.APP_BASE_URL,
        });
      } else {
        const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, row.n.userId));
        // Push payloads never carry sensitive details — just enough to prompt opening the app.
        const payload = JSON.stringify({ title: row.n.title, body: row.n.type.startsWith('accounting.') ? 'Open Daliz for details.' : row.n.body, link: row.n.link, tag: row.n.id });
        for (const s of subs) {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
            await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptions.id, s.id));
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
            else throw err;
          }
        }
      }
      await db.update(notificationDeliveries).set({ status: 'sent', sentAt: new Date(), attempts: row.d.attempts + 1, lastError: null }).where(eq(notificationDeliveries.id, deliveryId));
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await db
        .update(notificationDeliveries)
        .set({ status: finalAttempt ? 'failed' : 'queued', attempts: row.d.attempts + 1, lastError: message })
        .where(eq(notificationDeliveries.id, deliveryId));
      this.logger.warn({ tenantId, deliveryId, channel: row.d.channel, err: message }, 'notification delivery failed');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Request-scoped API for the current user
  // -------------------------------------------------------------------------

  private me(): { db: TenantDb; userId: string } {
    const ctx = RequestContext.tenant();
    if (ctx.actor.type !== 'user') throw Errors.forbidden('Notifications belong to workspace users.');
    return { db: ctx.db, userId: ctx.actor.userId };
  }

  async list(q: { page: number; pageSize: number; unread: boolean }): Promise<Paginated<NotificationRow> & { unread: number }> {
    const { db, userId } = this.me();
    const where = and(eq(notifications.userId, userId), q.unread ? isNull(notifications.readAt) : undefined);
    const [total] = await db.select({ n: count() }).from(notifications).where(where);
    const rows = await db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map(toRow), meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) }, unread: await this.unread(db, userId) };
  }

  async unreadCount(): Promise<{ unread: number }> {
    const { db, userId } = this.me();
    return { unread: await this.unread(db, userId) };
  }

  async markRead(ids: string[] | 'all'): Promise<{ unread: number }> {
    const { db, userId } = this.me();
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids === 'all' ? undefined : inArray(notifications.id, ids)));
    return { unread: await this.unread(db, userId) };
  }

  async preferences(): Promise<NotificationPreferenceRow[]> {
    const { db, userId } = this.me();
    const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    return NOTIFICATION_TYPES.map((type) => {
      const r = rows.find((x) => x.type === type) ?? NOTIFICATION_DEFAULTS[type];
      return { type, label: NOTIFICATION_TYPE_LABELS[type], inApp: r.inApp, email: r.email, push: r.push };
    });
  }

  async setPreferences(prefs: { type: NotificationType; inApp: boolean; email: boolean; push: boolean }[]): Promise<NotificationPreferenceRow[]> {
    const { db, userId } = this.me();
    await db.transaction(async (tx) => {
      for (const p of prefs) {
        await tx
          .insert(notificationPreferences)
          .values({ userId, ...p })
          .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.type], set: { inApp: p.inApp, email: p.email, push: p.push, updatedAt: new Date() } });
      }
    });
    return this.preferences();
  }

  pushConfig(): { enabled: boolean; publicKey: string | null } {
    return { enabled: this.pushEnabled, publicKey: this.pushEnabled ? this.env.VAPID_PUBLIC_KEY! : null };
  }

  async subscribePush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    const { db, userId } = this.me();
    if (!this.pushEnabled) throw Errors.unavailable('Push notifications aren’t configured on this server.');
    await db
      .insert(pushSubscriptions)
      .values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: RequestContext.get()?.userAgent?.slice(0, 300) ?? null })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  }

  async unsubscribePush(endpoint: string): Promise<void> {
    const { db, userId } = this.me();
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
  }
}
