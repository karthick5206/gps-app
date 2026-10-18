import { computeNextRunAt, previousPeriod } from './schedule-time';

const IST = 'Asia/Kolkata';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('computeNextRunAt (company timezone)', () => {
  it('DAILY: today if the time is still ahead, else tomorrow', () => {
    const s = { frequency: 'DAILY' as const, dayOfWeek: null, dayOfMonth: null, timeOfDay: '07:30' };
    // 2026-10-18 06:00 IST → today 07:30 IST = 02:00Z
    expect(iso(computeNextRunAt(s, IST, at('2026-10-18T00:30:00Z')))).toBe('2026-10-18T02:00:00.000Z');
    // exactly at the run time → next day
    expect(iso(computeNextRunAt(s, IST, at('2026-10-18T02:00:00Z')))).toBe('2026-10-19T02:00:00.000Z');
    // 23:50 IST on the 18th (18:20Z) → 07:30 IST on the 19th
    expect(iso(computeNextRunAt(s, IST, at('2026-10-18T18:20:00Z')))).toBe('2026-10-19T02:00:00.000Z');
  });

  it('DAILY uses the local date, not the UTC date', () => {
    const s = { frequency: 'DAILY' as const, dayOfWeek: null, dayOfMonth: null, timeOfDay: '00:15' };
    // 2026-10-18 19:00Z = 00:30 IST on the 19th → next 00:15 IST is on the 20th (18:45Z on the 19th)
    expect(iso(computeNextRunAt(s, IST, at('2026-10-18T19:00:00Z')))).toBe('2026-10-19T18:45:00.000Z');
  });

  it('WEEKLY on a given ISO weekday', () => {
    const monday = { frequency: 'WEEKLY' as const, dayOfWeek: 1, dayOfMonth: null, timeOfDay: '06:00' };
    // Sunday 2026-10-18 → Monday 2026-10-19 06:00 IST
    expect(iso(computeNextRunAt(monday, IST, at('2026-10-18T03:00:00Z')))).toBe('2026-10-19T00:30:00.000Z');
    // Monday after the time → next Monday
    expect(iso(computeNextRunAt(monday, IST, at('2026-10-19T01:00:00Z')))).toBe('2026-10-26T00:30:00.000Z');
    const sunday = { ...monday, dayOfWeek: 7 };
    expect(iso(computeNextRunAt(sunday, IST, at('2026-10-18T00:00:00Z')))).toBe('2026-10-18T00:30:00.000Z');
  });

  it('MONTHLY on a day of the month', () => {
    const s = { frequency: 'MONTHLY' as const, dayOfWeek: null, dayOfMonth: 1, timeOfDay: '05:00' };
    expect(iso(computeNextRunAt(s, IST, at('2026-10-18T03:00:00Z')))).toBe('2026-10-31T23:30:00.000Z'); // 1 Nov 05:00 IST
    const s28 = { ...s, dayOfMonth: 28 };
    expect(iso(computeNextRunAt(s28, IST, at('2026-02-28T00:00:00Z')))).toBe('2026-03-27T23:30:00.000Z');
  });

  it('works in other timezones (DST, America/New_York)', () => {
    const s = { frequency: 'DAILY' as const, dayOfWeek: null, dayOfMonth: null, timeOfDay: '08:00' };
    // 2026-11-01 is the DST end in New York: 08:00 EST = 13:00Z
    expect(iso(computeNextRunAt(s, 'America/New_York', at('2026-11-01T06:00:00Z')))).toBe('2026-11-01T13:00:00.000Z');
    expect(iso(computeNextRunAt(s, 'America/New_York', at('2026-10-31T06:00:00Z')))).toBe('2026-10-31T12:00:00.000Z');
  });
});

describe('previousPeriod', () => {
  const runAt = at('2026-10-19T00:30:00Z'); // Monday 06:00 IST
  it('DAILY = yesterday (local)', () => {
    expect(previousPeriod('DAILY', runAt, IST)).toEqual({ from: '2026-10-18', to: '2026-10-18' });
    // 2026-10-18 20:00Z is already the 19th in IST
    expect(previousPeriod('DAILY', at('2026-10-18T20:00:00Z'), IST)).toEqual({ from: '2026-10-18', to: '2026-10-18' });
  });
  it('WEEKLY = last complete Monday–Sunday', () => {
    expect(previousPeriod('WEEKLY', runAt, IST)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    // on a Sunday the current week is not complete yet
    expect(previousPeriod('WEEKLY', at('2026-10-18T10:00:00Z'), IST)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });
  it('MONTHLY = last calendar month', () => {
    expect(previousPeriod('MONTHLY', runAt, IST)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousPeriod('MONTHLY', at('2026-03-01T00:00:00Z'), IST)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(previousPeriod('MONTHLY', at('2027-01-05T00:00:00Z'), IST)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
