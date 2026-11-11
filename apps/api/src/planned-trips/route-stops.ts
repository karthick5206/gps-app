import { ROUTE_LIMITS } from '@veetracer/shared';

/** A stop as sent by the route editor. */
export interface StopInput {
  name: string;
  lat: number;
  lng: number;
  radiusM?: number | null;
  offsetMin?: number | null;
  waitMin?: number | null;
  geofenceId?: string | null;
}

/** A validated stop with defaults applied and `seq` assigned in order (0 = start). */
export interface NormalisedStop {
  seq: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  offsetMin: number;
  waitMin: number;
  geofenceId: string | null;
}

export type StopsResult = { ok: true; stops: NormalisedStop[] } | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * SPEC §4.1: ≥ 2 stops (at most ROUTE_LIMITS.maxStops), each with a name, a valid position, a radius of 20–2000 m,
 * an arrival offset (minutes after the planned start; the start stop is 0; non-decreasing along the route) and a wait.
 */
export function normaliseStops(input: StopInput[]): StopsResult {
  if (!Array.isArray(input) || input.length < ROUTE_LIMITS.minStops) return { ok: false, error: `A route needs at least ${ROUTE_LIMITS.minStops} stops` };
  if (input.length > ROUTE_LIMITS.maxStops) return { ok: false, error: `A route can have at most ${ROUTE_LIMITS.maxStops} stops` };
  const stops: NormalisedStop[] = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    const label = `Stop ${i + 1}`;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name) return { ok: false, error: `${label}: name is required` };
    if (name.length > 100) return { ok: false, error: `${label}: name is too long (100 characters at most)` };
    if (typeof s.lat !== 'number' || !Number.isFinite(s.lat) || s.lat < -90 || s.lat > 90) return { ok: false, error: `${label}: latitude must be between -90 and 90` };
    if (typeof s.lng !== 'number' || !Number.isFinite(s.lng) || s.lng < -180 || s.lng > 180) return { ok: false, error: `${label}: longitude must be between -180 and 180` };
    const radiusM = s.radiusM ?? ROUTE_LIMITS.radiusDefaultM;
    if (!isInt(radiusM) || radiusM < ROUTE_LIMITS.radiusMinM || radiusM > ROUTE_LIMITS.radiusMaxM) {
      return { ok: false, error: `${label}: radius must be ${ROUTE_LIMITS.radiusMinM}–${ROUTE_LIMITS.radiusMaxM} m` };
    }
    const offsetMin = s.offsetMin ?? (i === 0 ? 0 : (stops[i - 1]?.offsetMin ?? 0));
    if (!isInt(offsetMin) || offsetMin < 0 || offsetMin > ROUTE_LIMITS.maxOffsetMin) {
      return { ok: false, error: `${label}: arrival offset must be 0–${ROUTE_LIMITS.maxOffsetMin} minutes` };
    }
    if (i === 0 && offsetMin !== 0) return { ok: false, error: 'The start stop must have an arrival offset of 0' };
    if (i > 0 && offsetMin < stops[i - 1].offsetMin) return { ok: false, error: `${label}: arrival offset cannot be earlier than the previous stop's` };
    const waitMin = s.waitMin ?? 0;
    if (!isInt(waitMin) || waitMin < 0 || waitMin > ROUTE_LIMITS.maxWaitMin) {
      return { ok: false, error: `${label}: wait must be 0–${ROUTE_LIMITS.maxWaitMin} minutes` };
    }
    stops.push({ seq: i, name, lat: s.lat, lng: s.lng, radiusM, offsetMin, waitMin, geofenceId: s.geofenceId ?? null });
  }
  return { ok: true, stops };
}

/** Corridor half-width check (50–2000 m); returns an error or null. */
export function corridorError(corridorM: unknown): string | null {
  if (!isInt(corridorM) || corridorM < ROUTE_LIMITS.corridorMinM || corridorM > ROUTE_LIMITS.corridorMaxM) {
    return `Corridor must be ${ROUTE_LIMITS.corridorMinM}–${ROUTE_LIMITS.corridorMaxM} m`;
  }
  return null;
}

/**
 * "Suggest times": arrival offsets from routing-engine leg durations. Offset[0] = 0, then each stop's arrival =
 * previous arrival + previous wait + leg drive time (rounded up to whole minutes).
 */
export function suggestOffsets(legsSec: number[], waitsMin: number[]): number[] {
  const out = [0];
  for (let i = 0; i < legsSec.length; i++) out.push(out[i] + (waitsMin[i] ?? 0) + Math.ceil(Math.max(0, legsSec[i]) / 60));
  return out;
}

export interface ScheduleInput {
  days?: number[];
  startMin?: number;
  validFrom?: string | null;
  validTo?: string | null;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value: string): boolean {
  if (!DAY_KEY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Schedule body check (days 0–6 Sunday-first, start 0–1439 local minutes, validity dates YYYY-MM-DD, from ≤ to). */
export function scheduleError(s: ScheduleInput): string | null {
  if (s.days !== undefined) {
    if (!Array.isArray(s.days) || !s.days.length) return 'Choose at least one day';
    if (!s.days.every((d) => isInt(d) && d >= 0 && d <= 6)) return 'Days must be 0 (Sunday) to 6 (Saturday)';
  }
  if (s.startMin !== undefined && (!isInt(s.startMin) || s.startMin < 0 || s.startMin > 1439)) return 'Start time must be 00:00–23:59';
  if (s.validFrom && !isRealDay(s.validFrom)) return 'Valid from must be a date (YYYY-MM-DD)';
  if (s.validTo && !isRealDay(s.validTo)) return 'Valid to must be a date (YYYY-MM-DD)';
  if (s.validFrom && s.validTo && s.validFrom > s.validTo) return 'Valid from must not be after valid to';
  return null;
}

/** Sorted, de-duplicated days. */
export function cleanDays(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}
