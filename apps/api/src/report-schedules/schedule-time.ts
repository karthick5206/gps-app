import { addDays, isoWeekStart, localDayKey, parseDayKey, dayKeyOf, zonedTimeToUtc } from '../summarizer/tz';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface ScheduleTiming {
  frequency: Frequency;
  dayOfWeek: number | null; // 1–7 Monday–Sunday (WEEKLY)
  dayOfMonth: number | null; // 1–28 (MONTHLY)
  timeOfDay: string; // HH:mm company timezone
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

function matches(day: string, s: ScheduleTiming): boolean {
  if (s.frequency === 'DAILY') return true;
  if (s.frequency === 'WEEKLY') {
    const { y, m, d } = parseDayKey(day);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
    return wd === (s.dayOfWeek ?? 1);
  }
  return parseDayKey(day).d === (s.dayOfMonth ?? 1);
}

/** First run strictly after `after` (epoch ms), at `timeOfDay` local time in `tz`. */
export function computeNextRunAt(s: ScheduleTiming, tz: string, after: number): number {
  const time = parseTimeOfDay(s.timeOfDay) ?? { hour: 7, minute: 0 };
  let day = localDayKey(after, tz);
  for (let i = 0; i < 64; i++, day = addDays(day, 1)) {
    if (!matches(day, s)) continue;
    const at = zonedTimeToUtc(day, time.hour, time.minute, tz);
    if (at > after) return at;
  }
  throw new Error('No next run found');
}

/** Previous complete period before `runAt` (local): DAILY = yesterday, WEEKLY = last Mon–Sun, MONTHLY = last month. */
export function previousPeriod(frequency: Frequency, runAt: number, tz: string): { from: string; to: string } {
  const today = localDayKey(runAt, tz);
  if (frequency === 'DAILY') {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  if (frequency === 'WEEKLY') {
    const monday = addDays(isoWeekStart(today), -7);
    return { from: monday, to: addDays(monday, 6) };
  }
  const { y, m } = parseDayKey(today);
  const firstThis = dayKeyOf(y, m, 1);
  const lastPrev = addDays(firstThis, -1);
  const p = parseDayKey(lastPrev);
  return { from: dayKeyOf(p.y, p.m, 1), to: lastPrev };
}
