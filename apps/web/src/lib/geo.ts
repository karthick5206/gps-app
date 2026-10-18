/** Pure geo/animation helpers (no imports so they can be unit-tested with node --test). */

export interface Pose {
  lng: number;
  lat: number;
  bearing: number;
}

/** Normalises an angle to [0, 360). */
export function normalizeBearing(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** Interpolates between two bearings along the shortest arc (e.g. 350° → 10° passes through 0°). */
export function lerpBearing(from: number, to: number, t: number): number {
  const delta = ((normalizeBearing(to) - normalizeBearing(from) + 540) % 360) - 180;
  return normalizeBearing(from + delta * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ease-in-out cubic for marker glides. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function interpolatePose(from: Pose, to: Pose, t: number): Pose {
  const k = easeInOut(Math.min(1, Math.max(0, t)));
  return {
    lng: lerp(from.lng, to.lng, k),
    lat: lerp(from.lat, to.lat, k),
    bearing: lerpBearing(from.bearing, to.bearing, k),
  };
}
