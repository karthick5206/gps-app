import { GeofenceGeometry, LatLng } from '@veetracer/shared';
import { escapeXml } from './xml';

export interface ExportPoi {
  name: string;
  category: string;
  lat: number;
  lng: number;
  radiusM: number;
  color: string;
  address: string | null;
  description: string | null;
}

export interface ExportGeofence {
  name: string;
  category: string;
  color: string;
  description: string | null;
  geometry: GeofenceGeometry;
}

const M_PER_DEG_LAT = 111_320;

/** Circle as a 64-point ring (KML and GeoJSON have no circles); the radius is kept in the properties too. */
export function circleRing(center: LatLng, radiusM: number, n = 64): LatLng[] {
  const out: LatLng[] = [];
  const cos = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({
      lat: Math.round((center.lat + (radiusM * Math.cos(a)) / M_PER_DEG_LAT) * 1e6) / 1e6,
      lng: Math.round((center.lng + (radiusM * Math.sin(a)) / (M_PER_DEG_LAT * cos)) * 1e6) / 1e6,
    });
  }
  return out;
}

function ring(g: GeofenceGeometry): LatLng[] {
  const pts = g.type === 'CIRCLE' ? circleRing(g.center, g.radiusM) : g.points;
  return pts.length ? [...pts, pts[0]] : pts;
}

/** #rrggbb → KML aabbggrr with the given alpha. */
const kmlColor = (hex: string, alpha = 'ff') => `${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toLowerCase();

const data = (k: string, v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '' : `<Data name="${k}"><value>${escapeXml(String(v))}</value></Data>`;

export function toKml(title: string, pois: ExportPoi[], geofences: ExportGeofence[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', '<Document>', `<name>${escapeXml(title)}</name>`];
  if (pois.length) {
    out.push('<Folder><name>Points of interest</name>');
    for (const p of pois) {
      out.push(
        `<Placemark><name>${escapeXml(p.name)}</name>` +
          (p.description ? `<description>${escapeXml(p.description)}</description>` : '') +
          (p.address ? `<address>${escapeXml(p.address)}</address>` : '') +
          `<Style><IconStyle><color>${kmlColor(p.color)}</color></IconStyle></Style>` +
          `<ExtendedData>${data('category', p.category)}${data('radius', p.radiusM)}</ExtendedData>` +
          `<Point><coordinates>${p.lng},${p.lat}</coordinates></Point></Placemark>`,
      );
    }
    out.push('</Folder>');
  }
  if (geofences.length) {
    out.push('<Folder><name>Geofences</name>');
    for (const g of geofences) {
      const coords = ring(g.geometry).map((p) => `${p.lng},${p.lat}`).join(' ');
      out.push(
        `<Placemark><name>${escapeXml(g.name)}</name>` +
          (g.description ? `<description>${escapeXml(g.description)}</description>` : '') +
          `<Style><LineStyle><color>${kmlColor(g.color)}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(g.color, '40')}</color></PolyStyle></Style>` +
          `<ExtendedData>${data('category', g.category)}${data('shape', g.geometry.type)}${g.geometry.type === 'CIRCLE' ? data('radius', g.geometry.radiusM) : ''}</ExtendedData>` +
          `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
      );
    }
    out.push('</Folder>');
  }
  out.push('</Document>', '</kml>');
  return out.join('\n');
}

export function toGeoJson(pois: ExportPoi[], geofences: ExportGeofence[]): string {
  const features = [
    ...pois.map((p) => ({
      type: 'Feature',
      properties: { kind: 'poi', name: p.name, category: p.category, radius: p.radiusM, color: p.color, address: p.address, description: p.description },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
    ...geofences.map((g) => ({
      type: 'Feature',
      properties: {
        kind: 'geofence',
        name: g.name,
        category: g.category,
        color: g.color,
        description: g.description,
        shape: g.geometry.type,
        ...(g.geometry.type === 'CIRCLE' ? { radius: g.geometry.radiusM, center: [g.geometry.center.lng, g.geometry.center.lat] } : {}),
      },
      geometry: { type: 'Polygon', coordinates: [ring(g.geometry).map((p) => [p.lng, p.lat])] },
    })),
  ];
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 1);
}
