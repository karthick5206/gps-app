import { GeofenceGeometry, LatLng, POI_CATEGORIES, POI_IMPORT_MAX_ITEMS, POI_MAX_RADIUS_M, POI_MIN_RADIUS_M, PoiImportFormat, PoiImportItem } from '@veetracer/shared';
import { unzipSync } from 'fflate';
import { CIRCLE_MIN_RADIUS_M, POLYGON_MAX_POINTS, POLYGON_MIN_POINTS } from '../alerts/logic/geofence-geometry';
import { simplifyToBudget } from '../history/simplify';
import { haversineMeters } from '../tracking/geo';
import { childOf, childrenOf, childText, findAll, findFirst, parseXml, XmlNode } from './xml';

/** Largest .kml accepted inside a .kmz once decompressed (zip-bomb guard). */
export const KMZ_MAX_UNCOMPRESSED = 25 * 1024 * 1024;

export class ImportFormatError extends Error {}

// ───────────── format detection ─────────────

export function detectFormat(fileName: string | undefined, buf: Buffer): PoiImportFormat {
  const ext = fileName?.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'kmz';
  if (ext === 'kmz') return 'kmz';
  if (ext === 'kml') return 'kml';
  if (ext === 'gpx') return 'gpx';
  if (ext === 'geojson' || ext === 'json') return 'geojson';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  const head = decode(buf.subarray(0, 4096)).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'geojson';
  if (head.startsWith('<')) return /<gpx[\s>]/i.test(head) ? 'gpx' : 'kml';
  return 'csv';
}

const decode = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('utf8').replace(/^﻿/, '');

/** Parse any supported file into preview items (nothing is saved). Throws ImportFormatError for unreadable files. */
export function parseImportFile(format: PoiImportFormat, buf: Buffer): PoiImportItem[] {
  let items: PoiImportItem[];
  try {
    switch (format) {
      case 'kmz':
        items = parseKml(kmlFromKmz(buf));
        break;
      case 'kml':
        items = parseKml(decode(buf));
        break;
      case 'gpx':
        items = parseGpx(decode(buf));
        break;
      case 'geojson':
        items = parseGeoJson(JSON.parse(decode(buf)));
        break;
      case 'csv':
        items = parseCsv(decode(buf));
        break;
    }
  } catch (error) {
    if (error instanceof ImportFormatError) throw error;
    throw new ImportFormatError(`Could not read the ${format.toUpperCase()} file: ${(error as Error).message}`);
  }
  if (!items.length) throw new ImportFormatError('The file contains no points or areas');
  if (items.length > POI_IMPORT_MAX_ITEMS) throw new ImportFormatError(`At most ${POI_IMPORT_MAX_ITEMS} items per import (the file has ${items.length})`);
  return items;
}

// ───────────── shared helpers ─────────────

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v.trim())) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const validLat = (v: number | null): v is number => v !== null && v >= -90 && v <= 90;
const validLng = (v: number | null): v is number => v !== null && v >= -180 && v <= 180;

/** "Fuel station" / "fuel-station" → FUEL_STATION. */
export function categoryCode(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const code = v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return code ? code.slice(0, 50) : undefined;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Trimmed single-line text; `html` strips markup (KML / GPX descriptions are often HTML). */
function cleanText(v: unknown, max: number, html = false): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = (html ? v.replace(/<[^>]*>/g, ' ') : v).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** A point item (POI) after coordinate / radius checks. */
function pointItem(
  index: number,
  name: string,
  lat: number | null,
  lng: number | null,
  extra: { category?: string; description?: string; color?: string; address?: string; radiusM?: number | null },
): PoiImportItem {
  const base = {
    index,
    name: name.slice(0, 100),
    category: extra.category,
    description: extra.description,
    color: extra.color && COLOR_RE.test(extra.color) ? extra.color : undefined,
    address: extra.address,
  };
  if (!validLat(lat) || !validLng(lng)) return { ...base, kind: null, error: 'Latitude / longitude missing or out of range' };
  if (lat === 0 && lng === 0) return { ...base, kind: null, error: 'Coordinates are 0, 0' };
  let warning: string | undefined;
  let radiusM: number | undefined;
  if (extra.radiusM !== undefined && extra.radiusM !== null) {
    radiusM = Math.round(extra.radiusM);
    if (radiusM < POI_MIN_RADIUS_M || radiusM > POI_MAX_RADIUS_M) {
      const clamped = Math.min(Math.max(radiusM, POI_MIN_RADIUS_M), POI_MAX_RADIUS_M);
      warning = `Radius ${radiusM} m adjusted to ${clamped} m`;
      radiusM = clamped;
    }
  }
  return { ...base, kind: 'POI', lat: round6(lat), lng: round6(lng), radiusM, error: null, ...(warning ? { warning } : {}) };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * An area item (geofence) from a polygon ring: drops the closing point, simplifies rings above the geofence point
 * limit and recognises circles drawn as polygons (many points, all about the same distance from the centre).
 */
function areaItem(
  index: number,
  name: string,
  ring: LatLng[],
  extra: { category?: string; description?: string; color?: string; address?: string },
): PoiImportItem {
  const base = {
    index,
    name: name.slice(0, 100),
    category: extra.category,
    description: extra.description,
    color: extra.color && COLOR_RE.test(extra.color) ? extra.color : undefined,
    address: extra.address,
  };
  let points = ring.filter((p) => validLat(p.lat) && validLng(p.lng));
  if (points.length !== ring.length) return { ...base, kind: null, error: 'Polygon has invalid coordinates' };
  if (points.length > 3 && samePoint(points[0], points[points.length - 1])) points = points.slice(0, -1);
  if (points.length < POLYGON_MIN_POINTS) return { ...base, kind: null, error: `A polygon needs at least ${POLYGON_MIN_POINTS} points` };
  const circle = asCircle(points);
  if (circle) return { ...base, kind: 'GEOFENCE', geometry: circle, error: null };
  let warning: string | undefined;
  if (points.length > POLYGON_MAX_POINTS) {
    const keep = simplifyToBudget(points.map((p) => p.lat), points.map((p) => p.lng), POLYGON_MAX_POINTS);
    warning = `Polygon simplified from ${points.length} to ${keep.length} points`;
    points = keep.map((i) => points[i]);
  }
  const geometry: GeofenceGeometry = { type: 'POLYGON', points: points.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) })) };
  return { ...base, kind: 'GEOFENCE', geometry, error: null, ...(warning ? { warning } : {}) };
}

const samePoint = (a: LatLng, b: LatLng) => a.lat === b.lat && a.lng === b.lng;

/** Polygon with ≥ 16 vertices all within 3 % of the mean distance from their centroid → circle. */
export function asCircle(points: LatLng[]): GeofenceGeometry | null {
  if (points.length < 16) return null;
  const c = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
  const d = points.map((p) => haversineMeters(c.lat, c.lng, p.lat, p.lng));
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  if (mean < CIRCLE_MIN_RADIUS_M || d.some((x) => Math.abs(x - mean) > mean * 0.03)) return null;
  return { type: 'CIRCLE', center: { lat: round6(c.lat), lng: round6(c.lng) }, radiusM: Math.round(mean) };
}

// ───────────── KML / KMZ ─────────────

/** The main .kml of a KMZ archive (doc.kml, else the first .kml at the shallowest level). */
export function kmlFromKmz(buf: Buffer): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
      filter: (f) => f.name.toLowerCase().endsWith('.kml') && f.originalSize <= KMZ_MAX_UNCOMPRESSED,
    });
  } catch (error) {
    throw new ImportFormatError(`Could not open the KMZ archive: ${(error as Error).message}`);
  }
  const names = Object.keys(files).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const main = names.find((n) => n.toLowerCase() === 'doc.kml') ?? names[0];
  if (!main) throw new ImportFormatError('The KMZ archive contains no .kml document');
  if (files[main].length > KMZ_MAX_UNCOMPRESSED) throw new ImportFormatError('The KML inside the KMZ is too large');
  return decode(files[main]);
}

/** KML `lng,lat[,alt]` tuples separated by whitespace. */
function kmlCoords(text: string | undefined): LatLng[] {
  if (!text) return [];
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const [lng, lat] = t.split(',').map((x) => Number(x));
      return { lat, lng };
    });
}

/** KML colours are aabbggrr. */
function kmlColor(placemark: XmlNode): string | undefined {
  const style = childOf(placemark, 'style');
  if (!style) return undefined;
  for (const kind of ['polystyle', 'iconstyle', 'linestyle']) {
    const c = childText(childOf(style, kind) ?? { name: '', attrs: {}, children: [], text: '' }, 'color');
    if (c && /^[0-9a-fA-F]{8}$/.test(c)) return `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}`.toLowerCase();
  }
  return undefined;
}

/** ExtendedData `<Data name="x"><value>` and `<SchemaData><SimpleData name="x">` as a lower-case key map. */
function kmlExtended(placemark: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  const ext = childOf(placemark, 'extendeddata');
  if (!ext) return out;
  for (const d of findAll(ext, 'data')) {
    const v = childText(d, 'value');
    if (d.attrs.name && v !== undefined) out[d.attrs.name.toLowerCase()] = v;
  }
  for (const d of findAll(ext, 'simpledata')) {
    if (d.attrs.name && d.text.trim()) out[d.attrs.name.toLowerCase()] = d.text.trim();
  }
  return out;
}

export function parseKml(text: string): PoiImportItem[] {
  const doc = parseXml(text);
  if (!findFirst(doc, 'kml') && !findFirst(doc, 'document') && !findFirst(doc, 'placemark')) throw new ImportFormatError('Not a KML document');
  const placemarks = findAll(doc, 'placemark');
  return placemarks.map((pm, i) => {
    const index = i + 1;
    const ext = kmlExtended(pm);
    const name = cleanText(childText(pm, 'name'), 100) ?? cleanText(ext.name, 100) ?? `Placemark ${index}`;
    const extra = {
      category: categoryCode(ext.category ?? ext.type),
      description: cleanText(childText(pm, 'description') ?? ext.description, 1000, true),
      color: kmlColor(pm) ?? (ext.color && COLOR_RE.test(ext.color) ? ext.color : undefined),
      address: cleanText(childText(pm, 'address') ?? ext.address, 300),
    };
    const polygon = findFirst(pm, 'polygon');
    if (polygon) {
      const outer = childOf(polygon, 'outerboundaryis') ?? polygon;
      const ring = kmlCoords(findFirst(outer, 'coordinates')?.text);
      return areaItem(index, name, ring, extra);
    }
    const point = findFirst(pm, 'point');
    if (point) {
      const [c] = kmlCoords(findFirst(point, 'coordinates')?.text);
      return pointItem(index, name, c ? c.lat : null, c ? c.lng : null, { ...extra, radiusM: num(ext.radius ?? ext.radiusm ?? ext.radius_m) });
    }
    if (findFirst(pm, 'linestring') || findFirst(pm, 'track')) {
      return { index, kind: null, name, error: 'Lines and tracks are not imported (draw an area around the route instead)' };
    }
    return { index, kind: null, name, error: 'Placemark has no point or polygon' };
  });
}

// ───────────── GPX ─────────────

/** GPX waypoints become POIs; tracks and routes are ignored. */
export function parseGpx(text: string): PoiImportItem[] {
  const doc = parseXml(text);
  const gpx = findFirst(doc, 'gpx');
  if (!gpx) throw new ImportFormatError('Not a GPX document');
  const wpts = childrenOf(gpx, 'wpt');
  if (!wpts.length && (childrenOf(gpx, 'trk').length || childrenOf(gpx, 'rte').length)) {
    throw new ImportFormatError('The GPX file has no waypoints (tracks and routes are not imported)');
  }
  return wpts.map((w, i) => {
    const index = i + 1;
    const name = cleanText(childText(w, 'name'), 100) ?? `Waypoint ${index}`;
    return pointItem(index, name, num(w.attrs.lat), num(w.attrs.lon), {
      category: categoryCode(childText(w, 'type')),
      description: cleanText(childText(w, 'desc') ?? childText(w, 'cmt'), 1000, true),
    });
  });
}

// ───────────── GeoJSON ─────────────

type Position = number[];

/** Point → POI (`radius` property = visit radius), Polygon / MultiPolygon (outer ring of the first) → geofence. */
export function parseGeoJson(input: unknown): PoiImportItem[] {
  const root = input as { type?: string; features?: unknown[] };
  const features = root?.type === 'FeatureCollection' && Array.isArray(root.features) ? root.features : root?.type === 'Feature' ? [root] : null;
  if (!features) throw new ImportFormatError('Expected a GeoJSON FeatureCollection');
  return features.map((raw, i) => {
    const index = i + 1;
    const f = raw as { geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null };
    const props = f?.properties ?? {};
    const name = cleanText(props.name ?? props.title ?? props.Name, 100) ?? `Feature ${index}`;
    const extra = {
      category: categoryCode(props.category ?? props.type),
      description: cleanText(props.description, 1000, true),
      color: typeof props.color === 'string' ? props.color : typeof props['marker-color'] === 'string' ? (props['marker-color'] as string) : undefined,
      address: cleanText(props.address, 300),
    };
    const g = f?.geometry;
    if (!g) return { index, kind: null, name, error: 'Feature has no geometry' };
    if (g.type === 'Point') {
      const c = g.coordinates as Position;
      return pointItem(index, name, Array.isArray(c) ? num(c[1]) : null, Array.isArray(c) ? num(c[0]) : null, { ...extra, radiusM: num(props.radius ?? props.radiusM ?? props.radius_m) });
    }
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const rings = (g.type === 'Polygon' ? g.coordinates : (g.coordinates as unknown[])?.[0]) as Position[][] | undefined;
      const ring = rings?.[0];
      if (!Array.isArray(ring)) return { index, kind: null, name, error: 'Polygon has no coordinates' };
      return areaItem(index, name, ring.map((p) => ({ lat: Number(p?.[1]), lng: Number(p?.[0]) })), extra);
    }
    return { index, kind: null, name, error: `Unsupported geometry type ${g.type ?? 'unknown'}` };
  });
}

// ───────────── CSV ─────────────

/** Split one CSV line (comma or semicolon), honouring double quotes. */
function splitCsv(line: string, sep: string): string[] {
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
    else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** CSV `name,lat,lng,category,address` (header optional; extra radius / description / color columns by header). */
export function parseCsv(text: string): PoiImportItem[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = !lines[0].includes(',') && lines[0].includes(';') ? ';' : ',';
  const header = splitCsv(lines[0], sep).map((h) => h.toLowerCase().replace(/[^a-z_]/g, ''));
  let cols: Record<'name' | 'lat' | 'lng' | 'category' | 'address' | 'radius' | 'description' | 'color', number> = {
    name: 0, lat: 1, lng: 2, category: 3, address: 4, radius: -1, description: -1, color: -1,
  };
  let start = 0;
  if (header.some((h) => ['name', 'lat', 'latitude', 'lng', 'lon', 'longitude'].includes(h))) {
    const idx = (...names: string[]) => header.findIndex((h) => names.includes(h));
    cols = {
      name: idx('name', 'title'),
      lat: idx('lat', 'latitude'),
      lng: idx('lng', 'lon', 'long', 'longitude'),
      category: idx('category', 'type'),
      address: idx('address'),
      radius: idx('radius', 'radiusm', 'radius_m'),
      description: idx('description', 'notes'),
      color: idx('color', 'colour'),
    };
    if (cols.lat < 0 || cols.lng < 0) throw new ImportFormatError('CSV needs lat and lng columns');
    start = 1;
  }
  const at = (f: string[], i: number) => (i >= 0 ? f[i] : undefined);
  return lines.slice(start).map((line, i) => {
    const f = splitCsv(line, sep);
    const index = i + 1;
    const name = cleanText(at(f, cols.name), 100) ?? `Row ${index + start}`;
    const lat = num(at(f, cols.lat));
    const lng = num(at(f, cols.lng));
    if (lat === null || lng === null) return { index, kind: null, name, error: `Row ${index + start}: expected name,lat,lng,category,address` };
    return pointItem(index, name, lat, lng, {
      category: categoryCode(at(f, cols.category)),
      address: cleanText(at(f, cols.address), 300),
      description: cleanText(at(f, cols.description), 1000, true),
      color: at(f, cols.color),
      radiusM: num(at(f, cols.radius)),
    });
  });
}

/** Category codes recognised for POIs when the company has no own lookups. */
export const DEFAULT_POI_CATEGORIES: readonly string[] = POI_CATEGORIES;
