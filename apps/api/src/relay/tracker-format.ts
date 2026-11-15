import { NormalizedPosition, TRACKER_POSITIONS_PATH } from '@veetracer/shared';

/**
 * VEETRAX_TRACKER forwarding format: positions re-posted the way the VeeTrax Tracker app posts them
 * (`POST /api/tracker/v1/positions`, body `{ positions: [...] }`, Bearer token of a phone activated on the target).
 * The receiving server then treats them exactly like its own phone's points (its own filters, trips and alerts).
 */

/** One point as the Tracker app uploads it (see mobile-tracker.logic.ts `parsePoint`). */
export type TrackerUploadPoint = Record<string, unknown> & { t: number; lat: number; lng: number };

/** The phone protocol id of positions that came from the Tracker app. */
const MOBILE_PROTOCOL = 'mobile';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The upload point for one position. A position that came from a phone carries its original point in `raw`, which is
 * forwarded unchanged (nothing lost: accuracy, provider, the phone's own verdict). Any other position is mapped from the
 * normalised fields. Null when the position has no usable time or coordinates.
 */
export function toTrackerPoint(p: Pick<NormalizedPosition, 'protocol' | 'fixTime' | 'lat' | 'lng' | 'speedKph' | 'course' | 'altitude' | 'satellites' | 'valid' | 'attributes' | 'raw'>): TrackerUploadPoint | null {
  if (p.protocol === MOBILE_PROTOCOL && p.raw) {
    try {
      const original = JSON.parse(p.raw) as Record<string, unknown>;
      if (original && num(original.t) !== null && num(original.lat) !== null && num(original.lng) !== null) return original as TrackerUploadPoint;
    } catch {
      // fall back to the normalised fields
    }
  }
  const t = Date.parse(p.fixTime);
  if (!Number.isFinite(t) || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  const a = p.attributes ?? {};
  const point: TrackerUploadPoint = { t, lat: p.lat, lng: p.lng };
  // Speed: km/h → m/s (the app reports m/s).
  if (num(p.speedKph) !== null) point.spd = Math.round(((p.speedKph as number) / 3.6) * 100) / 100;
  if (num(p.course) !== null) point.brg = p.course;
  if (num(p.altitude) !== null) point.alt = p.altitude;
  if (num(p.satellites) !== null) point.sat = p.satellites;
  if (num(a.accuracyM) !== null) point.acc = a.accuracyM;
  if (num(a.batteryLevel) !== null) point.bat = a.batteryLevel;
  if (typeof a.charging === 'boolean') point.chg = a.charging;
  if (a.mock === true) point.mock = true;
  if (a.alarm === 'sos') point.sos = true;
  // A fix the source judged invalid stays invalid on the target (the app's way of saying "doubtful").
  if (!p.valid && point.acc === undefined) point.flt = 'inaccurate';
  return point;
}

/** Whether a URL is a Tracker upload endpoint (used to warn when the format and the URL do not match). */
export function isTrackerPositionsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === TRACKER_POSITIONS_PATH;
  } catch {
    return false;
  }
}

/** `https://host/api/tracker/v1/<action>` next to the target's positions URL (activation calls). */
export function trackerApiUrl(positionsUrl: string, action: 'activate/request' | 'activate/verify'): string {
  const u = new URL(positionsUrl);
  return `${u.origin}/api/tracker/v1/${action}`;
}
