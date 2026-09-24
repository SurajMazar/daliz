import type { AddressInfo } from 'node:net';
import type { EventDetail, EventOccurrenceRow, NotificationRow, ProjectRow, RealtimeMessage, ReminderRow, TaskDetail } from '@daliz/shared';
import { eq } from 'drizzle-orm';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationDeliveries } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { RemindersService } from '../modules/events/reminders.service.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { RealtimeGateway } from '../modules/realtime/realtime.gateway.js';
import { PASSWORD, TestEnv, type ApiClient, type TestTenant } from './harness.js';

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('events, reminders, notifications and realtime', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let owner: ApiClient;
  let manager: ApiClient;
  let managerId: string;
  let employee: ApiClient;
  let employeeId: string;
  let employeeEmail: string;
  const sockets: Socket[] = [];

  const notificationsOf = async (c: ApiClient) => (await c.get<NotificationRow[]>('/notifications')).data;

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    owner = await t.loggedIn(tenant.ownerEmail);
    const m = await t.addUser(tenant.tenantId, 'manager');
    const e = await t.addUser(tenant.tenantId, 'employee');
    managerId = m.userId;
    employeeId = e.userId;
    employeeEmail = e.email;
    manager = await t.loggedIn(m.email);
    employee = await t.loggedIn(e.email);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await t?.stop();
  });
  beforeEach(async () => t.clearRateLimits());

  describe('events', () => {
    it('expands a recurring series without storing duplicates, and handles single-occurrence changes', async () => {
      const created = await manager.post<EventDetail>('/events', {
        title: 'Weekly finance sync',
        startsAt: '2026-11-02T14:00:00Z',
        endsAt: '2026-11-02T14:30:00Z',
        timezone: 'America/New_York',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6',
        attendeeIds: [employeeId],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.data.recurrenceText).toBe('Every week on Mon, Thu, 6 times');

      const range = (from: string, to: string) => manager.get<EventOccurrenceRow[]>(`/events?from=${from}&to=${to}`);
      const all = await range('2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z');
      const mine = all.data.filter((o) => o.eventId === created.data.eventId);
      expect(mine).toHaveLength(6);
      expect(mine.every((o) => o.start.endsWith('T14:00:00.000Z') || o.start.endsWith('T14:00:00.000Z'))).toBe(true);

      // Cancel one occurrence, move another.
      const [first, second] = mine;
      await manager.post(`/events/${created.data.eventId}/occurrences`, { occurrenceStart: first!.occurrenceStart, cancelled: true });
      await manager.post(`/events/${created.data.eventId}/occurrences`, { occurrenceStart: second!.occurrenceStart, startsAt: '2026-11-05T18:00:00Z', endsAt: '2026-11-05T18:30:00Z' });
      const after = (await range('2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z')).data.filter((o) => o.eventId === created.data.eventId);
      expect(after).toHaveLength(5);
      expect(after.find((o) => o.occurrenceStart === second!.occurrenceStart)!.start).toBe('2026-11-05T18:00:00.000Z');
      expect((await manager.post(`/events/${created.data.eventId}/occurrences`, { occurrenceStart: '2026-11-03T14:00:00Z', cancelled: true })).status).toBe(400);
    });

    it('keeps private events to their organiser and attendees, and limits editing to the organiser', async () => {
      const priv = await employee.post<EventDetail>('/events', {
        title: '1:1 with Marco',
        startsAt: inMinutes(60 * 24).toISOString(),
        endsAt: inMinutes(60 * 24 + 30).toISOString(),
        timezone: 'UTC',
        visibility: 'private',
        attendeeIds: [managerId],
      });
      const outsider = await t.loggedIn((await t.addUser(tenant.tenantId, 'employee')).email);
      expect((await outsider.get(`/events/${priv.data.eventId}`)).status).toBe(404);
      const range = `/events?from=${inMinutes(0).toISOString()}&to=${inMinutes(60 * 48).toISOString()}`;
      expect((await outsider.get<EventOccurrenceRow[]>(range)).data.map((o) => o.eventId)).not.toContain(priv.data.eventId);
      expect((await manager.get<EventDetail>(`/events/${priv.data.eventId}`)).data.myResponse).toBe('pending');

      const shared = await employee.post<EventDetail>('/events', { title: 'Team lunch', startsAt: inMinutes(120).toISOString(), endsAt: inMinutes(180).toISOString(), timezone: 'UTC' });
      expect((await outsider.patch(`/events/${shared.data.eventId}`, { title: 'Hijacked', version: shared.data.version })).status).toBe(403);
      expect((await manager.patch(`/events/${shared.data.eventId}`, { location: 'Rooftop', version: shared.data.version })).status).toBe(200); // managers moderate
      expect((await manager.post<EventDetail>(`/events/${priv.data.eventId}/rsvp`, { response: 'accepted' })).data.myResponse).toBe('accepted');
      expect((await outsider.post(`/events/${shared.data.eventId}/rsvp`, { response: 'accepted' })).status).toBe(403);
    });
  });

  describe('notifications', () => {
    it('notifies invitees, tracks unread state, and honours preferences', async () => {
      const before = (await employee.get<{ unread: number }>('/notifications/unread-count')).data.unread;
      await manager.post('/events', { title: 'Budget review', startsAt: inMinutes(300).toISOString(), endsAt: inMinutes(360).toISOString(), timezone: 'UTC', attendeeIds: [employeeId] });
      await settle();
      const list = await notificationsOf(employee);
      const invite = list.find((n) => n.type === 'event.invited' && n.title.includes('Budget review'))!;
      expect(invite.link).toMatch(/^\/events\?event=/);
      expect((await employee.get<{ unread: number }>('/notifications/unread-count')).data.unread).toBe(before + 1);
      expect((await employee.post<{ unread: number }>('/notifications/read', { ids: [invite.id] })).data.unread).toBe(before);

      // Turn every channel off for invitations: nothing new arrives.
      await employee.put('/notifications/preferences', { preferences: [{ type: 'event.invited', inApp: false, email: false, push: false }] });
      await manager.post('/events', { title: 'Muted meeting', startsAt: inMinutes(400).toISOString(), endsAt: inMinutes(430).toISOString(), timezone: 'UTC', attendeeIds: [employeeId] });
      await settle();
      expect((await notificationsOf(employee)).some((n) => n.title.includes('Muted meeting'))).toBe(false);
      await employee.put('/notifications/preferences', { preferences: [{ type: 'event.invited', inApp: true, email: true, push: false }] });
    });

    it('queues email deliveries and tracks success and failure', async () => {
      await manager.post('/events', { title: 'Email me', startsAt: inMinutes(500).toISOString(), endsAt: inMinutes(530).toISOString(), timezone: 'UTC', attendeeIds: [employeeId] });
      await settle();
      const db = await t.get(TenantConnectionManager).get(tenant.tenantId);
      const deliveries = await db.select().from(notificationDeliveries);
      expect(deliveries.length).toBeGreaterThan(0);
      const svc = t.get(NotificationsService);
      const sent: string[] = [];
      const target = deliveries.find((d) => d.status === 'queued')!;
      await svc.deliver(tenant.tenantId, target.id, false, async (to) => void sent.push(to), async () => ({}));
      expect(sent).toEqual([employeeEmail]);
      const [ok] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, target.id));
      expect(ok!.status).toBe('sent');
      const failing = (await db.select().from(notificationDeliveries)).find((d) => d.status === 'queued');
      if (failing) {
        await expect(svc.deliver(tenant.tenantId, failing.id, true, async () => { throw new Error('SMTP down'); }, async () => ({}))).rejects.toThrow('SMTP down');
        const [bad] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, failing.id));
        expect(bad).toMatchObject({ status: 'failed', lastError: 'SMTP down' });
      }
    });

    it('notifies assignees and approvers from other modules', async () => {
      const ws = await manager.post<{ id: string }>('/planner/workspaces', { name: 'Notify WS' });
      const project = (await manager.post<ProjectRow>('/planner/projects', { workspaceId: ws.data.id, key: 'NOTE', name: 'Notify project' })).data;
      const task = (await manager.post<TaskDetail>('/planner/tasks', { projectId: project.id, title: 'Prepare slides', assigneeId: employeeId })).data;
      await settle();
      expect((await notificationsOf(employee)).find((n) => n.type === 'task.assigned')?.link).toBe(`/planner?task=${task.id}`);

      const accountant = await t.loggedIn((await t.addUser(tenant.tenantId, 'accountant')).email);
      const accounts = await accountant.get<{ id: string; code: string }[]>('/accounting/accounts');
      const id = (code: string) => accounts.data.find((a) => a.code === code)!.id;
      const entry = await accountant.post<{ id: string }>('/accounting/journal-entries', {
        entryDate: '2026-09-20',
        description: 'Quarterly accrual',
        lines: [
          { accountId: id('6700'), debit: '900' },
          { accountId: id('2200'), credit: '900' },
        ],
      });
      await accountant.post(`/accounting/journal-entries/${entry.data.id}/submit`);
      await settle();
      const ownerInbox = await notificationsOf(owner);
      const approval = ownerInbox.find((n) => n.type === 'accounting.entry_submitted')!;
      expect(approval.body).toBe('Quarterly accrual');
      expect(approval.title).not.toMatch(/900/); // no amounts in notifications
    });
  });

  describe('reminders', () => {
    it('fires reminders once, and rolls recurring event reminders forward', async () => {
      const reminders = t.get(RemindersService);
      const standalone = await employee.post<ReminderRow>('/reminders', { title: 'Call the bank', remindAt: inMinutes(1).toISOString() });
      expect(standalone.status, JSON.stringify(standalone.body)).toBe(201);
      await reminders.fireDue(inMinutes(2));
      await reminders.fireDue(inMinutes(3)); // idempotent
      const inbox = await notificationsOf(employee);
      expect(inbox.filter((n) => n.type === 'reminder.due' && n.title === 'Call the bank')).toHaveLength(1);
      expect((await employee.get<ReminderRow[]>('/reminders')).data.find((r) => r.id === standalone.data.id)!.status).toBe('sent');

      const daily = await employee.post<EventDetail>('/events', {
        title: 'Daily stand-up',
        startsAt: inMinutes(30).toISOString(),
        endsAt: inMinutes(45).toISOString(),
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;COUNT=3',
        reminderMinutes: [10],
      });
      const r1 = (await employee.get<ReminderRow[]>('/reminders')).data.find((r) => r.eventId === daily.data.eventId)!;
      expect(new Date(r1.remindAt).getTime()).toBeCloseTo(inMinutes(20).getTime(), -4);
      await reminders.fireDue(inMinutes(21));
      const r2 = (await employee.get<ReminderRow[]>('/reminders')).data.find((r) => r.id === r1.id)!;
      expect(r2.status).toBe('scheduled');
      expect(new Date(r2.remindAt).getTime() - new Date(r1.remindAt).getTime()).toBe(86400_000);
    });

    it('only lets people manage their own reminders', async () => {
      const mine = await employee.post<ReminderRow>('/reminders', { title: 'Private', remindAt: inMinutes(60).toISOString() });
      expect((await manager.patch(`/reminders/${mine.data.id}`, { title: 'Stolen' })).status).toBe(404);
      expect((await manager.del(`/reminders/${mine.data.id}`)).status).toBe(404);
      expect((await manager.get<ReminderRow[]>('/reminders')).data.map((r) => r.id)).not.toContain(mine.data.id);
    });
  });

  describe('realtime', () => {
    const port = () => (t.app.getHttpServer().address() as AddressInfo).port;
    const cookieOf = async (email: string) => {
      const c = t.client();
      const res = await c.login(email, PASSWORD);
      return { cookie: String(res.headers['set-cookie']).split(';')[0]!, client: c };
    };
    const connect = (cookie?: string, origin = 'http://localhost:5173') =>
      new Promise<{ socket: Socket; messages: RealtimeMessage[]; connected: boolean }>((resolve) => {
        const messages: RealtimeMessage[] = [];
        const socket = io(`http://127.0.0.1:${port()}`, {
          path: '/api/v1/realtime',
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          extraHeaders: { ...(cookie ? { cookie } : {}), origin },
        });
        sockets.push(socket);
        socket.on('message', (m: RealtimeMessage) => messages.push(m));
        socket.on('connect', () => setTimeout(() => resolve({ socket, messages, connected: socket.connected }), 150));
        socket.on('disconnect', () => resolve({ socket, messages, connected: false }));
        socket.on('connect_error', () => resolve({ socket, messages, connected: false }));
      });

    it('delivers live notifications only within the tenant, and refuses bad connections', async () => {
      const { cookie } = await cookieOf(employeeEmail);
      const mine = await connect(cookie);
      expect(mine.connected).toBe(true);

      const other = await t.createTenant();
      const { cookie: otherCookie } = await cookieOf(other.ownerEmail);
      const stranger = await connect(otherCookie);
      expect(stranger.connected).toBe(true);

      await manager.post('/events', { title: 'Live invite', startsAt: inMinutes(600).toISOString(), endsAt: inMinutes(630).toISOString(), timezone: 'UTC', attendeeIds: [employeeId] });
      await settle(400);
      expect(mine.messages.some((m) => m.type === 'notification' && m.notification.title.includes('Live invite'))).toBe(true);
      expect(mine.messages.some((m) => m.type === 'invalidate' && m.topics.includes('events'))).toBe(true);
      expect(stranger.messages).toHaveLength(0);

      expect((await connect(undefined)).connected).toBe(false);
      expect((await connect(cookie, 'https://evil.example')).connected).toBe(false);
    });

    it('disconnects sockets whose session was revoked', async () => {
      const { cookie, client } = await cookieOf(employeeEmail);
      const live = await connect(cookie);
      expect(live.connected).toBe(true);
      await client.post('/auth/logout');
      await t.get(RealtimeGateway).revalidateAll();
      await settle(200);
      expect(live.socket.connected).toBe(false);
      expect(live.messages.some((m) => m.type === 'session_ended')).toBe(true);
    });
  });
});
