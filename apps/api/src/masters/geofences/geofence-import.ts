import { GeofenceGeometry } from '@veetracer/shared';

export interface ImportItem {
  index: number;
  name: string;
  geometry: GeofenceGeometry | null;
  error: string | null;
  category?: string;
  color?: string;
  description?: string;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Split one CSV line, honouring double quotes. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** CSV `name,lat,lng,radiusM` (header row optional; `radius` accepted as a header alias). */
export function parseCsvGeofences(text: string): ImportItem[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  let cols = { name: 0, lat: 1, lng: 2, radius: 3 };
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
  let start = 0;
  if (header.includes('name') || header.includes('lat')) {
    const idx = (...names: string[]) => header.findIndex((h) => names.includes(h));
    cols = { name: idx('name'), lat: idx('lat', 'latitude'), lng: idx('lng', 'lon', 'long', 'longitude'), radius: idx('radiusm', 'radius', 'radius_m') };
    start = 1;
  }
  return lines.slice(start).map((line, i) => {
    const f = splitCsv(line);
    const name = (cols.name >= 0 ? f[cols.name] : '') || `Imported ${i + 1}`;
    const lat = num(f[cols.lat]);
    const lng = num(f[cols.lng]);
    const radiusM = num(f[cols.radius]);
    if (lat === null || lng === null || radiusM === null) {
      return { index: i + 1, name, geometry: null, error: 'Expected name,lat,lng,radiusM' };
    }
    return { index: i + 1, name, geometry: { type: 'CIRCLE', center: { lat, lng }, radiusM }, error: null };
  });
}

type Position = number[];

/** GeoJSON FeatureCollection (or a single Feature): Polygon / MultiPolygon (first ring) and Point with `radius`/`radiusM`. */
export function parseGeoJsonGeofences(input: unknown): ImportItem[] {
  const root = input as { type?: string; features?: unknown[] };
  const features = root?.type === 'FeatureCollection' && Array.isArray(root.features) ? root.features : root?.type === 'Feature' ? [root] : null;
  if (!features) throw new Error('Expected a GeoJSON FeatureCollection');
  return features.map((raw, i) => {
    const f = raw as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> | null };
    const props = f.properties ?? {};
    const name = (typeof props.name === 'string' && props.name.trim()) || (typeof props.title === 'string' && props.title.trim()) || `Imported ${i + 1}`;
    const extra = {
      category: typeof props.category === 'string' ? props.category : undefined,
      color: typeof props.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(props.color) ? props.color : undefined,
      description: typeof props.description === 'string' ? props.description.slice(0, 1000) : undefined,
    };
    const g = f.geometry;
    const base = { index: i + 1, name, ...extra };
    if (!g) return { ...base, geometry: null, error: 'Feature has no geometry' };
    if (g.type === 'Point') {
      const c = g.coordinates as Position;
      const radiusM = num(props.radius ?? props.radiusM ?? props.radius_m);
      if (!Array.isArray(c) || radiusM === null) return { ...base, geometry: null, error: 'Point features need a "radius" property (metres)' };
      return { ...base, geometry: { type: 'CIRCLE', center: { lat: Number(c[1]), lng: Number(c[0]) }, radiusM }, error: null };
    }
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const rings = (g.type === 'Polygon' ? g.coordinates : (g.coordinates as unknown[])?.[0]) as Position[][] | undefined;
      const ring = rings?.[0];
      if (!Array.isArray(ring)) return { ...base, geometry: null, error: 'Polygon has no coordinates' };
      let points = ring.map((p) => ({ lat: Number(p[1]), lng: Number(p[0]) }));
      if (points.length > 3 && points[0].lat === points[points.length - 1].lat && points[0].lng === points[points.length - 1].lng) points = points.slice(0, -1);
      return { ...base, geometry: { type: 'POLYGON', points }, error: null };
    }
    return { ...base, geometry: null, error: `Unsupported geometry type ${g.type}` };
  });
}
