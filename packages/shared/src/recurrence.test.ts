import { describe, expect, it } from 'vitest';
import { describeRRule, expandOccurrences, parseRRule, seriesEnd, zonedToUtc } from './recurrence.js';

const iso = (d: Date) => d.toISOString();

describe('recurrence', () => {
  it('keeps local wall-clock time across a DST change', () => {
    // 09:00 in New York: 13:00Z in October (EDT), 14:00Z after 1 Nov 2026 (EST).
    const start = zonedToUtc({ year: 2026, month: 10, day: 26, hour: 9, minute: 0, second: 0 }, 'America/New_York');
    expect(iso(start)).toBe('2026-10-26T13:00:00.000Z');
    const occ = expandOccurrences(
      { startsAt: start, endsAt: new Date(start.getTime() + 3600_000), timezone: 'America/New_York', rrule: 'FREQ=DAILY;COUNT=10' },
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-12-01T00:00:00Z'),
    );
    expect(occ).toHaveLength(10);
    expect(iso(occ[0]!.start)).toBe('2026-10-26T13:00:00.000Z');
    expect(iso(occ[9]!.start)).toBe('2026-11-04T14:00:00.000Z');
  });

  it('expands weekly BYDAY series and honours COUNT from the first occurrence', () => {
    const start = new Date('2026-09-07T08:30:00Z'); // Monday
    const series = { startsAt: start, endsAt: new Date('2026-09-07T09:00:00Z'), timezone: 'UTC', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5' };
    const all = expandOccurrences(series, new Date('2026-01-01'), new Date('2027-01-01'));
    expect(all.map((o) => iso(o.start).slice(0, 10))).toEqual(['2026-09-07', '2026-09-09', '2026-09-11', '2026-09-14', '2026-09-16']);
    // A later window still respects the overall count.
    const later = expandOccurrences(series, new Date('2026-09-15'), new Date('2027-01-01'));
    expect(later.map((o) => iso(o.start).slice(0, 10))).toEqual(['2026-09-16']);
    expect(iso(seriesEnd(series)!)).toBe('2026-09-16T09:00:00.000Z');
  });

  it('skips months without the day and stops at UNTIL', () => {
    const start = new Date('2026-01-31T10:00:00Z');
    const occ = expandOccurrences(
      { startsAt: start, endsAt: new Date('2026-01-31T11:00:00Z'), timezone: 'UTC', rrule: 'FREQ=MONTHLY;UNTIL=20260731' },
      new Date('2026-01-01'),
      new Date('2027-01-01'),
    );
    expect(occ.map((o) => iso(o.start).slice(0, 7))).toEqual(['2026-01', '2026-03', '2026-05', '2026-07']);
  });

  it('is unbounded only when asked and capped per window', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const series = { startsAt: start, endsAt: new Date('2026-01-01T01:00:00Z'), timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(seriesEnd(series)).toBeNull();
    expect(expandOccurrences(series, start, new Date('2030-01-01'), 50)).toHaveLength(50);
  });

  it('includes the first occurrence when the start has milliseconds', () => {
    const start = new Date('2026-09-24T10:15:30.669Z');
    const occ = expandOccurrences({ startsAt: start, endsAt: new Date(start.getTime() + 900_000), timezone: 'Asia/Kathmandu', rrule: 'FREQ=DAILY;COUNT=2' }, start, new Date('2026-10-01'));
    expect(occ.map((o) => o.start.toISOString())).toEqual(['2026-09-24T10:15:30.669Z', '2026-09-25T10:15:30.669Z']);
  });

  it('validates rules and describes them', () => {
    expect(() => parseRRule('FREQ=HOURLY')).toThrow();
    expect(() => parseRRule('FREQ=DAILY;COUNT=5;UNTIL=20261231')).toThrow();
    expect(() => parseRRule('FREQ=MONTHLY;BYDAY=MO')).toThrow();
    expect(() => parseRRule('FREQ=DAILY;COUNT=100000')).toThrow();
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10')).toBe('Every 2 weeks on Mon, Wed, 10 times');
  });
});
