import { addDays, isoWeekday, localDayKey, zonedTimeToUtc } from '../summarizer/tz';

export interface ScheduleTiming {
  /** 0 = Sunday … 6 = Saturday, company timezone. */
  days: number[];
  /** Local minutes after midnight. */
  startMin: number;
  /** Local calendar dates (Prisma @db.Date → UTC midnight), inclusive. */
  validFrom: Date | null;
  validTo: Date | null;
}

/** Day key 'YYYY-MM-DD' of a @db.Date value. */
export function dateOnlyKey(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Planned starts (epoch ms) of a schedule that fall in [fromMs, toMs), at `startMin` local time in `tz` on the
 * schedule's weekdays and inside its validity dates. A schedule has at most one start per local day.
 */
export function scheduleOccurrences(s: ScheduleTiming, tz: string, fromMs: number, toMs: number): number[] {
  if (toMs <= fromMs || !s.days.length) return [];
  const days = new Set(s.days);
  const validFrom = dateOnlyKey(s.validFrom);
  const validTo = dateOnlyKey(s.validTo);
  const hour = Math.floor(s.startMin / 60);
  const minute = s.startMin % 60;
  const out: number[] = [];
  // One local day either side covers any offset between the window edges and the zone.
  const last = addDays(localDayKey(toMs, tz), 1);
  for (let day = addDays(localDayKey(fromMs, tz), -1), guard = 0; day <= last && guard < 400; day = addDays(day, 1), guard++) {
    if (!days.has(isoWeekday(day) % 7)) continue;
    if (validFrom && day < validFrom) continue;
    if (validTo && day > validTo) continue;
    const at = zonedTimeToUtc(day, hour, minute, tz);
    if (at >= fromMs && at < toMs) out.push(at);
  }
  return out;
}

/** Two starts of the same schedule closer than this are the same occurrence (one start per local day). */
export const SAME_OCCURRENCE_MS = 12 * 3_600_000;

/**
 * Occurrences that still need a trip. A trip of the schedule within ±12 h of a slot counts as that slot's trip, so a
 * generated trip whose start was moved by hand (or a schedule whose time was changed) is not generated again.
 */
export function missingOccurrences(slots: number[], existingStarts: number[]): number[] {
  return slots.filter((slot) => !existingStarts.some((t) => Math.abs(t - slot) < SAME_OCCURRENCE_MS));
}
