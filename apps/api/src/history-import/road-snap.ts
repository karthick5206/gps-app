/**
 * Road snapping for imported history. Old platform exports keep about one point a minute while moving, so straight
 * lines between them cut corners (VeeTrax's km came out ~3% low, more in towns). For each moving pair of imported
 * points we ask the routing engine for the road between them and, when that road is plausible for the time between
 * the points, add points along it (times spread by distance). The summarizer then measures along the road and History
 * plays back on it. Pure helpers here; the service does the I/O.
 */

const R = 6_371_000;
const rad = Math.PI / 180;

export function metres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function course(lat1: number, lng1: number, lat2: number, lng2: number): number {
  if (lat1 === lat2 && lng1 === lng2) return 0;
  const y = Math.sin((lng2 - lng1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad);
  return Math.round(((Math.atan2(y, x) / rad) % 360) + 360) % 360;
}

export interface SnapPoint {
  t: number;
  lat: number;
  lng: number;
  speedKph: number;
}

/** Spacing of the added points along the road (m). */
export const SNAP_SPACING_M = 120;
/** Pairs considered: between these many seconds apart … */
export const SNAP_MIN_SEC = 10;
export const SNAP_MAX_SEC = 15 * 60;
/** … and at least this far apart in a straight line (shorter hops gain nothing). */
export const SNAP_MIN_STRAIGHT_M = 100;
/** Highest plausible average speed along the road (km/h). */
export const SNAP_MAX_KPH = 160;

/** A pair worth snapping: moving (either end has speed, or it covered real ground) and a usable time gap. */
export function snapCandidate(a: SnapPoint, b: SnapPoint): boolean {
  const dt = (b.t - a.t) / 1000;
  if (dt < SNAP_MIN_SEC || dt > SNAP_MAX_SEC) return false;
  const straight = metres(a.lat, a.lng, b.lat, b.lng);
  if (straight < SNAP_MIN_STRAIGHT_M) return false;
  return a.speedKph > 2 || b.speedKph > 2 || straight / dt > 2;
}

/**
 * The road is believable for this pair: not a detour (at most 1.6 × the straight line, or +400 m on short hops),
 * not shorter than the straight line, and drivable in the time between the points.
 */
export function plausibleSnap(straightM: number, roadM: number, seconds: number): boolean {
  if (roadM < straightM * 0.98) return false;
  if (roadM > Math.max(straightM * 1.6, straightM + 400)) return false;
  return (roadM / Math.max(1, seconds)) * 3.6 <= SNAP_MAX_KPH;
}

/**
 * Points along the road shape ([lng, lat] pairs) every SNAP_SPACING_M, between a and b (both excluded), timed in
 * proportion to the distance along the road; speed = road length / time.
 */
export function pointsAlong(a: SnapPoint, b: SnapPoint, shape: [number, number][], roadM: number): (SnapPoint & { course: number })[] {
  if (shape.length < 2) return [];
  const lens: number[] = [0];
  for (let i = 1; i < shape.length; i++) lens.push(lens[i - 1] + metres(shape[i - 1][1], shape[i - 1][0], shape[i][1], shape[i][0]));
  const total = lens[lens.length - 1];
  if (total <= 0) return [];
  const dt = b.t - a.t;
  const speedKph = Math.round(((roadM || total) / (dt / 1000)) * 3.6 * 10) / 10;
  const out: (SnapPoint & { course: number })[] = [];
  let seg = 1;
  for (let d = SNAP_SPACING_M; d < total - SNAP_SPACING_M / 2; d += SNAP_SPACING_M) {
    while (seg < lens.length - 1 && lens[seg] < d) seg++;
    const f = (d - lens[seg - 1]) / Math.max(1e-9, lens[seg] - lens[seg - 1]);
    const [lng1, lat1] = shape[seg - 1];
    const [lng2, lat2] = shape[seg];
    const lat = lat1 + (lat2 - lat1) * f;
    const lng = lng1 + (lng2 - lng1) * f;
    const t = Math.round(a.t + (dt * d) / total);
    if (t <= a.t || t >= b.t) continue;
    out.push({ t, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, speedKph, course: course(lat1, lng1, lat2, lng2) });
  }
  return out;
}
