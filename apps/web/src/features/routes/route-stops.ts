/**
 * Pure helpers of the route editor's stop list (no runtime imports, so they run under node --test).
 * The rules mirror `normaliseStops` / `suggestOffsets` in apps/api/src/planned-trips/route-stops.ts.
 */
import type { ROUTE_LIMITS } from '@veetracer/shared';

export type RouteLimits = typeof ROUTE_LIMITS;

/** A stop while it is edited (numbers may be NaN while a field is blank or half-typed). */
export interface StopDraft {
  /** Stable React key; not sent. */
  key: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  offsetMin: number;
  waitMin: number;
  geofenceId?: string | null;
}

export type StopField = 'name' | 'position' | 'radiusM' | 'offsetMin' | 'waitMin';

/** A problem found in the stop list. `message` is an English i18n key; `vars` fill its placeholders. */
export interface StopIssue {
  /** null = the whole list (too few / too many stops). */
  index: number | null;
  field?: StopField;
  message: string;
  vars?: Record<string, string | number>;
}

const isInt = (v: number) => Number.isInteger(v);

/**
 * Same checks as the API (SPEC §4.1): 2–100 stops, a name (≤ 100 chars), a valid position, a radius of 20–2000 m,
 * whole-minute arrival offsets starting at 0 and never earlier than the previous stop's, and a wait of 0–1440 min.
 * Returns every issue (not only the first) so each row can show its own error.
 */
export function validateStops(stops: StopDraft[], limits: RouteLimits): StopIssue[] {
  const issues: StopIssue[] = [];
  if (stops.length < limits.minStops) issues.push({ index: null, message: 'A route needs at least {{n}} stops', vars: { n: limits.minStops } });
  if (stops.length > limits.maxStops) issues.push({ index: null, message: 'A route can have at most {{n}} stops', vars: { n: limits.maxStops } });
  let prevOffset: number | null = null;
  stops.forEach((s, i) => {
    const name = s.name.trim();
    if (!name) issues.push({ index: i, field: 'name', message: 'Name is required' });
    else if (name.length > 100) issues.push({ index: i, field: 'name', message: 'Name is too long (100 characters at most)' });
    if (!Number.isFinite(s.lat) || s.lat < -90 || s.lat > 90 || !Number.isFinite(s.lng) || s.lng < -180 || s.lng > 180) {
      issues.push({ index: i, field: 'position', message: 'Position is not valid' });
    }
    if (!isInt(s.radiusM) || s.radiusM < limits.radiusMinM || s.radiusM > limits.radiusMaxM) {
      issues.push({ index: i, field: 'radiusM', message: 'Radius must be {{min}}–{{max}} m', vars: { min: limits.radiusMinM, max: limits.radiusMaxM } });
    }
    if (!isInt(s.offsetMin) || s.offsetMin < 0 || s.offsetMin > limits.maxOffsetMin) {
      issues.push({ index: i, field: 'offsetMin', message: 'Arrival must be 0–{{max}} min', vars: { max: limits.maxOffsetMin } });
    } else if (i === 0 && s.offsetMin !== 0) {
      issues.push({ index: i, field: 'offsetMin', message: 'The start stop arrives at 0 min' });
    } else if (prevOffset !== null && s.offsetMin < prevOffset) {
      issues.push({ index: i, field: 'offsetMin', message: "Arrival cannot be earlier than the previous stop's" });
    }
    if (isInt(s.offsetMin)) prevOffset = Math.max(prevOffset ?? 0, s.offsetMin);
    if (!isInt(s.waitMin) || s.waitMin < 0 || s.waitMin > limits.maxWaitMin) {
      issues.push({ index: i, field: 'waitMin', message: 'Wait must be 0–{{max}} min', vars: { max: limits.maxWaitMin } });
    }
  });
  return issues;
}

/**
 * "Suggest times" (copy of the API's `suggestOffsets`): offset[0] = 0, then each stop's arrival = previous arrival +
 * previous wait + leg drive time rounded up to whole minutes.
 */
export function suggestOffsets(legsSec: number[], waitsMin: number[]): number[] {
  const out = [0];
  for (let i = 0; i < legsSec.length; i++) out.push(out[i] + (waitsMin[i] ?? 0) + Math.ceil(Math.max(0, legsSec[i]) / 60));
  return out;
}

/** Moves the item at `from` by `delta` (−1 up, +1 down); returns the same array when the move is out of range. */
export function moveItem<T>(items: T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const out = items.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Key of the stop positions (what the road-path preview depends on). */
export function positionsKey(stops: { lat: number; lng: number }[]): string {
  return stops.map((s) => `${s.lat.toFixed(6)},${s.lng.toFixed(6)}`).join(';');
}

/** A short stop name from a geocoder label: its first comma part, at most 100 characters. */
export function stopNameFromPlace(label: string): string {
  const first = label.split(',')[0]?.trim() || label.trim();
  return first.slice(0, 100);
}

