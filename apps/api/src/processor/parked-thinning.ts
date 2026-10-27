import { POSITION_FLAGS } from '@veetracer/shared';
import { haversineMeters } from '../tracking/geo';

/**
 * Phone trackers send a "still here" point every minute while parked (Wi-Fi / cell location, ~100 m accuracy): a
 * third of all their rows, with no new information. Those repeats are not stored; the live map, last-seen time and
 * rules still see every point. One parked point is kept every PARKED_KEEP_MS, below the 15-minute gap after which
 * History draws "no data" and the summarizer splits stops, and the last skipped point is written just before the
 * next stored one, so a departure keeps its exact time.
 */
export const PARKED_KEEP_MS = 10 * 60_000;
/** Within this distance (or the fix's accuracy radius, if larger) of the last trusted point counts as the same place. */
export const PARKED_RADIUS_M = 30;

export interface ParkedInput {
  /** Filtered speed (zero for untrusted points). */
  speedKph: number;
  flags: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
  fixTime: number;
  alarm: boolean;
  statusChanged: boolean;
  /** Last trusted point before this one. */
  lastValid: { lat: number; lng: number } | null;
  /** fixTime of the last stored row; null when unknown (e.g. after a restart). */
  storedAt: number | null;
}

/** True when this point is a parked repeat that need not be stored. */
export function isParkedRepeat(p: ParkedInput): boolean {
  if (p.alarm || p.statusChanged || p.speedKph >= 1 || p.storedAt === null) return false;
  if (p.fixTime - p.storedAt >= PARKED_KEEP_MS || p.fixTime < p.storedAt) return false;
  if ((p.flags & POSITION_FLAGS.DRIFT) !== 0) return true;
  if (!p.lastValid) return false;
  return haversineMeters(p.lastValid.lat, p.lastValid.lng, p.lat, p.lng) <= Math.max(PARKED_RADIUS_M, p.accuracyM ?? 0);
}
