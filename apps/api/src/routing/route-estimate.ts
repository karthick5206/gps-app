import { haversineMeters } from '../tracking/geo';

/** Gaps longer than this (straight line) are not guessed: too many possible roads. */
export const MAX_ESTIMATE_STRAIGHT_M = 150_000;

/** Decodes a Valhalla / OSRM encoded polyline (precision 6 by default) into [lng, lat] pairs. */
export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

export interface GapEnds {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  /** Time between the two points; 0 when unknown. */
  seconds: number;
}

/**
 * Whether a road route is a believable guess for a gap: not a long detour compared with the straight line, and
 * drivable within the gap's time (with slack for traffic the engine doesn't know about).
 */
export function plausibleRoute(gap: GapEnds, routeM: number, routeSec: number): boolean {
  const straight = haversineMeters(gap.fromLat, gap.fromLng, gap.toLat, gap.toLng);
  if (straight > MAX_ESTIMATE_STRAIGHT_M) return false;
  if (routeM > Math.max(3 * straight, straight + 3000)) return false;
  if (gap.seconds > 0 && routeSec > gap.seconds * 1.5 + 600) return false;
  return true;
}
