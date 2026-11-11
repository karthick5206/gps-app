/**
 * Map features of a planned trip, built from its snapshot (pure, for `node --test`): the planned path (`path` in
 * [lng, lat], or straight legs between the stops when null), numbered stops with their arrival radius as circles,
 * the corridor band width and the deviation stretches of the actual track.
 */
import type { PlannedTripDto, PlannedTripEventDto, RoutePath, TrackPoint } from '@veetracer/shared';
import { stopTiming, type StopTiming } from './trip-format.ts';

type LngLat = [number, number];
/** Minimal GeoJSON shapes (structurally GeoJSON; local so the tests need no @types/geojson). */
export type PlanGeometry = { type: 'LineString'; coordinates: LngLat[] } | { type: 'Polygon'; coordinates: LngLat[][] } | { type: 'Point'; coordinates: LngLat };
export interface PlanFeature<P = PlanFeatureProps> {
  type: 'Feature';
  geometry: PlanGeometry;
  properties: P;
}
export interface PlanCollection {
  type: 'FeatureCollection';
  features: PlanFeature<PlanFeatureProps | { kind: 'deviation' }>[];
}
const EARTH_M = 6_371_008.8;
/** Metres per pixel at zoom 0 on the equator for MapLibre's 512 px tiles. */
const M_PER_PX_Z0 = 40_075_016.686 / 512;

/** Colour key of a stop on the map: its timing, or `next` for the stop the vehicle is heading to. */
export type StopTone = StopTiming | 'next';

export interface PlanFeatureProps {
  kind: 'plan' | 'radius' | 'stop';
  seq?: number;
  label?: string;
  name?: string;
  tone?: StopTone;
}

/**
 * Stops with a position. An employee-transport (ETMS) trip read here has none: its stops can be passengers' homes, so
 * the API sends labels only (E3 security review H1) and the map shows the vehicle track without stops.
 */
export function locatedStops<T extends { lat: number | null; lng: number | null }>(stops: readonly T[]): (T & { lat: number; lng: number })[] {
  return stops.filter((s): s is T & { lat: number; lng: number } => s.lat !== null && s.lng !== null);
}

/** The planned line: the road path when it has at least two points, else straight legs between the stops. */
export function plannedLine(trip: Pick<PlannedTripDto, 'path' | 'stops'>): LngLat[] {
  const path: RoutePath | null = trip.path;
  if (path && path.length > 1) return path.map(([lng, lat]) => [lng, lat]);
  return locatedStops(trip.stops)
    .sort((a, b) => a.seq - b.seq)
    .map((s) => [s.lng, s.lat]);
}

/** Closed ring approximating a circle of `radiusM` around a point. */
export function circleRing(lng: number, lat: number, radiusM: number, steps = 48): LngLat[] {
  const ring: LngLat[] = [];
  const latR = (lat * Math.PI) / 180;
  const dLat = (radiusM / EARTH_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos(latR));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

export function stopTone(trip: Pick<PlannedTripDto, 'status' | 'nextStopSeq'>, stop: PlannedTripDto['stops'][number]): StopTone {
  if ((trip.status === 'STARTED' || trip.status === 'IN_PROGRESS') && trip.nextStopSeq === stop.seq && stop.status === 'PENDING') return 'next';
  return stopTiming(stop);
}

/** Planned line, radius circles and numbered stop points as one collection (props.kind tells them apart). */
export function buildPlanFeatures(trip: Pick<PlannedTripDto, 'path' | 'stops' | 'status' | 'nextStopSeq'>): PlanCollection {
  const features: PlanFeature[] = [];
  const line = plannedLine(trip);
  if (line.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'plan' } });
  const stops = locatedStops(trip.stops).sort((a, b) => a.seq - b.seq);
  for (const s of stops) {
    const tone = stopTone(trip, s);
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(s.lng, s.lat, s.radiusM)] }, properties: { kind: 'radius', seq: s.seq, tone } });
  }
  for (const s of stops) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: { kind: 'stop', seq: s.seq, label: String(s.seq + 1), name: s.name, tone: stopTone(trip, s) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * MapLibre width expression for the corridor band: 2 × corridor metres in pixels at every zoom (exact with base-2
 * exponential interpolation), evaluated at the route's latitude.
 */
export function corridorWidth(corridorM: number, lat: number): unknown[] {
  const px0 = (2 * corridorM) / (M_PER_PX_Z0 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return ['interpolate', ['exponential', 2], ['zoom'], 0, px0, 24, px0 * 2 ** 24];
}

/** Mean latitude of the planned line (for the corridor width); 0 without points. */
export function lineLatitude(line: readonly LngLat[]): number {
  if (!line.length) return 0;
  return line.reduce((s, [, lat]) => s + lat, 0) / line.length;
}

/** Bounds of the planned line and stop circles: [[west, south], [east, north]], or null without stops. */
export function planBounds(trip: Pick<PlannedTripDto, 'path' | 'stops'>): [[number, number], [number, number]] | null {
  const pts: LngLat[] = plannedLine(trip);
  for (const s of locatedStops(trip.stops)) {
    const dLat = (s.radiusM / EARTH_M) * (180 / Math.PI);
    pts.push([s.lng, s.lat + dLat], [s.lng, s.lat - dLat]);
  }
  if (!pts.length) return null;
  let w = Infinity;
  let so = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of pts) {
    w = Math.min(w, lng);
    e = Math.max(e, lng);
    so = Math.min(so, lat);
    n = Math.max(n, lat);
  }
  return [
    [w, so],
    [e, n],
  ];
}

/**
 * The actual track during each deviation episode, as [lng, lat] lines (an open episode runs to the last point).
 * Episodes with fewer than two recorded points are left out (their start is still listed under Events).
 */
export function deviationSegments(points: readonly TrackPoint[], events: readonly Pick<PlannedTripEventDto, 'kind' | 'startAt' | 'endAt'>[]): LngLat[][] {
  const out: LngLat[][] = [];
  for (const e of events) {
    if (e.kind !== 'DEVIATION') continue;
    const from = Date.parse(e.startAt);
    const to = e.endAt ? Date.parse(e.endAt) : Infinity;
    const coords: LngLat[] = [];
    for (const p of points) if (p[0] >= from && p[0] <= to) coords.push([p[2], p[1]]);
    if (coords.length > 1) out.push(coords);
  }
  return out;
}

/** Deviation lines as features (kind `deviation`), drawn above the track. */
export function deviationFeatures(lines: readonly LngLat[][]): PlanFeature<{ kind: 'deviation' }>[] {
  return lines.map((coordinates) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { kind: 'deviation' } }));
}
