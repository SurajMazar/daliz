import { Injectable } from '@nestjs/common';
import {
  describeRRule,
  expandOccurrences,
  seriesEnd,
  type EventDetail,
  type EventInput,
  type EventOccurrenceRow,
} from '@daliz/shared';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DomainEvents } from '../../common/domain-events.js';
import { Errors } from '../../common/errors.js';
import { RequestContext, type TenantContext } from '../../common/request-context.js';
import { calendarEvents, eventAttendees, eventExceptions, reminders, users } from '../../database/tenant/schema.js';
import { AuditService } from '../audit/audit.service.js';
import { ReminderIndex } from './reminder-index.js';

type EventRow = typeof calendarEvents.$inferSelect;
const uid = (ctx: TenantContext) => (ctx.actor.type === 'user' ? ctx.actor.userId : null);

/**
 * Calendar events. A recurring series is one row plus exceptions for individual
 * occurrences that were moved or cancelled; occurrences are generated per requested window,
 * so no background process ever creates duplicate rows.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly reminderIndex: ReminderIndex,
  ) {}

  private canSee(ctx: TenantContext, e: EventRow, attendeeIds: string[]): boolean {
    if (e.visibility === 'workspace' || ctx.actor.type === 'support') return true;
    const me = uid(ctx);
    return !!me && (e.organizerId === me || attendeeIds.includes(me));
  }

  private canEdit(ctx: TenantContext, e: EventRow): boolean {
    if (ctx.actor.type === 'support') return ctx.actor.allowWrite;
    const me = uid(ctx);
    return (!!me && e.organizerId === me) || ctx.permissions.has('events.delete');
  }

  private async load(ctx: TenantContext, id: string) {
    const [e] = await ctx.db.select().from(calendarEvents).where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)));
    if (!e) throw Errors.notFound();
    const attendees = await ctx.db
      .select({ id: users.id, name: users.name, response: eventAttendees.response })
      .from(eventAttendees)
      .innerJoin(users, eq(users.id, eventAttendees.userId))
      .where(eq(eventAttendees.eventId, id))
      .orderBy(asc(users.name));
    if (!this.canSee(ctx, e, attendees.map((a) => a.id))) throw Errors.notFound();
    return { e, attendees };
  }

  private async assertUsers(ctx: TenantContext, ids: string[]) {
    if (!ids.length) return;
    const found = await ctx.db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, 'active')));
    if (found.length !== new Set(ids).size) throw Errors.badRequest('Every attendee must be an active member of this workspace.');
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async occurrences(from: Date, to: Date, mine: boolean, includeCancelled = false): Promise<EventOccurrenceRow[]> {
    const ctx = RequestContext.tenant();
    const me = uid(ctx);
    const rows = await ctx.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          isNull(calendarEvents.deletedAt),
          lt(calendarEvents.startsAt, to),
          or(isNull(calendarEvents.seriesEndsAt), gt(calendarEvents.seriesEndsAt, from)),
          sql`${calendarEvents.status} <> 'cancelled'`,
        ),
      )
      .limit(2000);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const attendees = await ctx.db
      .select({ eventId: eventAttendees.eventId, id: users.id, name: users.name, response: eventAttendees.response })
      .from(eventAttendees)
      .innerJoin(users, eq(users.id, eventAttendees.userId))
      .where(inArray(eventAttendees.eventId, ids));
    const exceptions = await ctx.db.select().from(eventExceptions).where(inArray(eventExceptions.eventId, ids));
    const organizers = new Map(
      (await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, rows.map((r) => r.organizerId).filter((x): x is string => !!x)))).map((u) => [u.id, u]),
    );
    const out: EventOccurrenceRow[] = [];
    for (const e of rows) {
      const att = attendees.filter((a) => a.eventId === e.id);
      if (!this.canSee(ctx, e, att.map((a) => a.id))) continue;
      if (mine && e.organizerId !== me && !att.some((a) => a.id === me)) continue;
      const myResponse = att.find((a) => a.id === me)?.response ?? null;
      const exFor = exceptions.filter((x) => x.eventId === e.id);
      // Widen the expansion window so occurrences moved *into* the window are found too.
      const occs = expandOccurrences({ startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, rrule: e.rrule }, new Date(from.getTime() - 14 * 86400_000), new Date(to.getTime() + 14 * 86400_000));
      for (const o of occs) {
        const ex = exFor.find((x) => x.occurrenceStart.getTime() === o.start.getTime());
        if (ex?.cancelled && !includeCancelled) continue;
        const start = ex?.startsAt ?? o.start;
        const end = ex?.endsAt ?? o.end;
        if (!(start < to && end > from)) continue;
        out.push({
          occurrenceId: e.rrule ? `${e.id}:${o.start.toISOString()}` : e.id,
          eventId: e.id,
          title: ex?.title ?? e.title,
          description: e.description,
          location: e.location,
          kind: e.kind,
          status: ex?.cancelled ? 'cancelled' : e.status,
          start: start.toISOString(),
          end: end.toISOString(),
          occurrenceStart: o.start.toISOString(),
          allDay: e.allDay,
          timezone: e.timezone,
          recurring: !!e.rrule,
          recurrence: e.rrule,
          recurrenceText: describeRRule(e.rrule),
          organizer: e.organizerId ? (organizers.get(e.organizerId) ?? null) : null,
          attendees: att.map(({ id, name, response }) => ({ id, name, response })),
          myResponse,
          canEdit: this.canEdit(ctx, e),
        });
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  async get(id: string): Promise<EventDetail> {
    const ctx = RequestContext.tenant();
    const { e, attendees } = await this.load(ctx, id);
    const me = uid(ctx);
    const exceptions = await ctx.db.select().from(eventExceptions).where(eq(eventExceptions.eventId, id)).orderBy(asc(eventExceptions.occurrenceStart));
    const [organizer] = e.organizerId ? await ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, e.organizerId)) : [];
    return {
      eventId: e.id,
      title: e.title,
      description: e.description,
      location: e.location,
      kind: e.kind,
      status: e.status,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      allDay: e.allDay,
      timezone: e.timezone,
      recurring: !!e.rrule,
      recurrence: e.rrule,
      recurrenceText: describeRRule(e.rrule),
      organizer: organizer ?? null,
      attendees,
      myResponse: attendees.find((a) => a.id === me)?.response ?? null,
      canEdit: this.canEdit(ctx, e),
      visibility: e.visibility,
      version: e.version,
      exceptions: exceptions.map((x) => ({
        occurrenceStart: x.occurrenceStart.toISOString(),
        cancelled: x.cancelled,
        startsAt: x.startsAt?.toISOString() ?? null,
        endsAt: x.endsAt?.toISOString() ?? null,
        title: x.title,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(input: EventInput): Promise<EventDetail> {
    const ctx = RequestContext.tenant();
    const me = uid(ctx);
    const attendeeIds = [...new Set(input.attendeeIds)].filter((a) => a !== me);
    await this.assertUsers(ctx, attendeeIds);
    const end = seriesEnd({ startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, rrule: input.rrule });
    const id = await ctx.db.transaction(async (tx) => {
      const [e] = await tx
        .insert(calendarEvents)
        .values({
          title: input.title,
          description: input.description,
          location: input.location,
          kind: input.kind,
          status: input.status,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          allDay: input.allDay,
          timezone: input.timezone,
          rrule: input.rrule,
          seriesEndsAt: end,
          visibility: input.visibility,
          organizerId: me,
          createdBy: me,
        })
        .returning({ id: calendarEvents.id });
      const rows = [...(me ? [{ eventId: e!.id, userId: me, response: 'accepted' as const, respondedAt: new Date() }] : []), ...attendeeIds.map((userId) => ({ eventId: e!.id, userId }))];
      if (rows.length) await tx.insert(eventAttendees).values(rows);
      return e!.id;
    });
    if (me) {
      for (const minutes of [...new Set(input.reminderMinutes)]) {
        await this.createEventReminder(ctx, id, me, input.title, minutes);
      }
    }
    await this.audit.tenantEvent({ action: 'events.created', resourceType: 'event', resourceId: id, metadata: { title: input.title, recurring: !!input.rrule, attendees: attendeeIds.length } });
    if (attendeeIds.length) {
      this.events.emit('event.invited', { tenantId: ctx.tenantId, eventId: id, title: input.title, startsAt: input.startsAt.toISOString(), timezone: input.timezone, allDay: input.allDay, attendeeIds, actorId: me });
    }
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['events'] });
    return this.get(id);
  }

  /** Reminder `minutes` before the next upcoming occurrence of an event. */
  async createEventReminder(ctx: TenantContext, eventId: string, userId: string, title: string, minutes: number, channel: 'in_app' | 'email' | 'both' = 'in_app') {
    const next = await this.nextReminderTime(ctx, eventId, minutes, new Date());
    if (!next) return null;
    const [r] = await ctx.db
      .insert(reminders)
      .values({ userId, eventId, title, remindAt: next, minutesBefore: minutes, channel })
      .returning({ id: reminders.id });
    await this.reminderIndex.schedule(ctx.tenantId, r!.id, next);
    return r!.id;
  }

  /** First occurrence whose reminder time is after `after`, minus `minutes`. */
  async nextReminderTime(ctx: { db: TenantContext['db'] }, eventId: string, minutes: number, after: Date): Promise<Date | null> {
    const [e] = await ctx.db.select().from(calendarEvents).where(and(eq(calendarEvents.id, eventId), isNull(calendarEvents.deletedAt)));
    if (!e || e.status === 'cancelled') return null;
    const exceptions = await ctx.db.select().from(eventExceptions).where(eq(eventExceptions.eventId, eventId));
    const lead = minutes * 60_000;
    const occs = expandOccurrences({ startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, rrule: e.rrule }, new Date(after.getTime() + lead), new Date(after.getTime() + lead + 400 * 86400_000), 50);
    for (const o of occs) {
      const ex = exceptions.find((x) => x.occurrenceStart.getTime() === o.start.getTime());
      if (ex?.cancelled) continue;
      const at = new Date((ex?.startsAt ?? o.start).getTime() - lead);
      if (at > after) return at;
    }
    return null;
  }

  private async rescheduleReminders(ctx: TenantContext, eventId: string) {
    const rows = await ctx.db.select().from(reminders).where(and(eq(reminders.eventId, eventId), eq(reminders.status, 'scheduled')));
    for (const r of rows) {
      const next = r.minutesBefore !== null ? await this.nextReminderTime(ctx, eventId, r.minutesBefore, new Date()) : null;
      if (next) {
        await ctx.db.update(reminders).set({ remindAt: next, updatedAt: new Date() }).where(eq(reminders.id, r.id));
        await this.reminderIndex.schedule(ctx.tenantId, r.id, next);
      } else {
        await ctx.db.update(reminders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(reminders.id, r.id));
        await this.reminderIndex.unschedule(ctx.tenantId, r.id);
      }
    }
  }

  async update(id: string, patch: Partial<Omit<EventInput, 'reminderMinutes' | 'attendeeIds' | 'status'>> & { status?: 'confirmed' | 'tentative' | 'cancelled'; attendeeIds?: string[]; version: number }): Promise<EventDetail> {
    const ctx = RequestContext.tenant();
    const { e, attendees } = await this.load(ctx, id);
    if (!this.canEdit(ctx, e)) throw Errors.forbidden('Only the organizer can change this event.');
    const me = uid(ctx);
    const startsAt = patch.startsAt ?? e.startsAt;
    const endsAt = patch.endsAt ?? e.endsAt;
    if (endsAt <= startsAt) throw Errors.badRequest('End must be after start.');
    const rrule = patch.rrule !== undefined ? patch.rrule : e.rrule;
    const timezone = patch.timezone ?? e.timezone;
    const newAttendees = patch.attendeeIds ? [...new Set(patch.attendeeIds)].filter((a) => a !== e.organizerId) : null;
    if (newAttendees) await this.assertUsers(ctx, newAttendees);
    const { version, attendeeIds: _ignored, ...fields } = patch;
    void _ignored;
    const timingChanged = patch.startsAt !== undefined || patch.endsAt !== undefined || patch.rrule !== undefined || patch.timezone !== undefined;
    await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(calendarEvents)
        .set({ ...fields, seriesEndsAt: seriesEnd({ startsAt, endsAt, timezone, rrule }), version: e.version + 1, updatedAt: new Date() })
        .where(and(eq(calendarEvents.id, id), eq(calendarEvents.version, version)))
        .returning({ id: calendarEvents.id });
      if (!updated.length) throw Errors.versionConflict();
      // Changing the series itself invalidates per-occurrence exceptions.
      if (patch.rrule !== undefined || patch.startsAt !== undefined || patch.timezone !== undefined) {
        await tx.delete(eventExceptions).where(eq(eventExceptions.eventId, id));
      }
      if (newAttendees) {
        const keep = [...newAttendees, ...(e.organizerId ? [e.organizerId] : [])];
        await tx.delete(eventAttendees).where(and(eq(eventAttendees.eventId, id), sql`${eventAttendees.userId} not in (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})`));
        const existing = new Set(attendees.map((a) => a.id));
        const added = newAttendees.filter((a) => !existing.has(a));
        if (added.length) await tx.insert(eventAttendees).values(added.map((userId) => ({ eventId: id, userId })));
      }
    });
    if (timingChanged || patch.status === 'cancelled') await this.rescheduleReminders(ctx, id);
    const detail = await this.get(id);
    await this.audit.tenantEvent({ action: patch.status === 'cancelled' ? 'events.cancelled' : 'events.updated', resourceType: 'event', resourceId: id, metadata: { fields: Object.keys(fields) } });
    const notifyIds = detail.attendees.map((a) => a.id).filter((a) => a !== me);
    const invited = newAttendees ? newAttendees.filter((a) => !attendees.some((x) => x.id === a)) : [];
    if (invited.length) this.events.emit('event.invited', { tenantId: ctx.tenantId, eventId: id, title: detail.title, startsAt: detail.startsAt, timezone: detail.timezone, allDay: detail.allDay, attendeeIds: invited, actorId: me });
    const others = notifyIds.filter((a) => !invited.includes(a));
    if (others.length && (patch.status === 'cancelled' || timingChanged || patch.location !== undefined)) {
      this.events.emit(patch.status === 'cancelled' ? 'event.cancelled' : 'event.updated', { tenantId: ctx.tenantId, eventId: id, title: detail.title, startsAt: detail.startsAt, timezone: detail.timezone, allDay: detail.allDay, attendeeIds: others, actorId: me });
    }
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['events'] });
    return detail;
  }

  async changeOccurrence(id: string, change: { occurrenceStart: Date; cancelled: boolean; startsAt?: Date; endsAt?: Date; title?: string }): Promise<EventDetail> {
    const ctx = RequestContext.tenant();
    const { e } = await this.load(ctx, id);
    if (!this.canEdit(ctx, e)) throw Errors.forbidden('Only the organizer can change this event.');
    if (!e.rrule) throw Errors.badRequest('This event doesn’t repeat; edit the event instead.');
    const valid = expandOccurrences({ startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, rrule: e.rrule }, new Date(change.occurrenceStart.getTime() - 1), new Date(change.occurrenceStart.getTime() + 1), 2).some(
      (o) => o.start.getTime() === change.occurrenceStart.getTime(),
    );
    if (!valid) throw Errors.badRequest('That occurrence isn’t part of this series.');
    await ctx.db
      .insert(eventExceptions)
      .values({ eventId: id, occurrenceStart: change.occurrenceStart, cancelled: change.cancelled, startsAt: change.startsAt ?? null, endsAt: change.endsAt ?? null, title: change.title ?? null })
      .onConflictDoUpdate({
        target: [eventExceptions.eventId, eventExceptions.occurrenceStart],
        set: { cancelled: change.cancelled, startsAt: change.startsAt ?? null, endsAt: change.endsAt ?? null, title: change.title ?? null },
      });
    await this.rescheduleReminders(ctx, id);
    const detail = await this.get(id);
    await this.audit.tenantEvent({ action: 'events.occurrence_changed', resourceType: 'event', resourceId: id, metadata: { occurrenceStart: change.occurrenceStart.toISOString(), cancelled: change.cancelled } });
    const me = uid(ctx);
    const attendeeIds = detail.attendees.map((a) => a.id).filter((a) => a !== me);
    if (attendeeIds.length) {
      this.events.emit(change.cancelled ? 'event.cancelled' : 'event.updated', { tenantId: ctx.tenantId, eventId: id, title: detail.title, startsAt: (change.startsAt ?? change.occurrenceStart).toISOString(), timezone: detail.timezone, allDay: detail.allDay, attendeeIds, actorId: me });
    }
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['events'] });
    return detail;
  }

  async rsvp(id: string, response: 'accepted' | 'declined' | 'tentative'): Promise<EventDetail> {
    const ctx = RequestContext.tenant();
    await this.load(ctx, id);
    const me = uid(ctx);
    if (!me) throw Errors.forbidden();
    const updated = await ctx.db
      .update(eventAttendees)
      .set({ response, respondedAt: new Date() })
      .where(and(eq(eventAttendees.eventId, id), eq(eventAttendees.userId, me)))
      .returning({ id: eventAttendees.userId });
    if (!updated.length) throw Errors.forbidden('You aren’t invited to this event.');
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['events'] });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const { e } = await this.load(ctx, id);
    if (!this.canEdit(ctx, e)) throw Errors.forbidden('Only the organizer can delete this event.');
    await ctx.db.update(calendarEvents).set({ deletedAt: new Date() }).where(eq(calendarEvents.id, id));
    const rows = await ctx.db
      .update(reminders)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(reminders.eventId, id), eq(reminders.status, 'scheduled')))
      .returning({ id: reminders.id });
    for (const r of rows) await this.reminderIndex.unschedule(ctx.tenantId, r.id);
    await this.audit.tenantEvent({ action: 'events.deleted', resourceType: 'event', resourceId: id, metadata: { title: e.title } });
    this.events.emit('realtime.invalidate', { tenantId: ctx.tenantId, userIds: 'all', topics: ['events'] });
  }
}
