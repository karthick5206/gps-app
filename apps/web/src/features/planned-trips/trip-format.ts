/**
 * Pure helpers of the Planned trips screens (no React / DOM / aliases, so `node --test` runs them):
 * delay formatting and classification, progress text, the status → actions matrix, live-update patching and
 * company-timezone day ranges. SPEC: docs/routes-trips/SPEC.md §4.3, §4.5, §4.6.
 */
import type {
  PlannedTripLiveUpdate,
  PlannedTripStatus,
  PlannedTripStopDto,
  PlannedTripSummaryDto,
} from '@veetracer/shared';
import { formatDuration } from '../../lib/format.ts';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

/** A stop (or trip) is on time when |delay| ≤ 5 min (SPEC §4.6). */
export const ON_TIME_SEC = 300;
/** The tracker gives up on an open trip this long after its planned end (PLANNED_TRIP_TIMING.incompleteAfterMin). */
const INCOMPLETE_AFTER_MS = 120 * 60_000;

/** Statuses in the order of the status chips. STARTED is shown together with IN_PROGRESS. */
export const STATUS_CHIPS = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE', 'CANCELLED'] as const;
export type StatusChip = (typeof STATUS_CHIPS)[number];

export const STATUS_LABEL: Record<PlannedTripStatus, string> = {
  SCHEDULED: 'Scheduled',
  STARTED: 'Started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  INCOMPLETE: 'Incomplete',
  CANCELLED: 'Cancelled',
};

export type BadgeTone = 'neutral' | 'info' | 'default' | 'success' | 'warning' | 'muted';
export const STATUS_TONE: Record<PlannedTripStatus, BadgeTone> = {
  SCHEDULED: 'neutral',
  STARTED: 'info',
  IN_PROGRESS: 'default',
  COMPLETED: 'success',
  INCOMPLETE: 'warning',
  CANCELLED: 'muted',
};

export const isActiveTrip = (s: PlannedTripStatus): boolean => s === 'STARTED' || s === 'IN_PROGRESS';

/** The chip a trip counts under (STARTED → In progress). */
export const chipOf = (s: PlannedTripStatus): StatusChip => (s === 'STARTED' ? 'IN_PROGRESS' : s);

export function statusCounts(trips: readonly Pick<PlannedTripSummaryDto, 'status'>[]): Record<StatusChip, number> {
  const out: Record<StatusChip, number> = { SCHEDULED: 0, IN_PROGRESS: 0, COMPLETED: 0, INCOMPLETE: 0, CANCELLED: 0 };
  for (const t of trips) out[chipOf(t.status)]++;
  return out;
}

// ───────────── delay ─────────────

export type DelayClass = 'ontime' | 'late' | 'early';

/** + late, − early; on time within ±5 min. Null when unknown. */
export function classifyDelay(delaySec: number | null | undefined): DelayClass | null {
  if (delaySec === null || delaySec === undefined || !Number.isFinite(delaySec)) return null;
  if (Math.abs(delaySec) <= ON_TIME_SEC) return 'ontime';
  return delaySec > 0 ? 'late' : 'early';
}

/** "+12 min", "−1 h 5 min", "0 s" (rounded to whole minutes); "—" when unknown. */
export function formatDelay(delaySec: number | null | undefined): string {
  if (delaySec === null || delaySec === undefined || !Number.isFinite(delaySec)) return '—';
  const minutes = Math.round(Math.abs(delaySec) / 60);
  if (minutes === 0) return formatDuration(0);
  return `${delaySec > 0 ? '+' : '−'}${formatDuration(minutes * 60)}`;
}

/** Text colour class (soft-token text pairs) for a delay class. */
export const DELAY_TEXT_CLASS: Record<DelayClass, string> = {
  ontime: 'text-success-fg',
  late: 'text-destructive-fg',
  early: 'text-info-fg',
};

// ───────────── progress ─────────────

export interface TripProgress {
  /** 1-based number of the stop the vehicle is heading to (active trips), else null. */
  next: number | null;
  total: number;
}

export function tripProgress(trip: Pick<PlannedTripSummaryDto, 'status' | 'nextStopSeq' | 'stopCount'>): TripProgress {
  const total = trip.stopCount;
  const next = isActiveTrip(trip.status) && trip.nextStopSeq !== null ? Math.min(total, trip.nextStopSeq + 1) : null;
  return { next, total };
}

/** "Stop 3 of 5" while active, "5 stops" otherwise ("All 5 stops" once completed). */
export function progressLabel(trip: Pick<PlannedTripSummaryDto, 'status' | 'nextStopSeq' | 'stopCount'>, t: Translate = english): string {
  const p = tripProgress(trip);
  if (p.next !== null) return t('Stop {{n}} of {{total}}', { n: p.next, total: p.total });
  if (trip.status === 'COMPLETED') return t('All {{count}} stops', { count: p.total });
  return t('{{count}} stops', { count: p.total });
}

// ───────────── actions ─────────────

export type TripAction = 'edit' | 'start' | 'complete' | 'cancel';

/** Row actions by status (mirrors the API's trip-rules: edit / start while SCHEDULED, complete while active). */
export function tripActions(status: PlannedTripStatus): TripAction[] {
  switch (status) {
    case 'SCHEDULED':
      return ['edit', 'start', 'cancel'];
    case 'STARTED':
    case 'IN_PROGRESS':
      return ['complete', 'cancel'];
    default:
      return [];
  }
}

// ───────────── stops ─────────────

export type StopTiming = 'pending' | 'skipped' | DelayClass;

/**
 * On time / late / early from the arrival delay; the start stop (no arrival, only a departure) is judged on its
 * departure. Skipped and not-yet-reached stops have their own class.
 */
export function stopTiming(stop: Pick<PlannedTripStopDto, 'status' | 'delaySec' | 'actualArrival' | 'actualDeparture' | 'plannedDeparture'>): StopTiming {
  if (stop.status === 'SKIPPED') return 'skipped';
  if (stop.status === 'PENDING') return 'pending';
  const byArrival = classifyDelay(stop.delaySec);
  if (byArrival) return byArrival;
  if (stop.actualDeparture) return classifyDelay((Date.parse(stop.actualDeparture) - Date.parse(stop.plannedDeparture)) / 1000) ?? 'pending';
  return 'pending';
}

/** Actual dwell (s) at a stop, or null until it was both reached and left. */
export function actualDwellSec(stop: Pick<PlannedTripStopDto, 'actualArrival' | 'actualDeparture'>): number | null {
  if (!stop.actualArrival || !stop.actualDeparture) return null;
  return Math.max(0, (Date.parse(stop.actualDeparture) - Date.parse(stop.actualArrival)) / 1000);
}

export function plannedDwellSec(stop: Pick<PlannedTripStopDto, 'plannedArrival' | 'plannedDeparture'>): number {
  return Math.max(0, (Date.parse(stop.plannedDeparture) - Date.parse(stop.plannedArrival)) / 1000);
}

// ───────────── live updates ─────────────

/** Applies a `plannedTrip.update` push to a list row or a detail (stops merged by seq). Same object when unrelated. */
export function applyLiveUpdate<T extends PlannedTripSummaryDto & { stops?: PlannedTripStopDto[] }>(trip: T, u: PlannedTripLiveUpdate): T {
  if (trip.id !== u.id) return trip;
  const next: T = {
    ...trip,
    status: u.status,
    nextStopSeq: u.nextStopSeq,
    etaNextStop: u.etaNextStop,
    delaySec: u.delaySec,
    actualStart: u.actualStart,
    actualEnd: u.actualEnd,
    deviationCount: u.deviationCount,
    maxDeviationM: u.maxDeviationM,
  };
  if (trip.stops && u.stops?.length) {
    const bySeq = new Map(u.stops.map((s) => [s.seq, s]));
    next.stops = trip.stops.map((s) => {
      const c = bySeq.get(s.seq);
      return c ? { ...s, status: c.status, actualArrival: c.actualArrival, actualDeparture: c.actualDeparture, delaySec: c.delaySec } : s;
    });
  }
  return next;
}

/**
 * Time window of the actual track: actual start → actual end, or now while active (an abandoned trip is capped at
 * its timeout). Null before the trip started.
 */
export function trackWindow(trip: Pick<PlannedTripSummaryDto, 'status' | 'actualStart' | 'actualEnd' | 'plannedEnd'>, now: number = Date.now()): { from: number; to: number } | null {
  if (!trip.actualStart) return null;
  const from = Date.parse(trip.actualStart);
  let to: number;
  if (trip.actualEnd) to = Date.parse(trip.actualEnd);
  else if (isActiveTrip(trip.status)) to = now;
  else to = Math.min(now, Date.parse(trip.plannedEnd) + INCOMPLETE_AFTER_MS);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to: Math.max(to, from + 60_000) };
}

// ───────────── company time zone ─────────────

function zoneParts(ms: number, tz: string | undefined): { y: number; m: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(tz ? { timeZone: tz } : {}),
  }).formatToParts(new Date(ms));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DDTHH:mm" (a datetime-local value) of an instant in `tz` (undefined = browser zone). */
export function toZonedWall(ms: number, tz: string | undefined): string {
  const p = zoneParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** The instant of a wall time "YYYY-MM-DDTHH:mm" in `tz` (undefined = browser zone); NaN when malformed. */
export function fromZonedWall(wall: string, tz: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (!tz) return new Date(y, mo - 1, d, h, mi).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at: number) => {
    const p = zoneParts(at, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(at / 60_000) * 60_000;
  };
  const first = guess - offset(guess);
  const second = guess - offset(first);
  return second;
}

/** [from, to) instants of a calendar day "YYYY-MM-DD" in `tz`. */
export function dayRange(day: string, tz: string | undefined): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDay = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  return { from: new Date(fromZonedWall(`${day}T00:00`, tz)).toISOString(), to: new Date(fromZonedWall(`${nextDay}T00:00`, tz)).toISOString() };
}

/** Day "YYYY-MM-DD" shifted by `days`. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + days));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** "14:05" of an instant in `tz`; "—" when missing. Adds the day ("12 Nov 14:05") when it differs from `day`. */
export function formatClock(iso: string | null | undefined, tz: string | undefined, day?: string, locale?: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const p = zoneParts(ms, tz);
  const clock = `${pad(p.h)}:${pad(p.mi)}`;
  const key = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (!day || key === day) return clock;
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(p.y, p.m - 1, p.d, 12)));
  return `${date} ${clock}`;
}
