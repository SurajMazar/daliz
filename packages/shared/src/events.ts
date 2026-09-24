/**
 * Events, reminders and notifications contract.
 */
import { z } from 'zod';
import { rruleSchema } from './recurrence.js';
import { timezoneSchema } from './schemas.js';

const instant = z.coerce.date();

export const eventInputSchema = z
  .object({
    title: z.string().trim().min(1, 'Required').max(200),
    description: z.string().max(10_000).default(''),
    location: z.string().trim().max(300).default(''),
    kind: z.enum(['event', 'meeting', 'deadline']).default('event'),
    status: z.enum(['confirmed', 'tentative']).default('confirmed'),
    startsAt: instant,
    endsAt: instant,
    allDay: z.boolean().default(false),
    timezone: timezoneSchema,
    rrule: rruleSchema.nullable().default(null),
    visibility: z.enum(['workspace', 'private']).default('workspace'),
    attendeeIds: z.array(z.string().uuid()).max(200).default([]),
    /** Minutes before each occurrence to remind the creator (and attendees who accept). */
    reminderMinutes: z.array(z.number().int().min(0).max(40_320)).max(5).default([]),
  })
  .refine((e) => e.endsAt > e.startsAt, { message: 'End must be after start', path: ['endsAt'] })
  .refine((e) => e.endsAt.getTime() - e.startsAt.getTime() <= 14 * 86400_000, { message: 'Events can last at most 14 days', path: ['endsAt'] });
export type EventInput = z.infer<typeof eventInputSchema>;

export const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    location: z.string().trim().max(300).optional(),
    kind: z.enum(['event', 'meeting', 'deadline']).optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    allDay: z.boolean().optional(),
    timezone: timezoneSchema.optional(),
    rrule: rruleSchema.nullable().optional(),
    visibility: z.enum(['workspace', 'private']).optional(),
    attendeeIds: z.array(z.string().uuid()).max(200).optional(),
    version: z.number().int().min(1),
  });

/** Change or cancel one occurrence of a recurring series. */
export const occurrenceChangeSchema = z
  .object({
    occurrenceStart: instant,
    cancelled: z.boolean().default(false),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((o) => o.cancelled || (o.startsAt && o.endsAt) || o.title, { message: 'Nothing to change' })
  .refine((o) => !o.startsAt || !o.endsAt || o.endsAt > o.startsAt, { message: 'End must be after start', path: ['endsAt'] });

export const rsvpSchema = z.object({ response: z.enum(['accepted', 'declined', 'tentative']) });

export const eventRangeSchema = z
  .object({ from: instant, to: instant, mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') })
  .refine((r) => r.to > r.from, { message: '"to" must be after "from"', path: ['to'] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 400 * 86400_000, { message: 'Ask for at most ~13 months at a time', path: ['to'] });

export const reminderInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(2000).default(''),
    remindAt: instant.optional(),
    eventId: z.string().uuid().nullable().default(null),
    taskId: z.string().uuid().nullable().default(null),
    minutesBefore: z.number().int().min(0).max(40_320).nullable().default(null),
    channel: z.enum(['in_app', 'email', 'both']).default('in_app'),
  })
  .refine((r) => r.remindAt || (r.eventId && r.minutesBefore !== null), { message: 'Pick a time, or an event and how long before it', path: ['remindAt'] });

export const NOTIFICATION_TYPES = [
  'task.assigned',
  'task.status_changed',
  'task.commented',
  'event.invited',
  'event.updated',
  'event.cancelled',
  'reminder.due',
  'accounting.entry_submitted',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  'task.assigned': 'A task is assigned to me',
  'task.status_changed': 'A task I follow changes status',
  'task.commented': 'Someone comments on a task I follow',
  'event.invited': 'I’m invited to an event',
  'event.updated': 'An event I’m attending changes',
  'event.cancelled': 'An event I’m attending is cancelled',
  'reminder.due': 'My reminders',
  'accounting.entry_submitted': 'A journal entry awaits my approval',
};

/** Defaults when a user hasn't set a preference. */
export const NOTIFICATION_DEFAULTS: Record<NotificationType, { inApp: boolean; email: boolean; push: boolean }> = {
  'task.assigned': { inApp: true, email: true, push: true },
  'task.status_changed': { inApp: true, email: false, push: false },
  'task.commented': { inApp: true, email: false, push: true },
  'event.invited': { inApp: true, email: true, push: true },
  'event.updated': { inApp: true, email: true, push: false },
  'event.cancelled': { inApp: true, email: true, push: true },
  'reminder.due': { inApp: true, email: false, push: true },
  'accounting.entry_submitted': { inApp: true, email: true, push: false },
};

export const notificationPreferencesSchema = z.object({
  preferences: z
    .array(z.object({ type: z.enum(NOTIFICATION_TYPES), inApp: z.boolean(), email: z.boolean(), push: z.boolean() }))
    .max(NOTIFICATION_TYPES.length),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoints must use HTTPS'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

export interface PersonMini {
  id: string;
  name: string;
}

export interface EventOccurrenceRow {
  /** Stable per occurrence: `${eventId}:${occurrenceStartISO}` for series, eventId otherwise. */
  occurrenceId: string;
  eventId: string;
  title: string;
  description: string;
  location: string;
  kind: 'event' | 'meeting' | 'deadline';
  status: 'confirmed' | 'tentative' | 'cancelled';
  start: string;
  end: string;
  /** Start of the occurrence as generated by the series (for occurrence changes). */
  occurrenceStart: string;
  allDay: boolean;
  timezone: string;
  recurring: boolean;
  recurrence: string | null;
  recurrenceText: string;
  organizer: PersonMini | null;
  attendees: (PersonMini & { response: 'pending' | 'accepted' | 'declined' | 'tentative' })[];
  myResponse: 'pending' | 'accepted' | 'declined' | 'tentative' | null;
  canEdit: boolean;
}

export interface EventDetail extends Omit<EventOccurrenceRow, 'occurrenceId' | 'start' | 'end' | 'occurrenceStart'> {
  startsAt: string;
  endsAt: string;
  visibility: 'workspace' | 'private';
  version: number;
  exceptions: { occurrenceStart: string; cancelled: boolean; startsAt: string | null; endsAt: string | null; title: string | null }[];
}

export interface ReminderRow {
  id: string;
  title: string;
  notes: string;
  remindAt: string;
  eventId: string | null;
  taskId: string | null;
  minutesBefore: number | null;
  channel: 'in_app' | 'email' | 'both';
  status: 'scheduled' | 'sent' | 'dismissed' | 'cancelled';
  lastSentAt: string | null;
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceRow {
  type: NotificationType;
  label: string;
  inApp: boolean;
  email: boolean;
  push: boolean;
}

/** Messages pushed over the WebSocket. */
export type RealtimeMessage =
  | { type: 'notification'; notification: NotificationRow; unread: number }
  | { type: 'invalidate'; topics: string[] }
  | { type: 'session_ended'; reason: string };
