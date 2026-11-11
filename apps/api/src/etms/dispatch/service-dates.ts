import { TRANSPORT_E3_LIMITS, type TransportDirection } from '@veetracer/shared';
import { addDays, isoWeekday, localDayKey, zonedTimeToUtc } from '../../summarizer/tz';
import { dayKeyOf } from './e3-common';

/**
 * Pure time arithmetic of shifts, schedules and booking windows (12 WP 3.2: site time zone, overnight shifts, US DST).
 * A leg is anchored on the shift's local login (IN) or logout (OUT) time of a service date: IN window =
 * [login − inWindowMin, login], OUT window = [logout, logout + outWindowMin]. An overnight shift logs out on the next
 * local day. Local wall times are converted with the zone's rules (zonedTimeToUtc), so a 09:00 shift stays 09:00 across
 * a DST change.
 */

const MIN = 60_000;

export interface ShiftTiming {
  startMin: number;
  endMin: number;
  overnight: boolean;
  days: number[];
  timeZone: string;
}

export interface ScheduleTiming {
  direction: TransportDirection;
  days: number[];
  validFrom: Date;
  validTo: Date | null;
}

export interface LegWindow {
  /** Login (IN) / logout (OUT) instant. */
  anchor: number;
  start: number;
  end: number;
}

/** Window of one leg. `timeMin` overrides the shift's login / logout time (schedule exception OVERRIDE). */
export function legWindow(shift: Pick<ShiftTiming, 'startMin' | 'endMin' | 'timeZone'>, direction: TransportDirection, serviceDate: string, timeMin?: number): LegWindow {
  if (direction === 'IN') {
    const at = timeMin ?? shift.startMin;
    const anchor = zonedTimeToUtc(serviceDate, Math.floor(at / 60), at % 60, shift.timeZone);
    return { anchor, start: anchor - TRANSPORT_E3_LIMITS.inWindowMin * MIN, end: anchor };
  }
  const at = timeMin ?? shift.endMin;
  // Logout before the login time of the day = the next local day (overnight shift, or an override after midnight).
  const day = at < shift.startMin ? addDays(serviceDate, 1) : serviceDate;
  const anchor = zonedTimeToUtc(day, Math.floor(at / 60), at % 60, shift.timeZone);
  return { anchor, start: anchor, end: anchor + TRANSPORT_E3_LIMITS.outWindowMin * MIN };
}

/** Weekday 0 = Sunday … 6 of a day key. */
export const weekdayOf = (day: string): number => isoWeekday(day) % 7;

export interface Occurrence {
  serviceDate: string;
  window: LegWindow;
}

/**
 * Service dates of a schedule whose leg window STARTS in [fromMs, toMs): weekday in schedule.days ∩ shift.days and
 * inside the schedule's validity. Exceptions are applied by the caller (they may re-time a date).
 */
export function scheduleOccurrences(schedule: ScheduleTiming, shift: ShiftTiming, fromMs: number, toMs: number): Occurrence[] {
  if (toMs <= fromMs) return [];
  const days = new Set(schedule.days.filter((d) => shift.days.includes(d)));
  if (!days.size) return [];
  const validFrom = dayKeyOf(schedule.validFrom);
  const validTo = schedule.validTo ? dayKeyOf(schedule.validTo) : null;
  const out: Occurrence[] = [];
  // One local day before covers an IN window that starts the evening before; one after covers zone offsets.
  const last = addDays(localDayKey(toMs, shift.timeZone), 1);
  for (let day = addDays(localDayKey(fromMs, shift.timeZone), -1), guard = 0; day <= last && guard < 400; day = addDays(day, 1), guard++) {
    if (!days.has(weekdayOf(day))) continue;
    if (day < validFrom || (validTo && day > validTo)) continue;
    const window = legWindow(shift, schedule.direction, day);
    if (window.start >= fromMs && window.start < toMs) out.push({ serviceDate: day, window });
  }
  return out;
}

/** Day keys from `from` to `to` inclusive (at most `max`). */
export function dayRange(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let d = from, i = 0; d <= to && i < max; d = addDays(d, 1), i++) out.push(d);
  return out;
}

/**
 * The same local wall time on another service date (repeat-to-date drafts keep 07:40 at 07:40 across DST): the instant
 * `ms` read in `tz`, moved by the number of days between the two service dates.
 */
export function sameWallTime(ms: number, tz: string, fromDate: string, toDate: string): number {
  const day = localDayKey(ms, tz);
  const shiftDays = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
  const minutesIntoDay = Math.round((ms - zonedTimeToUtc(day, 0, 0, tz)) / MIN);
  const target = addDays(day, shiftDays);
  return zonedTimeToUtc(target, Math.floor(minutesIntoDay / 60), minutesIntoDay % 60, tz);
}

/** Today's day key in a zone. */
export const todayIn = (tz: string, now: number = Date.now()): string => localDayKey(now, tz);
