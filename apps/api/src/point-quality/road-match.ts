import { haversineMeters } from '../tracking/geo';
import type { InPoint } from './analyze';

/** Matching sends one fix every ≥ this many metres or seconds (enough for the road choice, much less work). */
const THIN_M = 30;
const THIN_MS = 20_000;
/** Fixes per /match request (GraphHopper handles a few thousand; smaller requests fail less). */
const CHUNK = 800;
/** A moving fix farther than this (or twice its accuracy) from the matched road is off-road. */
export const OFFROAD_M = 60;

/** Indexes of `seg` to send: the first, then one every THIN_M / THIN_MS, and the last. */
export function thinForMatching(points: InPoint[], seg: number[]): number[] {
  if (seg.length <= 2) return seg.slice();
  const out = [seg[0]];
  for (let k = 1; k < seg.length - 1; k++) {
    const a = points[out[out.length - 1]];
    const b = points[seg[k]];
    if (haversineMeters(a.lat, a.lng, b.lat, b.lng) >= THIN_M || b.t - a.t >= THIN_MS) out.push(seg[k]);
  }
  out.push(seg[seg.length - 1]);
  return out;
}

/**
 * Snaps one moving part to roads with GraphHopper's map matching (hidden Markov model over road candidates).
 * Returns the matched road as [lng, lat] pairs, or null when the engine cannot match it (e.g. off the road network).
 */
export async function matchSegment(baseUrl: string, points: InPoint[], seg: number[]): Promise<[number, number][] | null> {
  const send = thinForMatching(points, seg);
  if (send.length < 3) return null;
  const accs = send.map((i) => points[i].acc).filter((a): a is number => a !== null).sort((a, b) => a - b);
  const gpsAccuracy = Math.min(60, Math.max(10, Math.round(accs.length ? accs[accs.length >> 1] : 20)));
  const line: [number, number][] = [];
  for (let start = 0; start < send.length - 1; start += CHUNK - 1) {
    const chunk = send.slice(start, start + CHUNK);
    if (chunk.length < 2) break;
    const gpx =
      '<?xml version="1.0"?><gpx version="1.1" creator="veetrax"><trk><trkseg>' +
      chunk.map((i) => `<trkpt lat="${points[i].lat}" lon="${points[i].lng}"><time>${new Date(points[i].t).toISOString()}</time></trkpt>`).join('') +
      '</trkseg></trk></gpx>';
    const res = await fetch(`${baseUrl}/match?profile=car&points_encoded=false&instructions=false&calc_points=true&gps_accuracy=${gpsAccuracy}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gpx+xml' },
      body: gpx,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { paths?: { points?: { coordinates?: number[][] } }[] };
    const coords = json.paths?.[0]?.points?.coordinates;
    if (!coords?.length) return null;
    for (const c of coords) {
      const last = line[line.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) line.push([c[0], c[1]]);
    }
  }
  return line.length >= 2 ? line : null;
}

/**
 * Distance (m) from a point to the matched road, searching the road's segments around `hint` (the matched road runs
 * in the same order as the track). Returns the distance and the nearest segment index (the next point's hint).
 */
export function distanceToRoad(lat: number, lng: number, road: [number, number][], hint: number, window = 80): { d: number; idx: number } {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  let bestIdx = hint;
  const from = Math.max(0, hint - window);
  const to = Math.min(road.length - 1, hint + window);
  for (let k = from; k < to; k++) {
    const ax = (road[k][0] - lng) * mLng;
    const ay = (road[k][1] - lat) * mLat;
    const bx = (road[k + 1][0] - lng) * mLng;
    const by = (road[k + 1][1] - lat) * mLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + u * dx, ay + u * dy);
    if (d < best) {
      best = d;
      bestIdx = k;
    }
  }
  if (road.length === 1) best = haversineMeters(lat, lng, road[0][1], road[0][0]);
  return { d: best, idx: bestIdx };
}

/** Length of a [lng, lat] line in metres. */
export function lineLengthM(line: [number, number][]): number {
  let m = 0;
  for (let k = 1; k < line.length; k++) m += haversineMeters(line[k - 1][1], line[k - 1][0], line[k][1], line[k][0]);
  return m;
}
