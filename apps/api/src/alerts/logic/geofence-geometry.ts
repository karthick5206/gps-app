import { GeofenceGeometry, LatLng } from '@veetracer/shared';
import { haversineMeters } from '../../tracking/geo';

export const GEOFENCE_BUFFER_M = 15;
export const CIRCLE_MIN_RADIUS_M = 20;
export const CIRCLE_MAX_RADIUS_M = 50_000;
export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 500;

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_EQ = 111_320;

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const validLatLng = (p: unknown): p is LatLng =>
  typeof p === 'object' &&
  p !== null &&
  typeof (p as LatLng).lat === 'number' &&
  typeof (p as LatLng).lng === 'number' &&
  Math.abs((p as LatLng).lat) <= 90 &&
  Math.abs((p as LatLng).lng) <= 180;

/** Returns an error message, or null when the geometry is acceptable. */
export function validateGeometry(g: unknown): string | null {
  if (typeof g !== 'object' || g === null) return 'Geometry is required';
  const geo = g as Record<string, unknown>;
  if (geo.type === 'CIRCLE') {
    if (!validLatLng(geo.center)) return 'Circle centre must be {lat, lng}';
    const r = geo.radiusM;
    if (typeof r !== 'number' || !Number.isFinite(r)) return 'Circle radius is required';
    if (r < CIRCLE_MIN_RADIUS_M || r > CIRCLE_MAX_RADIUS_M) return `Circle radius must be between ${CIRCLE_MIN_RADIUS_M} m and 50 km`;
    return null;
  }
  if (geo.type === 'POLYGON' || geo.type === 'RECTANGLE') {
    if (!Array.isArray(geo.points) || !geo.points.every(validLatLng)) return 'Points must be a list of {lat, lng}';
    const n = geo.points.length;
    if (geo.type === 'RECTANGLE' && n !== 4) return 'A rectangle needs exactly 4 points';
    if (geo.type === 'POLYGON' && (n < POLYGON_MIN_POINTS || n > POLYGON_MAX_POINTS)) {
      return `A polygon needs ${POLYGON_MIN_POINTS}–${POLYGON_MAX_POINTS} points`;
    }
    return null;
  }
  return 'Geometry type must be CIRCLE, POLYGON or RECTANGLE';
}

/** Normalise a validated geometry (drops unknown keys, closes nothing — rings are implicitly closed). */
export function cleanGeometry(g: GeofenceGeometry): GeofenceGeometry {
  if (g.type === 'CIRCLE') return { type: 'CIRCLE', center: { lat: g.center.lat, lng: g.center.lng }, radiusM: g.radiusM };
  let points = g.points.map((p) => ({ lat: p.lat, lng: p.lng }));
  // Drop an explicit closing point (GeoJSON style).
  if (points.length > 3 && points[0].lat === points[points.length - 1].lat && points[0].lng === points[points.length - 1].lng) {
    points = points.slice(0, -1);
  }
  return { type: g.type, points };
}

export function geometryBBox(g: GeofenceGeometry): BBox {
  if (g.type === 'CIRCLE') {
    const dLat = g.radiusM / M_PER_DEG_LAT;
    const dLng = g.radiusM / (M_PER_DEG_LNG_EQ * Math.max(Math.cos((g.center.lat * Math.PI) / 180), 0.01));
    return { minLat: g.center.lat - dLat, maxLat: g.center.lat + dLat, minLng: g.center.lng - dLng, maxLng: g.center.lng + dLng };
  }
  const lats = g.points.map((p) => p.lat);
  const lngs = g.points.map((p) => p.lng);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

/** Is the point within the bbox grown by `marginM` metres? Cheap pre-filter before the exact test. */
export function inBBox(b: BBox, lat: number, lng: number, marginM = 0): boolean {
  const dLat = marginM / M_PER_DEG_LAT;
  const dLng = marginM / (M_PER_DEG_LNG_EQ * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return lat >= b.minLat - dLat && lat <= b.maxLat + dLat && lng >= b.minLng - dLng && lng <= b.maxLng + dLng;
}

/**
 * Signed distance in metres from the point to the geofence boundary: negative inside, positive outside.
 * Polygons use a local equirectangular projection (accurate to well under a metre at geofence scales).
 */
export function signedDistanceM(g: GeofenceGeometry, lat: number, lng: number): number {
  if (g.type === 'CIRCLE') return haversineMeters(lat, lng, g.center.lat, g.center.lng) - g.radiusM;
  const kx = M_PER_DEG_LNG_EQ * Math.cos((lat * Math.PI) / 180);
  const pts = g.points.map((p) => ({ x: (p.lng - lng) * kx, y: (p.lat - lat) * M_PER_DEG_LAT }));
  let inside = false;
  let minD2 = Number.POSITIVE_INFINITY;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    // Ray cast from the origin (the point) along +x.
    if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    // Distance from origin to segment ab.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2)) : 0;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    minD2 = Math.min(minD2, cx * cx + cy * cy);
  }
  const d = Math.sqrt(minD2);
  return inside ? -d : d;
}

export function containsPoint(g: GeofenceGeometry, lat: number, lng: number): boolean {
  return signedDistanceM(g, lat, lng) <= 0;
}

/** Membership tracked per object and geofence, with anti-flapping. */
export interface MembershipState {
  inside: boolean;
  /** Epoch ms of the last flip (enter or exit), or of the first observation. */
  since: number;
  /** Consecutive points disagreeing with `inside`. */
  pendingCount: number;
  /** Fix time of the first disagreeing point (becomes the enter/exit time when the flip is confirmed). */
  pendingSince: number | null;
}

export type MembershipEvent = 'ENTER' | 'EXIT' | 'INIT_INSIDE' | 'INIT_OUTSIDE' | null;

export const FLIP_CONFIRM_POINTS = 2;

/**
 * Hysteresis + confirmation: an outside object is "candidate inside" when the point is inside the shape; an inside
 * object is "candidate outside" only when it is more than `bufferM` outside the boundary. A flip needs
 * FLIP_CONFIRM_POINTS consecutive candidate points; the flip time is the first of them.
 */
export function updateMembership(
  prev: MembershipState | undefined,
  distanceM: number,
  fixTime: number,
  bufferM = GEOFENCE_BUFFER_M,
): { state: MembershipState; event: MembershipEvent; at: number } {
  if (!prev) {
    const inside = distanceM <= 0;
    return {
      state: { inside, since: fixTime, pendingCount: 0, pendingSince: null },
      event: inside ? 'INIT_INSIDE' : 'INIT_OUTSIDE',
      at: fixTime,
    };
  }
  const candidateFlip = prev.inside ? distanceM > bufferM : distanceM <= 0;
  if (!candidateFlip) {
    return { state: { ...prev, pendingCount: 0, pendingSince: null }, event: null, at: fixTime };
  }
  const pendingCount = prev.pendingCount + 1;
  const pendingSince = prev.pendingSince ?? fixTime;
  if (pendingCount < FLIP_CONFIRM_POINTS) {
    return { state: { ...prev, pendingCount, pendingSince }, event: null, at: fixTime };
  }
  const inside = !prev.inside;
  return {
    state: { inside, since: pendingSince, pendingCount: 0, pendingSince: null },
    event: inside ? 'ENTER' : 'EXIT',
    at: pendingSince,
  };
}
