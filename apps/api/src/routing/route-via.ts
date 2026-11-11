import { haversineMeters } from '../tracking/geo';
import { decodePolyline } from './route-estimate';

export interface ViaPoint {
  lat: number;
  lng: number;
}

export interface RouteViaLeg {
  distanceM: number;
  durationSec: number;
}

/** Road route through all points in order. `path` is [lng, lat] (GeoJSON order, as stored on Route.path). */
export interface RouteViaResult {
  path: [number, number][];
  distanceM: number;
  durationSec: number;
  /** One per consecutive point pair. */
  legs: RouteViaLeg[];
}

/** Whole-route part of a GraphHopper `GET /route` answer (distance m, time ms, polyline). Null when unusable. */
export function parseGraphHopperRoute(json: unknown): { path: [number, number][]; distanceM: number; durationSec: number } | null {
  const path = (json as { paths?: { distance?: unknown; time?: unknown; points?: unknown; points_encoded_multiplier?: unknown }[] } | null)?.paths?.[0];
  if (!path || typeof path.points !== 'string' || typeof path.distance !== 'number' || typeof path.time !== 'number') return null;
  const multiplier = typeof path.points_encoded_multiplier === 'number' ? path.points_encoded_multiplier : 1e5;
  // decodePolyline already yields [lng, lat].
  const coords = decodePolyline(path.points, Math.round(Math.log10(multiplier)));
  if (coords.length < 2) return null;
  return { path: coords, distanceM: Math.round(path.distance), durationSec: Math.round(path.time / 1000) };
}

/** Valhalla `POST /route` with several locations: one leg per pair, shapes joined (shared ends not repeated). */
export function parseValhallaTrip(json: unknown, pointCount: number): RouteViaResult | null {
  const legs = (json as { trip?: { legs?: { shape?: unknown; summary?: { length?: unknown; time?: unknown } }[] } } | null)?.trip?.legs;
  if (!Array.isArray(legs) || legs.length !== pointCount - 1) return null;
  const path: [number, number][] = [];
  const out: RouteViaLeg[] = [];
  for (const leg of legs) {
    const km = leg.summary?.length;
    const sec = leg.summary?.time;
    if (typeof leg.shape !== 'string' || typeof km !== 'number' || typeof sec !== 'number') return null;
    const coords = decodePolyline(leg.shape);
    path.push(...(path.length ? coords.slice(1) : coords));
    out.push({ distanceM: Math.round(km * 1000), durationSec: Math.round(sec) });
  }
  if (path.length < 2) return null;
  return {
    path,
    distanceM: out.reduce((s, l) => s + l.distanceM, 0),
    durationSec: out.reduce((s, l) => s + l.durationSec, 0),
    legs: out,
  };
}

/**
 * Legs when per-pair routes are missing: the whole route's distance / time split in proportion to the straight-line
 * length of each pair (a leg that was routed keeps its own values).
 */
export function fillLegs(points: ViaPoint[], legs: (RouteViaLeg | null)[], totalM: number, totalSec: number): RouteViaLeg[] {
  const straight = points.slice(1).map((p, i) => haversineMeters(points[i].lat, points[i].lng, p.lat, p.lng));
  const knownM = legs.reduce((s, l) => s + (l?.distanceM ?? 0), 0);
  const knownSec = legs.reduce((s, l) => s + (l?.durationSec ?? 0), 0);
  const missingStraight = straight.reduce((s, d, i) => s + (legs[i] ? 0 : d), 0);
  const restM = Math.max(0, totalM - knownM);
  const restSec = Math.max(0, totalSec - knownSec);
  const missingCount = legs.filter((l) => !l).length;
  return legs.map((leg, i) => {
    if (leg) return leg;
    const share = missingStraight > 0 ? straight[i] / missingStraight : 1 / missingCount;
    return { distanceM: Math.round(restM * share), durationSec: Math.round(restSec * share) };
  });
}
