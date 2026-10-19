import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

/** AddressCache key: coordinates rounded to 4 decimals (~11 m). */
export const addressKey = (lat: number, lng: number): string => `${lat.toFixed(4)},${lng.toFixed(4)}`;

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly provider = (process.env.GEOCODER ?? 'none').toLowerCase();
  private readonly baseUrl = process.env.GEOCODER_URL ?? '';
  private readonly minIntervalMs = this.provider === 'nominatim' ? 1100 : 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;

  constructor(private readonly prisma: PrismaService) {}

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
