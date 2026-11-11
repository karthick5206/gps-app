/**
 * Where the route simulator gets its stops and road path: `--stops`, a route file (the shape of GET /api/routes/:id),
 * a path file ([lng,lat][] or a GraphHopper /route response), or a live GraphHopper.
 */
import { decodePolyline } from '../routing/route-estimate';
import { DEFAULT_RADIUS_M, LngLat, RouteStop } from './route-drive';

export interface RouteSource {
  stops: RouteStop[];
  /** null = straight lines between the stops. */
  path: LngLat[] | null;
  corridorM?: number;
}

const num = (v: unknown, what: string): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${what} must be a number`);
  return n;
};

/** `"lat,lng;lat,lng;..."` → stops named Stop 1..n (no dwell). */
export function parseStopsArg(raw: string, waitSec = 0): RouteStop[] {
  const stops = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair, i) => {
      const [lat, lng] = pair.split(',').map((v) => num(v.trim(), `--stops point ${i + 1}`));
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error(`--stops point ${i + 1} is not "lat,lng"`);
      return { name: `Stop ${i + 1}`, lat, lng, waitSec, radiusM: DEFAULT_RADIUS_M };
    });
  if (stops.length < 2) throw new Error('--stops needs at least 2 "lat,lng" points separated by ";"');
  return stops;
}

/**
 * A path in any of the accepted forms: `[[lng,lat], ...]`, a GeoJSON LineString, or a GraphHopper `/route`
 * response (`points_encoded=false` coordinates, or an encoded polyline).
 */
export function parsePath(json: unknown): LngLat[] {
  if (Array.isArray(json)) {
    const path = json.map((p, i) => {
      if (!Array.isArray(p) || p.length < 2) throw new Error(`path point ${i} is not [lng, lat]`);
      return [num(p[0], `path[${i}][0]`), num(p[1], `path[${i}][1]`)] as LngLat;
    });
    if (path.length < 2) throw new Error('A path needs at least 2 points');
    if (path.some(([lng, lat]) => Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw new Error('path points must be [lng, lat]');
    return path;
  }
  const o = json as { type?: string; coordinates?: unknown; paths?: { points?: unknown; points_encoded_multiplier?: number }[] };
  if (o && o.type === 'LineString') return parsePath(o.coordinates);
  const gh = o?.paths?.[0];
  if (gh) {
    const pts = gh.points as { coordinates?: unknown } | string | undefined;
    if (typeof pts === 'string') return parsePath(decodePolyline(pts, Math.round(Math.log10(gh.points_encoded_multiplier ?? 1e5))));
    if (pts && typeof pts === 'object') return parsePath(pts.coordinates);
  }
  throw new Error('Unrecognised path: expected [[lng,lat],...], a GeoJSON LineString or a GraphHopper /route response');
}

/**
 * A route file `{ stops: [{name, lat, lng, radiusM?, offsetMin?, waitMin? | waitSec?}], path?, corridorM? }`,
 * as returned by GET /api/routes/:id (a `{ data: {...} }` wrapper is accepted too).
 */
export function parseRouteFile(json: unknown): RouteSource {
  const root = json as { data?: unknown; stops?: unknown };
  const r = (root && !root.stops && root.data ? root.data : root) as {
    stops?: Record<string, unknown>[];
    path?: unknown;
    corridorM?: unknown;
  };
  if (!r || !Array.isArray(r.stops) || r.stops.length < 2) throw new Error('Route file needs "stops" with at least 2 entries');
  const stops: RouteStop[] = r.stops.map((s, i) => ({
    name: typeof s.name === 'string' && s.name ? s.name : `Stop ${i + 1}`,
    lat: num(s.lat, `stops[${i}].lat`),
    lng: num(s.lng, `stops[${i}].lng`),
    waitSec: s.waitSec !== undefined ? num(s.waitSec, `stops[${i}].waitSec`) : s.waitMin !== undefined ? num(s.waitMin, `stops[${i}].waitMin`) * 60 : 0,
    radiusM: s.radiusM !== undefined && s.radiusM !== null ? num(s.radiusM, `stops[${i}].radiusM`) : DEFAULT_RADIUS_M,
    offsetMin: s.offsetMin !== undefined && s.offsetMin !== null ? num(s.offsetMin, `stops[${i}].offsetMin`) : undefined,
  }));
  return {
    stops,
    path: r.path === undefined || r.path === null ? null : parsePath(r.path),
    corridorM: r.corridorM !== undefined && r.corridorM !== null ? num(r.corridorM, 'corridorM') : undefined,
  };
}

/** GraphHopper road path through the stops, in order. */
export async function fetchGraphHopperPath(routerUrl: string, stops: RouteStop[]): Promise<LngLat[]> {
  const q = new URLSearchParams({ profile: 'car', points_encoded: 'false', instructions: 'false', calc_points: 'true' });
  for (const s of stops) q.append('point', `${s.lat},${s.lng}`);
  const url = `${routerUrl.replace(/\/+$/, '')}/route?${q}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GraphHopper ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parsePath(await res.json());
}
