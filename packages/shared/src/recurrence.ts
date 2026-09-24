/**
 * Recurring events without duplicate rows: a series is stored once with an RRULE and
 * expanded into occurrences only for the window being viewed.
 *
 * Supports the RFC 5545 subset people actually use: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with
 * INTERVAL, COUNT, UNTIL and (weekly) BYDAY. Expansion happens in the event's own IANA time
 * zone, so a 09:00 meeting stays at 09:00 local time across daylight-saving changes.
 */
import { z } from 'zod';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RecurrenceRule {
  freq: Frequency;
  interval: number;
  count?: number;
  until?: Date;
  byDay?: Weekday[];
}

const MAX_COUNT = 1000;

export function parseRRule(input: string): RecurrenceRule {
  const parts = Object.fromEntries(
    input
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const [k, v] = p.split('=');
        if (!k || v === undefined) throw new Error(`Malformed RRULE part: ${p}`);
        return [k.toUpperCase(), v.toUpperCase()];
      }),
  );
  const allowed = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY']);
  for (const k of Object.keys(parts)) if (!allowed.has(k)) throw new Error(`Unsupported RRULE part: ${k}`);
  const freq = parts.FREQ as Frequency;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new Error('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) throw new Error('INTERVAL must be 1–366');
  const rule: RecurrenceRule = { freq, interval };
  if (parts.COUNT) {
    const count = Number(parts.COUNT);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(`COUNT must be 1–${MAX_COUNT}`);
    rule.count = count;
  }
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts.UNTIL);
    if (!m) throw new Error('UNTIL must look like 20261231 or 20261231T235959Z');
    rule.until = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59));
  }
  if (rule.count && rule.until) throw new Error('Use COUNT or UNTIL, not both');
  if (parts.BYDAY) {
    if (freq !== 'WEEKLY') throw new Error('BYDAY is only supported with FREQ=WEEKLY');
    const days = parts.BYDAY.split(',');
    if (!days.every((d) => (WEEKDAYS as readonly string[]).includes(d))) throw new Error('BYDAY must list MO,TU,WE,TH,FR,SA,SU');
    rule.byDay = [...new Set(days as Weekday[])].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
  }
  return rule;
}

export function formatRRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  return parts.join(';');
}

export const rruleSchema = z
  .string()
  .trim()
  .max(200)
  .superRefine((v, ctx) => {
    try {
      parseRRule(v);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
    }
  });

// ---------------------------------------------------------------------------
// Time-zone math (Intl only; no dependencies)
// ---------------------------------------------------------------------------

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  return { year: +parts.year!, month: +parts.month!, day: +parts.day!, hour: +parts.hour!, minute: +parts.minute!, second: +parts.second! };
}

/** The UTC instant at which the given wall-clock time occurs in `timeZone`. */
export function zonedToUtc(w: WallClock, timeZone: string): Date {
  const target = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = target;
  // Two passes converge for every real zone; the second corrects across a DST boundary.
  for (let i = 0; i < 3; i++) {
    const seen = wallClock(new Date(guess), timeZone);
    const seenMs = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const diff = target - seenMs;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

const dayOfWeek = (y: number, m: number, d: number) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Monday
const addDays = (y: number, m: number, d: number, n: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export interface Occurrence {
  start: Date;
  end: Date;
}

export interface SeriesInput {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  rrule: string | null;
}

/**
 * Occurrences overlapping [windowStart, windowEnd). COUNT always counts from the first
 * occurrence, not from the window, so paging through time is consistent.
 */
export function expandOccurrences(series: SeriesInput, windowStart: Date, windowEnd: Date, limit = 500): Occurrence[] {
  const duration = series.endsAt.getTime() - series.startsAt.getTime();
  if (!series.rrule) {
    return series.startsAt < windowEnd && series.endsAt > windowStart ? [{ start: series.startsAt, end: series.endsAt }] : [];
  }
  const rule = parseRRule(series.rrule);
  const base = wallClock(series.startsAt, series.timezone);
  // Wall-clock math is whole seconds; carry the sub-second part so the first occurrence
  // equals startsAt exactly (otherwise it would sort before the series start and be dropped).
  const baseMs = ((series.startsAt.getTime() % 1000) + 1000) % 1000;
  const out: Occurrence[] = [];
  let produced = 0;
  const emit = (y: number, m: number, d: number): 'stop' | 'continue' => {
    const start = new Date(zonedToUtc({ year: y, month: m, day: d, hour: base.hour, minute: base.minute, second: base.second }, series.timezone).getTime() + baseMs);
    if (start < series.startsAt) return 'continue';
    if (rule.until && start > rule.until) return 'stop';
    if (start >= windowEnd) return 'stop';
    produced++;
    const end = new Date(start.getTime() + duration);
    if (end > windowStart) out.push({ start, end });
    if (rule.count && produced >= rule.count) return 'stop';
    if (out.length >= limit) return 'stop';
    return 'continue';
  };

  for (let step = 0; step < 50_000; step++) {
    if (rule.freq === 'DAILY') {
      const d = addDays(base.year, base.month, base.day, step * rule.interval);
      if (emit(d.year, d.month, d.day) === 'stop') break;
    } else if (rule.freq === 'WEEKLY') {
      const startDow = dayOfWeek(base.year, base.month, base.day);
      const weekStart = addDays(base.year, base.month, base.day, -startDow + step * 7 * rule.interval);
      const days = rule.byDay ?? [WEEKDAYS[startDow]!];
      let stop = false;
      for (const wd of days) {
        const d = addDays(weekStart.year, weekStart.month, weekStart.day, WEEKDAYS.indexOf(wd));
        if (emit(d.year, d.month, d.day) === 'stop') {
          stop = true;
          break;
        }
      }
      if (stop) break;
    } else if (rule.freq === 'MONTHLY') {
      const monthIndex = base.month - 1 + step * rule.interval;
      const y = base.year + Math.floor(monthIndex / 12);
      const m = (monthIndex % 12) + 1;
      // Months without that day (e.g. the 31st) are skipped, per RFC 5545.
      if (base.day <= daysInMonth(y, m) && emit(y, m, base.day) === 'stop') break;
    } else {
      const y = base.year + step * rule.interval;
      if (base.day <= daysInMonth(y, base.month) && emit(y, base.month, base.day) === 'stop') break;
    }
  }
  return out;
}

/** End of the last occurrence, or null for open-ended series. Used as a query bound. */
export function seriesEnd(series: SeriesInput): Date | null {
  if (!series.rrule) return series.endsAt;
  const rule = parseRRule(series.rrule);
  if (!rule.count && !rule.until) return null;
  const all = expandOccurrences(series, series.startsAt, new Date(8.64e15), MAX_COUNT);
  return all.at(-1)?.end ?? series.endsAt;
}

/** Human description, e.g. "Every 2 weeks on Mon, Wed, 10 times". */
export function describeRRule(rrule: string | null): string {
  if (!rrule) return 'Does not repeat';
  const r = parseRRule(rrule);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  const names: Record<Weekday, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
  let text = r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
  if (r.byDay?.length) text += ` on ${r.byDay.map((d) => names[d]).join(', ')}`;
  if (r.count) text += `, ${r.count} times`;
  if (r.until) text += `, until ${r.until.toISOString().slice(0, 10)}`;
  return text;
}
