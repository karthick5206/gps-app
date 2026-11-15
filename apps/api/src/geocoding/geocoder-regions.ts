/**
 * Geocoder instances from the API environment (no imports from monitoring/, so map-services.ts can use it too).
 *
 *   GEOCODER_REGIONS='IN|http://127.0.0.1:2322|68,6,98,37;US|http://127.0.0.1:2323|-180,17,-65,72'
 *       several self-hosted Photon instances, one per region: `CODE|URL|minLon,minLat,maxLon,maxLat`, entries separated by
 *       `;`. Search asks every instance (each limited to its own bbox); reverse geocoding asks the first instance whose
 *       bbox contains the point. Takes precedence over GEOCODER_URL.
 *   GEOCODER_URL=http://127.0.0.1:2322
 *       one instance (the pre-v1.18 setting): region IN with the India bbox for Photon, the whole world for Nominatim.
 *
 * Every URL in either setting must be a loopback / private host (privateGeocoderProblem in geocoding.service.ts).
 */
export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export interface GeocoderRegion {
  /** Region code from the setting, upper case ("IN", "US"). */
  code: string;
  /** Base URL without a trailing slash. */
  url: string;
  bbox: Bbox;
}

/** India incl. Andaman & Nicobar and Lakshadweep: the bbox the single GEOCODER_URL instance has always searched. */
export const INDIA_BBOX: Bbox = [68, 6, 98, 37];
const WORLD_BBOX: Bbox = [-180, -90, 180, 90];

export interface GeocoderConfig {
  regions: GeocoderRegion[];
  /** Malformed GEOCODER_REGIONS entries (skipped; logged at start-up). */
  problems: string[];
}

function parseBbox(raw: string | undefined): Bbox | null {
  const n = (raw ?? '').split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || !(raw ?? '').trim()) return null;
  const [minLon, minLat, maxLon, maxLat] = n;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 || minLon >= maxLon || minLat >= maxLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

const trimUrl = (u: string): string => u.trim().replace(/\/+$/, '');

/** Raw `CODE|URL|bbox` entries of GEOCODER_REGIONS (empty when unset). */
export function rawRegionEntries(env: NodeJS.ProcessEnv): { code: string; url: string; bbox: string | undefined }[] {
  return (env.GEOCODER_REGIONS ?? '')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [code, url, bbox] = e.split('|');
      return { code: (code ?? '').trim().toUpperCase(), url: (url ?? '').trim(), bbox };
    });
}

export function geocoderConfig(env: NodeJS.ProcessEnv = process.env): GeocoderConfig {
  const provider = (env.GEOCODER ?? 'none').trim().toLowerCase();
  if (provider === 'none') return { regions: [], problems: [] };
  const entries = rawRegionEntries(env);
  if (entries.length && provider === 'photon') {
    const regions: GeocoderRegion[] = [];
    const problems: string[] = [];
    for (const e of entries) {
      const bbox = parseBbox(e.bbox);
      if (!/^[A-Z0-9_-]{1,12}$/.test(e.code)) problems.push(`GEOCODER_REGIONS entry "${e.code}": the region code must be 1–12 letters or digits`);
      else if (!e.url) problems.push(`GEOCODER_REGIONS entry ${e.code}: no URL`);
      else if (!bbox) problems.push(`GEOCODER_REGIONS entry ${e.code}: the bbox must be minLon,minLat,maxLon,maxLat`);
      else if (regions.some((r) => r.code === e.code)) problems.push(`GEOCODER_REGIONS entry ${e.code}: listed twice`);
      else regions.push({ code: e.code, url: trimUrl(e.url), bbox });
    }
    return { regions, problems };
  }
  const url = (env.GEOCODER_URL ?? '').trim();
  if (!url) return { regions: [], problems: [] };
  return { regions: [{ code: provider === 'photon' ? 'IN' : 'ALL', url: trimUrl(url), bbox: provider === 'photon' ? INDIA_BBOX : WORLD_BBOX }], problems: [] };
}

export function bboxContains(b: Bbox, lat: number, lng: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

/** The instance answering reverse geocoding for a point: the first region whose bbox contains it, else null. */
export function regionFor(regions: readonly GeocoderRegion[], lat: number, lng: number): GeocoderRegion | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return regions.find((r) => bboxContains(r.bbox, lat, lng)) ?? null;
}
