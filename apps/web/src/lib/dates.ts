/** YYYY-MM-DD for "today" in a time zone (the tenant's), not the browser's. */
export function todayIn(timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

/** Parses YYYY-MM-DD as a UTC date (no time-zone drift). */
export function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function isoFromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoFromUtc(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / 86_400_000);
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso: string): string {
  const d = parseIsoDate(startOfMonth(iso));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return isoFromUtc(d);
}

export function addMonths(iso: string, months: number): string {
  const d = parseIsoDate(startOfMonth(iso));
  d.setUTCMonth(d.getUTCMonth() + months);
  return isoFromUtc(d);
}

export function startOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`;
}

/** Formats a YYYY-MM-DD date without shifting it through the browser's time zone. */
export function formatIsoDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }, locale?: string): string {
  if (!iso) return '—';
  const d = parseIsoDate(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(d);
}
