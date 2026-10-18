/**
 * Pure geofence geometry helpers (no imports, so they run under node --test).
 * Coordinates are WGS84 degrees; distances are metres on a spherical earth (good to ~0.5 % at city scale).
 */

export interface Pt {
  lat: number;
  lng: number;
}

export type Geometry =
  | { type: 'CIRCLE'; center: Pt; radiusM: number }
  | { type: 'POLYGON' | 'RECTANGLE'; points: Pt[] };

export const EARTH_RADIUS_M = 6_371_008.8;
export const MIN_RADIUS_M = 20;
export const MAX_RADIUS_M = 50_000;
export const MAX_POLYGON_POINTS = 500;

const RAD = Math.PI / 180;

export function haversineM(a: Pt, b: Pt): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Point reached from `origin` after `distanceM` on initial bearing `bearingDeg` (great circle). */
export function destination(origin: Pt, distanceM: number, bearingDeg: number): Pt {
  const d = distanceM / EARTH_RADIUS_M;
  const brg = bearingDeg * RAD;
  const lat1 = origin.lat * RAD;
  const lng1 = origin.lng * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lng2 = lng1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / RAD, lng: ((((lng2 / RAD) + 540) % 360) - 180) };
}

/** Circle as a closed ring of `steps` vertices (+ closing vertex), as GeoJSON [lng, lat] pairs. */
export function circleRing(center: Pt, radiusM: number, steps = 64): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const p = destination(center, radiusM, (360 * i) / steps);
    ring.push([p.lng, p.lat]);
  }
  ring.push(ring[0]);
  return ring;
}

/** Axis-aligned rectangle (in lat/lng) spanned by two opposite corners: NW, NE, SE, SW. */
export function rectangleFromCorners(a: Pt, b: Pt): Pt[] {
  const north = Math.max(a.lat, b.lat);
  const south = Math.min(a.lat, b.lat);
  const west = Math.min(a.lng, b.lng);
  const east = Math.max(a.lng, b.lng);
  return [
    { lat: north, lng: west },
    { lat: north, lng: east },
    { lat: south, lng: east },
    { lat: south, lng: west },
  ];
}

/** Closed GeoJSON ring for a list of vertices (closing vertex appended). */
export function closedRing(points: Pt[]): [number, number][] {
  const ring = points.map((p) => [p.lng, p.lat] as [number, number]);
  if (ring.length) ring.push(ring[0]);
  return ring;
}

export function geometryRing(g: Geometry, steps = 64): [number, number][] {
  return g.type === 'CIRCLE' ? circleRing(g.center, g.radiusM, steps) : closedRing(g.points);
}

/** Ray-casting point-in-polygon on lng/lat (fine for the small, non-polar shapes of geofences). */
export function pointInPolygon(p: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.lat > p.lat !== b.lat > p.lat;
    if (crosses && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(p: Pt, g: Geometry): boolean {
  return g.type === 'CIRCLE' ? haversineM(p, g.center) <= g.radiusM : pointInPolygon(p, g.points);
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function bbox(g: Geometry): BBox {
  if (g.type === 'CIRCLE') {
    const n = destination(g.center, g.radiusM, 0);
    const e = destination(g.center, g.radiusM, 90);
    const s = destination(g.center, g.radiusM, 180);
    const w = destination(g.center, g.radiusM, 270);
    return { west: w.lng, south: s.lat, east: e.lng, north: n.lat };
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of g.points) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return { west, south, east, north };
}

/** Label anchor: circle centre, else the vertex average (adequate for convex-ish zones). */
export function labelPoint(g: Geometry): Pt {
  if (g.type === 'CIRCLE') return g.center;
  const n = g.points.length || 1;
  return {
    lat: g.points.reduce((s, p) => s + p.lat, 0) / n,
    lng: g.points.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** Area in m² (circle exact; polygon via spherical excess approximation on an equirectangular projection). */
export function areaM2(g: Geometry): number {
  if (g.type === 'CIRCLE') return Math.PI * g.radiusM ** 2;
  const pts = g.points;
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const kx = EARTH_RADIUS_M * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_RADIUS_M * RAD;
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += pts[j].lng * kx * (pts[i].lat * ky) - pts[i].lng * kx * (pts[j].lat * ky);
  }
  return Math.abs(sum / 2);
}

export function translate(g: Geometry, dLat: number, dLng: number): Geometry {
  if (g.type === 'CIRCLE') return { ...g, center: { lat: g.center.lat + dLat, lng: g.center.lng + dLng } };
  return { ...g, points: g.points.map((p) => ({ lat: p.lat + dLat, lng: p.lng + dLng })) };
}

export function clampRadius(r: number): number {
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(r)));
}

/** Validation message for a geometry, or null when acceptable for the API (radius 20 m–50 km, polygon 3–500 points, rectangle 4). */
export function validateGeometry(g: Geometry | null, tr: Translate = plain): string | null {
  if (!g) return tr('Draw the geofence on the map');
  if (g.type === 'CIRCLE') {
    if (!Number.isFinite(g.radiusM) || g.radiusM < MIN_RADIUS_M || g.radiusM > MAX_RADIUS_M) return tr('Radius must be between 20 m and 50 km');
    return null;
  }
  if (g.type === 'RECTANGLE' && g.points.length !== 4) return tr('A rectangle needs 4 corners');
  if (g.points.length < 3) return tr('A polygon needs at least 3 points');
  if (g.points.length > MAX_POLYGON_POINTS) return tr('A polygon can have at most {{count}} points', { count: String(MAX_POLYGON_POINTS) });
  return null;
}

/** Translator for UI text; the default fills `{{vars}}` into the English key (keeps this file import-free for tests). */
export type Translate = (key: string, vars?: Record<string, string>) => string;
const plain: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars?.[k] ?? '');

/** Human size: "300 m", "1.2 km", "4.5 ha", "2.1 km²". */
export function formatRadius(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

export function formatArea(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(m2 >= 10_000_000 ? 0 : 1)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(1)} ha`;
  return `${Math.round(m2)} m²`;
}

/** Distance in metres from point p to segment ab (planar approximation around p). */
export function distanceToSegmentM(p: Pt, a: Pt, b: Pt): number {
  const kx = Math.cos(p.lat * RAD) * EARTH_RADIUS_M * RAD;
  const ky = EARTH_RADIUS_M * RAD;
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
