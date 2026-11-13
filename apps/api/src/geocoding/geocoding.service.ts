import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { GEOCODE_LIMITS } from '@veetracer/shared';
import { isLocalHost } from '../monitoring/map-services';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Personal addresses (ETMS passenger homes, security review L11) may only go to a self-hosted geocoder: GEOCODER_URL
 * must name a loopback, private-network or internal host, the same policy as the G6 map-service probe (isLocalHost; no
 * DNS lookup, so a public name always counts as public). Otherwise 503 GEOCODER_NOT_PRIVATE and nothing is sent.
 * No geocoder configured (GEOCODER=none or no URL) passes: search then returns [] without a request.
 */
export function privateGeocoderProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = (env.GEOCODER ?? 'none').toLowerCase();
  const url = env.GEOCODER_URL ?? '';
  if (provider === 'none' || !url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'GEOCODER_URL is not a valid URL';
  }
  return isLocalHost(host) ? null : `GEOCODER_URL host ${host} is not a loopback or private host: addresses are only sent to a self-hosted geocoder`;
}

export function assertPrivateGeocoder(env: NodeJS.ProcessEnv = process.env): void {
  const problem = privateGeocoderProblem(env);
  if (problem) throw new ServiceUnavailableException({ message: `Address search is switched off: ${problem}. Ask your administrator to point it at the self-hosted geocoder.`, code: 'GEOCODER_NOT_PRIVATE' });
}

/**
 * Reverse geocoding (coordinates → address) with a database cache keyed by coordinates rounded to ~11 m.
 * Provider from env GEOCODER: `none` (default), `photon` (self-hosted, GEOCODER_URL) or `nominatim`
 * (GEOCODER_URL; the public nominatim.openstreetmap.org allows ≤ 1 request/s and is for development only).
 * Callers must treat `null` as "no address" and never block the hot path on this.
 */
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
  /** Photon `type` (house, street, city…), or null. */
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

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly provider = (process.env.GEOCODER ?? 'none').toLowerCase();
  private readonly baseUrl = process.env.GEOCODER_URL ?? '';
  private readonly minIntervalMs = this.provider === 'nominatim' ? 1100 : 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  /** v1.15.1: forward-search answers per API process (type-ahead; GEOCODE_LIMITS). */
  private readonly searchCache = new GeocodeSearchCache(GEOCODE_LIMITS.cacheMaxEntries, GEOCODE_LIMITS.cacheTtlMs);

  constructor(private readonly prisma: PrismaService) {
    const problem = privateGeocoderProblem();
    if (problem) this.logger.warn(`${problem}. ETMS address search and passenger geocoding refuse requests (GEOCODER_NOT_PRIVATE).`);
  }

  get enabled(): boolean {
    return this.provider !== 'none' && !!this.baseUrl;
  }

  async reverse(lat: number, lng: number): Promise<string | null> {
    if (!this.enabled || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const key = addressKey(lat, lng);
    const cached = await this.prisma.addressCache.findUnique({ where: { key } });
    if (cached) return cached.address;
    const address = await this.throttled(() => this.lookup(lat, lng));
    if (address) {
      await this.prisma.addressCache.upsert({ where: { key }, create: { key, address, provider: this.provider }, update: {} });
    }
    return address;
  }

  /**
   * Address / place search for picking a destination (Photon only; up to 6 results near India). v1.15.1 type-ahead:
   * answers of a successful lookup are kept in `searchCache` (normalised query + near-point bucket, GEOCODE_LIMITS
   * TTL and size cap), so repeated prefixes do not reach Photon again; failures are not cached. Callers keep running
   * assertPrivateGeocoder first (the cache sits behind that guard).
   */
  async search(q: string, near?: { lat: number; lng: number }): Promise<GeocodeHit[]> {
    if (!this.enabled || this.provider !== 'photon' || q.trim().length < 3) return [];
    const key = geocodeCacheKey(q, near);
    const cached = this.searchCache.get(key);
    if (cached) return cached.map((h) => ({ ...h }));
    try {
      const p = new URLSearchParams({ q: q.trim().replace(/\s+/g, ' '), limit: '6', lang: 'en', bbox: '68,6,98,37' });
      if (near) {
        p.set('lat', String(near.lat));
        p.set('lon', String(near.lng));
      }
      const res = await fetch(`${this.baseUrl}/api?${p.toString()}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const body = (await res.json()) as { features?: { geometry?: { coordinates?: [number, number] }; properties?: Record<string, string | undefined> }[] };
      const hits: GeocodeHit[] = (body.features ?? []).flatMap((f) => {
        const c = f.geometry?.coordinates;
        const label = f.properties ? photonAddress(f.properties) : null;
        return c && label ? [{ label, lat: c[1], lng: c[0], confidence: photonConfidence(f.properties), matchType: f.properties?.type ?? null }] : [];
      });
      this.searchCache.set(key, hits);
      return hits.map((h) => ({ ...h }));
    } catch (error) {
      this.logger.warn(`Address search failed: ${(error as Error).message}`);
      return [];
    }
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

  private async lookup(lat: number, lng: number): Promise<string | null> {
    try {
      if (this.provider === 'photon') {
        // lang=en: Latin-script names (OSM name:en) rather than the local script, so addresses read the same everywhere.
        const res = await fetch(`${this.baseUrl}/reverse?lat=${lat}&lon=${lng}&limit=1&lang=en`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { features?: { properties?: Record<string, string | undefined> }[] };
        const p = body.features?.[0]?.properties;
        if (!p) return null;
        return photonAddress(p);
      }
      if (this.provider === 'nominatim') {
        const url = `${this.baseUrl}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=0`;
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
