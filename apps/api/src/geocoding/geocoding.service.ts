import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { COORDINATES_MATCH_TYPE, formatCoordinates, GEOCODE_LIMITS, parseCoordinates } from '@veetracer/shared';
import { isLocalHost } from '../monitoring/map-services';
import { PrismaService } from '../prisma/prisma.service';
import { geocoderConfig, rawRegionEntries, regionFor, type GeocoderRegion } from './geocoder-regions';

/**
 * Personal addresses (ETMS passenger homes, security review L11) may only go to a self-hosted geocoder: GEOCODER_URL and
 * every URL in GEOCODER_REGIONS must name a loopback, private-network or internal host, the same policy as the G6
 * map-service probe (isLocalHost; no DNS lookup, so a public name always counts as public). Otherwise 503
 * GEOCODER_NOT_PRIVATE and nothing is sent to any instance (one public URL switches the whole search off).
 * No geocoder configured (GEOCODER=none or no URL) passes: search then returns [] without a request.
 */
export function privateGeocoderProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = (env.GEOCODER ?? 'none').toLowerCase();
  if (provider === 'none') return null;
  const urls: { setting: string; url: string }[] = [];
  if (env.GEOCODER_URL) urls.push({ setting: 'GEOCODER_URL', url: env.GEOCODER_URL });
  for (const e of rawRegionEntries(env)) urls.push({ setting: `GEOCODER_REGIONS entry ${e.code || '?'}`, url: e.url });
  for (const { setting, url } of urls) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return `${setting} is not a valid URL`;
    }
    if (!isLocalHost(host)) return `${setting} host ${host} is not a loopback or private host: addresses are only sent to a self-hosted geocoder`;
  }
  return null;
}

export function assertPrivateGeocoder(env: NodeJS.ProcessEnv = process.env): void {
  const problem = privateGeocoderProblem(env);
  if (problem) throw new ServiceUnavailableException({ message: `Address search is switched off: ${problem}. Ask your administrator to point it at the self-hosted geocoder.`, code: 'GEOCODER_NOT_PRIVATE' });
}

/** "Anna Salai, Teynampet, Chennai, Tamil Nadu 600018" from Photon properties; repeated parts (city = district) dropped. */
export function photonAddress(p: Record<string, string | undefined>): string | null {
  const street = p.street ? [p.housenumber, p.street].filter(Boolean).join(' ') : undefined;
  const parts: string[] = [];
  for (const v of [p.name, street, p.locality ?? p.district, p.city ?? p.county, p.state]) {
    const s = v?.trim();
    if (s && !parts.some((x) => x.toLowerCase() === s.toLowerCase())) parts.push(s);
  }
  if (!parts.length) return null;
  if (p.postcode) parts[parts.length - 1] += ` ${p.postcode}`;
  return parts.join(', ');
}

/**
 * Confidence (0..1) of a Photon search hit from its match type. Photon's HTTP API exposes no score: `importance` is used
 * only for its internal ranking and is not part of the GeoJSON properties, so the only usable signal is `type` (the
 * granularity of the matched object) plus whether a house number matched. null when Photon sent no type.
 */
const PHOTON_TYPE_CONFIDENCE: Record<string, number> = {
  house: 0.8,
  street: 0.6,
  other: 0.5,
  locality: 0.4,
  district: 0.35,
  city: 0.25,
  county: 0.15,
  state: 0.1,
  country: 0.05,
};
export function photonConfidence(p: Record<string, string | undefined> | undefined): number | null {
  const type = p?.type?.toLowerCase();
  if (!type) return null;
  if (type === 'house' && p?.housenumber?.trim()) return 0.9;
  return PHOTON_TYPE_CONFIDENCE[type] ?? null;
}

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
  /** photonConfidence of the hit (null when Photon gave no match type). */
  confidence: number | null;
  /** Photon `type` (house, street, city…), `coordinates` for a typed point (search of "lat, lng"), or null. */
  matchType: string | null;
}

/** AddressCache key: coordinates rounded to 4 decimals (~11 m). */
export const addressKey = (lat: number, lng: number): string => `${lat.toFixed(4)},${lng.toFixed(4)}`;

/**
 * Forward-search cache key (v1.15.1): the query lower-cased with whitespace collapsed, plus the bias point rounded to
 * GEOCODE_LIMITS.cacheNearDecimals (≈ 11 km bucket) or "-" without one.
 */
export function geocodeCacheKey(q: string, near?: { lat: number; lng: number }): string {
  const term = q.trim().replace(/\s+/g, ' ').toLowerCase();
  const d = GEOCODE_LIMITS.cacheNearDecimals;
  const bucket = near && Number.isFinite(near.lat) && Number.isFinite(near.lng) ? `${near.lat.toFixed(d)},${near.lng.toFixed(d)}` : '-';
  return `${bucket}|${term}`;
}

/**
 * Small in-memory LRU with a TTL for forward-search answers. Kept in process memory rather than Valkey on purpose:
 * the queries can be home addresses, so they are never written to a shared store; the size cap bounds memory.
 */
export class GeocodeSearchCache {
  private readonly rows = new Map<string, { at: number; hits: GeocodeHit[] }>();

  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number,
  ) {}

  get(key: string, now: number = Date.now()): GeocodeHit[] | undefined {
    const row = this.rows.get(key);
    if (!row) return undefined;
    this.rows.delete(key);
    if (now - row.at > this.ttlMs) return undefined;
    this.rows.set(key, row); // most recently used last
    return row.hits;
  }

  set(key: string, hits: GeocodeHit[], now: number = Date.now()): void {
    this.rows.delete(key);
    this.rows.set(key, { at: now, hits });
    while (this.rows.size > this.maxEntries) this.rows.delete(this.rows.keys().next().value as string);
  }
}

/** Hits per Photon instance and after merging all instances (v1.18). */
export const SEARCH_LIMIT = 6;
/** Per-instance timeout of a forward search; a slow or failing instance only drops its own hits. */
export const SEARCH_TIMEOUT_MS = 4000;

/** Great-circle distance in metres (ranking only). */
function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Merges the answers of several instances (each already in Photon's own relevance order): highest confidence first, then
 * nearest to the bias point (when given), then Photon's order; the same label within ~100 m is kept once.
 */
export function mergeHits(lists: readonly GeocodeHit[][], near?: { lat: number; lng: number }, limit: number = SEARCH_LIMIT): GeocodeHit[] {
  const rows = lists.flatMap((hits, list) => hits.map((hit, rank) => ({ hit, rank, list, dist: near ? distanceM(near, hit) : 0 })));
  rows.sort((a, b) => (b.hit.confidence ?? 0) - (a.hit.confidence ?? 0) || a.dist - b.dist || a.rank - b.rank || a.list - b.list);
  const seen = new Set<string>();
  const out: GeocodeHit[] = [];
  for (const { hit } of rows) {
    const key = `${hit.label.trim().toLowerCase()}|${hit.lat.toFixed(3)},${hit.lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

type PhotonFeature = { geometry?: { coordinates?: [number, number] }; properties?: Record<string, string | undefined> };

/**
 * Reverse geocoding (coordinates → address) with a database cache keyed by coordinates rounded to ~11 m, and address /
 * place search. Provider from env GEOCODER: `none` (default), `photon` (self-hosted; instances from GEOCODER_REGIONS or
 * GEOCODER_URL, see geocoder-regions.ts) or `nominatim` (GEOCODER_URL; the public nominatim.openstreetmap.org allows
 * ≤ 1 request/s and is for development only). Callers must treat `null` as "no address" and never block the hot path.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly provider = (process.env.GEOCODER ?? 'none').toLowerCase();
  private readonly regions: GeocoderRegion[];
  private readonly minIntervalMs = this.provider === 'nominatim' ? 1100 : 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  /** v1.15.1: forward-search answers per API process (type-ahead; GEOCODE_LIMITS). */
  private readonly searchCache = new GeocodeSearchCache(GEOCODE_LIMITS.cacheMaxEntries, GEOCODE_LIMITS.cacheTtlMs);

  constructor(private readonly prisma: PrismaService) {
    const config = geocoderConfig();
    this.regions = config.regions;
    for (const p of config.problems) this.logger.warn(`${p} (entry skipped)`);
    const problem = privateGeocoderProblem();
    if (problem) this.logger.warn(`${problem}. ETMS address search and passenger geocoding refuse requests (GEOCODER_NOT_PRIVATE).`);
  }

  get enabled(): boolean {
    return this.provider !== 'none' && this.regions.length > 0;
  }

  /** Configured instances (code, URL, bbox). */
  get instances(): readonly GeocoderRegion[] {
    return this.regions;
  }

  /** Address at a point from the instance whose bbox contains it; null when none does or nothing is found. */
  async reverse(lat: number, lng: number): Promise<string | null> {
    if (!this.enabled || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const region = regionFor(this.regions, lat, lng);
    if (!region) return null;
    const key = addressKey(lat, lng);
    const cached = await this.prisma.addressCache.findUnique({ where: { key } });
    if (cached) return cached.address;
    const address = await this.throttled(() => this.lookup(region.url, lat, lng));
    if (address) {
      await this.prisma.addressCache.upsert({ where: { key }, create: { key, address, provider: this.provider }, update: {} });
    }
    return address;
  }

  /**
   * Address / place search (Photon only; up to SEARCH_LIMIT results). Every instance is asked in parallel within its own
   * bbox (SEARCH_TIMEOUT_MS each; a failing instance only drops its hits) and the answers are merged by mergeHits. The
   * bias point `near` (e.g. the map centre) goes to the instance whose bbox contains it and orders the merged list.
   *
   * Coordinates ("12.97, 77.59", "12.97N 77.59E", DMS…; parseCoordinates) are never sent to search: the answer is one
   * exact hit at that point (matchType 'coordinates', confidence 1) labelled with its address when reverse geocoding
   * finds one, else the formatted coordinates.
   *
   * v1.15.1 type-ahead: answers are kept in `searchCache` (normalised query + near-point bucket, GEOCODE_LIMITS TTL and
   * size cap) unless an instance failed. Callers keep running assertPrivateGeocoder first (the cache sits behind it).
   */
  async search(q: string, near?: { lat: number; lng: number }): Promise<GeocodeHit[]> {
    const point = parseCoordinates(q);
    if (point) return [await this.coordinateHit(point.lat, point.lng)];
    if (!this.enabled || this.provider !== 'photon' || q.trim().length < 3) return [];
    const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lng) ? near : undefined;
    const key = geocodeCacheKey(q, bias);
    const cached = this.searchCache.get(key);
    if (cached) return cached.map((h) => ({ ...h }));
    const term = q.trim().replace(/\s+/g, ' ');
    const biasRegion = bias ? regionFor(this.regions, bias.lat, bias.lng) : null;
    const answers = await Promise.allSettled(this.regions.map((r) => this.searchRegion(r, term, r === biasRegion ? bias : undefined)));
    const lists: GeocodeHit[][] = [];
    let failed = false;
    answers.forEach((a, i) => {
      if (a.status === 'fulfilled') lists.push(a.value);
      else {
        failed = true;
        this.logger.warn(`Address search failed (${this.regions[i].code}): ${(a.reason as Error)?.message ?? String(a.reason)}`);
      }
    });
    const hits = mergeHits(lists, bias);
    if (!failed) this.searchCache.set(key, hits);
    return hits.map((h) => ({ ...h }));
  }

  private async coordinateHit(lat: number, lng: number): Promise<GeocodeHit> {
    let address: string | null = null;
    try {
      address = await this.reverse(lat, lng);
    } catch (error) {
      this.logger.warn(`Reverse geocoding of searched coordinates failed: ${(error as Error).message}`);
    }
    return { label: address ?? formatCoordinates(lat, lng), lat, lng, confidence: 1, matchType: COORDINATES_MATCH_TYPE };
  }

  /** One instance; throws on a network error, timeout or non-2xx answer (the search then goes on without it). */
  private async searchRegion(region: GeocoderRegion, term: string, near?: { lat: number; lng: number }): Promise<GeocodeHit[]> {
    const p = new URLSearchParams({ q: term, limit: String(SEARCH_LIMIT), lang: 'en', bbox: region.bbox.join(',') });
    if (near) {
      p.set('lat', String(near.lat));
      p.set('lon', String(near.lng));
    }
    const res = await fetch(`${region.url}/api?${p.toString()}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: PhotonFeature[] };
    return (body.features ?? []).flatMap((f) => {
      const c = f.geometry?.coordinates;
      const label = f.properties ? photonAddress(f.properties) : null;
      return c && label ? [{ label, lat: c[1], lng: c[0], confidence: photonConfidence(f.properties), matchType: f.properties?.type ?? null }] : [];
    });
  }

  /** Serialises provider calls and spaces them by minIntervalMs (rate-limited providers only; self-hosted Photon runs in parallel). */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    if (this.minIntervalMs <= 0) return fn();
    const run = this.queue.then(async () => {
      const wait = this.lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async lookup(baseUrl: string, lat: number, lng: number): Promise<string | null> {
    try {
      if (this.provider === 'photon') {
        // lang=en: Latin-script names (OSM name:en) rather than the local script, so addresses read the same everywhere.
        const res = await fetch(`${baseUrl}/reverse?lat=${lat}&lon=${lng}&limit=1&lang=en`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { features?: { properties?: Record<string, string | undefined> }[] };
        const p = body.features?.[0]?.properties;
        if (!p) return null;
        return photonAddress(p);
      }
      if (this.provider === 'nominatim') {
        const url = `${baseUrl}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=0`;
        const res = await fetch(url, { headers: { 'User-Agent': 'VeeTrax/0.1 (development)' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { display_name?: string };
        return body.display_name ?? null;
      }
    } catch (error) {
      this.logger.warn(`Reverse geocoding failed: ${(error as Error).message}`);
    }
    return null;
  }
}
