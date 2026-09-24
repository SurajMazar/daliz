import { wallClock, zonedToUtc } from '@daliz/shared';

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of an instant as seen in a time zone. */
export function dayKey(instant: Date | string, timeZone: string): string {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Minutes since local midnight in a time zone. */
export function minutesOfDay(instant: Date | string, timeZone: string): number {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, timeZone);
  return w.hour * 60 + w.minute;
}

/** UTC instant for local midnight of a YYYY-MM-DD day in a time zone. */
export function startOfDayUtc(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return zonedToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** "YYYY-MM-DDTHH:mm" (datetime-local value) for an instant in a time zone. */
export function toLocalInput(instant: Date | string, timeZone: string): string {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** Parses a datetime-local value as wall-clock time in a time zone → UTC instant. */
export function fromLocalInput(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return zonedToUtc({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: 0 }, timeZone);
}

export function formatTime(instant: Date | string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(typeof instant === 'string' ? new Date(instant) : instant);
}

export function formatDateTimeIn(instant: Date | string, timeZone: string, locale?: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(typeof instant === 'string' ? new Date(instant) : instant);
}
