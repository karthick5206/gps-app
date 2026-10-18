import type { GeofenceGeometry, LatLng } from '@veetracer/shared';

const EARTH_M = 6_371_008.8;

/** Circle as a closed GeoJSON ring (64 points) for drawing. */
export function circleRing(center: LatLng, radiusM: number, steps = 64): [number, number][] {
  const lat = (center.lat * Math.PI) / 180;
  const d = radiusM / EARTH_M;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const brng = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brng));
    const lng2 = (center.lng * Math.PI) / 180 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    ring.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}

/** GeoJSON for a geofence (fill + outline); polygons with < 3 points render as their vertices only. */
export function geometryFeature(g: GeofenceGeometry): GeoJSON.Feature | null {
  if (g.type === 'CIRCLE') return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(g.center, g.radiusM)] }, properties: {} };
  if (g.points.length < 3) return null;
  const ring = g.points.map((p) => [p.lng, p.lat] as [number, number]);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: {} };
}

/** [west, south, east, north] around a geometry. */
export function geometryBounds(g: GeofenceGeometry): [number, number, number, number] {
  const pts = g.type === 'CIRCLE' ? circleRing(g.center, g.radiusM, 16).map(([lng, lat]) => ({ lat, lng })) : g.points;
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of pts) {
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [w, s, e, n];
}

export function describeGeometry(g: GeofenceGeometry): string {
  return g.type === 'CIRCLE' ? `Circle · ${g.radiusM >= 1000 ? `${(g.radiusM / 1000).toFixed(1)} km` : `${Math.round(g.radiusM)} m`}` : `Polygon · ${g.points.length} points`;
}
