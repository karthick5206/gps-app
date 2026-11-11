import { LatLng } from '@veetracer/shared';
import { unavailable, type Unavailable } from '../provider/routing-provider';
import { INDIA_COVERAGE } from './india-coverage';

/**
 * Coverage validation (ported as is from the routing branch, doc 17 §5.1): the India polygon (Natural Earth 1:10m,
 * India point of view) plus, optionally, the extent of the GraphHopper graph (`ROUTING_GRAPH_BBOX`
 * "minLng,minLat,maxLng,maxLat", e.g. the clip box of the OSM extract; unset = whole polygon). A cheap input check
 * before any engine or optimiser call; the engine's own snapping still decides whether a road is near.
 *
 * The 1:10m coastline is generalised (up to a few hundred metres), so a point outside the polygon but within
 * COASTAL_TOLERANCE_M of its boundary is accepted.
 */
export const COASTAL_TOLERANCE_M = 1500;

export type CoverageIssue = 'OUTSIDE_INDIA' | 'OUTSIDE_GRAPH';

type Ring = readonly (readonly [number, number])[];
interface Poly {
  rings: Ring[];
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

const POLYS: Poly[] = INDIA_COVERAGE.map((rings) => {
  let minLng = 180;
  let minLat = 90;
  let maxLng = -180;
  let maxLat = -90;
  for (const [lng, lat] of rings[0]) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { rings: rings as Ring[], minLng, minLat, maxLng, maxLat };
});

/** Ray casting; `ring` is closed or open, [lng, lat]. */
function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and not inside a hole. */
function inPoly(lng: number, lat: number, p: Poly): boolean {
  if (lng < p.minLng || lng > p.maxLng || lat < p.minLat || lat > p.maxLat) return false;
  if (!inRing(lng, lat, p.rings[0])) return false;
  for (let h = 1; h < p.rings.length; h++) if (inRing(lng, lat, p.rings[h])) return false;
  return true;
}

/** Approximate metres from a point to a segment (equirectangular around the point; fine at < 50 km). */
function segDistM(lng: number, lat: number, a: readonly [number, number], b: readonly [number, number]): number {
  const k = Math.cos((lat * Math.PI) / 180) * 111_320;
  const ax = (a[0] - lng) * k;
  const ay = (a[1] - lat) * 110_574;
  const bx = (b[0] - lng) * k;
  const by = (b[1] - lat) * 110_574;
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Metres to the nearest India boundary edge considered (only polygons within `maxM` of the point; Infinity if none). Exact below `maxM`. */
export function distanceToIndiaBoundaryM(p: LatLng, maxM = COASTAL_TOLERANCE_M): number {
  const padLat = maxM / 110_574;
  const padLng = maxM / (Math.cos((p.lat * Math.PI) / 180) * 111_320);
  let best = Infinity;
  for (const poly of POLYS) {
    if (p.lng < poly.minLng - padLng || p.lng > poly.maxLng + padLng || p.lat < poly.minLat - padLat || p.lat > poly.maxLat + padLat) continue;
    for (const ring of poly.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        // Cheap reject: both ends far in latitude.
        if (Math.abs(ring[i][1] - p.lat) > padLat && Math.abs(ring[j][1] - p.lat) > padLat && Math.sign(ring[i][1] - p.lat) === Math.sign(ring[j][1] - p.lat)) continue;
        best = Math.min(best, segDistM(p.lng, p.lat, ring[j], ring[i]));
      }
    }
  }
  return best;
}

export function inIndia(p: LatLng): boolean {
  return POLYS.some((poly) => inPoly(p.lng, p.lat, poly)) || distanceToIndiaBoundaryM(p) <= COASTAL_TOLERANCE_M;
}

export function parseBbox(raw: string | undefined): [number, number, number, number] | null {
  if (!raw) return null;
  const v = raw.split(',').map(Number);
  return v.length === 4 && v.every(Number.isFinite) && v[0] < v[2] && v[1] < v[3] ? (v as [number, number, number, number]) : null;
}

/** null when the point is covered; otherwise why not. */
export function coverageIssue(p: LatLng, graphBbox = parseBbox(process.env.ROUTING_GRAPH_BBOX)): CoverageIssue | null {
  if (!inIndia(p)) return 'OUTSIDE_INDIA';
  if (graphBbox && (p.lng < graphBbox[0] || p.lat < graphBbox[1] || p.lng > graphBbox[2] || p.lat > graphBbox[3])) return 'OUTSIDE_GRAPH';
  return null;
}

/** The provider's typed failure for an uncovered point (doc 06 §3: `OUTSIDE_COVERAGE`, never an invented number). */
export function coverageUnavailable(p: LatLng, graphBbox = parseBbox(process.env.ROUTING_GRAPH_BBOX)): Unavailable | null {
  const issue = coverageIssue(p, graphBbox);
  if (!issue) return null;
  return unavailable('OUTSIDE_COVERAGE', issue === 'OUTSIDE_INDIA' ? 'The point is outside India' : 'The point is outside the routing graph');
}
