import { IoDailyReportRow } from '@veetracer/shared';
import { addDays, localDayKey, localMidnight } from '../summarizer/tz';

export interface IoSessionLite {
  objectId: string;
  kind: string;
  on: boolean;
  startTime: number;
  /** Null = still open (counted up to `now`). */
  endTime: number | null;
  distanceKm: number;
  engineOffSec: number;
}

type DayTotals = Omit<IoDailyReportRow, 'objectName' | 'plateNumber'>;

/**
 * Per vehicle per local day: AC-on time (and with the engine off), AC switch-ons, km with AC on, door openings and
 * door-open time. Sessions are clipped to the report range and split at local midnight; distance and engine-off time
 * are shared out in proportion to the time in each day. Only ON / open periods count.
 */
export function aggregateIoDays(sessions: IoSessionLite[], from: string, to: string, tz: string, now: number): DayTotals[] {
  const rangeStart = localMidnight(from, tz);
  const rangeEnd = localMidnight(addDays(to, 1), tz);
  const out = new Map<string, DayTotals>();
  const row = (objectId: string, day: string) => {
    const k = `${objectId}|${day}`;
    let r = out.get(k);
    if (!r) {
      r = { objectId, day, acOnSec: 0, acOnEngineOffSec: 0, acOnCount: 0, acDistanceKm: 0, doorOpenCount: 0, doorOpenSec: 0 };
      out.set(k, r);
    }
    return r;
  };
  for (const s of sessions) {
    if (!s.on) continue;
    const end = Math.min(s.endTime ?? now, rangeEnd);
    const start = Math.max(s.startTime, rangeStart);
    if (end <= start && !(s.startTime >= rangeStart && s.startTime < rangeEnd)) continue;
    const total = Math.max(1, (s.endTime ?? now) - s.startTime);
    if (s.startTime >= rangeStart && s.startTime < rangeEnd) {
      const r = row(s.objectId, localDayKey(s.startTime, tz));
      if (s.kind === 'AC') r.acOnCount++;
      else r.doorOpenCount++;
    }
    let day = localDayKey(start, tz);
    while (end > start) {
      const dayStart = Math.max(localMidnight(day, tz), start);
      const dayEnd = Math.min(localMidnight(addDays(day, 1), tz), end);
      if (dayEnd > dayStart) {
        const ms = dayEnd - dayStart;
        const r = row(s.objectId, day);
        if (s.kind === 'AC') {
          r.acOnSec += ms / 1000;
          r.acOnEngineOffSec += (s.engineOffSec * ms) / total;
          r.acDistanceKm += (s.distanceKm * ms) / total;
        } else r.doorOpenSec += ms / 1000;
      }
      if (localMidnight(addDays(day, 1), tz) >= end) break;
      day = addDays(day, 1);
    }
  }
  return [...out.values()].map((r) => ({
    ...r,
    acOnSec: Math.round(r.acOnSec),
    acOnEngineOffSec: Math.round(r.acOnEngineOffSec),
    acDistanceKm: Math.round(r.acDistanceKm * 100) / 100,
    doorOpenSec: Math.round(r.doorOpenSec),
  }));
}
