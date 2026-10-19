import { Injectable, Logger } from '@nestjs/common';
import { AlertDto, ReportType, StopDto, TripDto } from '@veetracer/shared';
import { addressKey, GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';

/** One location on a row: where to read its coordinates and current address, and how to store a resolved one. */
export interface AddressField<T> {
  lat: (row: T) => number | null | undefined;
  lng: (row: T) => number | null | undefined;
  get: (row: T) => string | null | undefined;
  set: (row: T, address: string) => void;
}

export interface EnrichOptions {
  /** Most uncached (provider) lookups per call; cached addresses are unlimited. */
  budget?: number;
  /** Parallel provider lookups. */
  concurrency?: number;
  /** No new provider lookups are started after this long (ms). */
  timeBudgetMs?: number;
}

export interface EnrichStats {
  /** Row locations without an address. */
  pending: number;
  /** Distinct rounded coordinates among them. */
  unique: number;
  /** Coordinates answered by the AddressCache bulk read. */
  cached: number;
  /** Provider lookups made. */
  lookedUp: number;
  /** Row locations that got an address. */
  filled: number;
  /** Coordinates left unresolved because the budget or time ran out. */
  skipped: number;
  ms: number;
}

export const POSITIONS_ADDRESS_BUDGET = 1500;
export const DEFAULT_ADDRESS_BUDGET = 500;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIME_BUDGET_MS = 20_000;
const CACHE_CHUNK = 5000;

const missing = (v: string | null | undefined) => v === null || v === undefined || v === '';
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

type Located = { lat?: number | null; lng?: number | null; address?: string | null };
const pointField = <T extends Located>(): AddressField<T> => ({
  lat: (r) => r.lat,
  lng: (r) => r.lng,
  get: (r) => r.address,
  set: (r, a) => (r.address = a),
});
type Ends = { startLat: number | null; startLng: number | null; endLat: number | null; endLng: number | null; startAddress: string | null; endAddress: string | null };
const startField = <T extends Ends>(): AddressField<T> => ({ lat: (r) => r.startLat, lng: (r) => r.startLng, get: (r) => r.startAddress, set: (r, a) => (r.startAddress = a) });
const endField = <T extends Ends>(): AddressField<T> => ({ lat: (r) => r.endLat, lng: (r) => r.endLng, get: (r) => r.endAddress, set: (r, a) => (r.endAddress = a) });

/** Location fields per report type (types without locations are absent). */
export function addressFieldsFor(type: ReportType): AddressField<never>[] | null {
  switch (type) {
    case 'POSITIONS':
    case 'OVERSPEED':
    case 'IGNITION':
    case 'DEVICE_STATUS':
    case 'POI_VISITS':
    case 'FUEL_EVENTS':
    case 'STOPS':
    case 'IDLE':
    case 'HALT':
    case 'ALERTS':
      return [pointField() as AddressField<never>];
    case 'TRIPS':
    case 'CONTINUOUS_DRIVING':
      return [startField() as AddressField<never>, endField() as AddressField<never>];
    default:
      return null;
  }
}

/**
 * Fills missing addresses on report rows: distinct coordinates (rounded like the AddressCache, ~11 m) are read from the
 * cache in bulk, the rest are reverse-geocoded with bounded concurrency up to a per-call budget. Locations beyond the
 * budget keep their coordinates (later runs fill them as the cache warms). Never throws.
 */
@Injectable()
export class AddressEnricher {
  private readonly logger = new Logger(AddressEnricher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoder: GeocodingService,
  ) {}

  get enabled(): boolean {
    return this.geocoder.enabled;
  }

  async enrich<T>(rows: T[], fields: AddressField<T>[], opts: EnrichOptions = {}): Promise<EnrichStats> {
    const started = Date.now();
    const stats: EnrichStats = { pending: 0, unique: 0, cached: 0, lookedUp: 0, filled: 0, skipped: 0, ms: 0 };
    if (!this.geocoder.enabled || !rows.length || !fields.length) return stats;
    try {
      const points = new Map<string, { lat: number; lng: number; targets: [T, AddressField<T>][] }>();
      for (const row of rows) {
        for (const f of fields) {
          const lat = f.lat(row);
          const lng = f.lng(row);
          if (!missing(f.get(row)) || !finite(lat) || !finite(lng)) continue;
          stats.pending++;
          const key = addressKey(lat, lng);
          const p = points.get(key) ?? points.set(key, { lat, lng, targets: [] }).get(key)!;
          p.targets.push([row, f]);
        }
      }
      stats.unique = points.size;
      if (!points.size) return stats;

      const found = new Map<string, string>();
      const keys = [...points.keys()];
      for (let i = 0; i < keys.length; i += CACHE_CHUNK) {
        const hits = await this.prisma.addressCache.findMany({ where: { key: { in: keys.slice(i, i + CACHE_CHUNK) } }, select: { key: true, address: true } });
        for (const h of hits) found.set(h.key, h.address);
      }
      stats.cached = found.size;

      const todo = keys.filter((k) => !found.has(k));
      const budget = Math.max(0, opts.budget ?? DEFAULT_ADDRESS_BUDGET);
      const deadline = started + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
      const queue = todo.slice(0, budget);
      let next = 0;
      const worker = async () => {
        while (next < queue.length && Date.now() < deadline) {
          const key = queue[next++];
          const p = points.get(key)!;
          stats.lookedUp++;
          try {
            const address = await this.geocoder.reverse(p.lat, p.lng);
            if (address) found.set(key, address);
          } catch {
            // Geocoder errors leave the coordinates.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, queue.length) }, worker));
      stats.skipped = todo.length - stats.lookedUp;

      for (const [key, p] of points) {
        const address = found.get(key);
        if (!address) continue;
        for (const [row, f] of p.targets) {
          f.set(row, address);
          stats.filled++;
        }
      }
    } catch (error) {
      this.logger.warn(`Report address enrichment failed: ${(error as Error).message}`);
    }
    stats.ms = Date.now() - started;
    if (stats.lookedUp || stats.skipped) {
      this.logger.log(
        `Report addresses: ${stats.filled}/${stats.pending} filled, ${stats.unique} places (${stats.cached} cached, ${stats.lookedUp} looked up, ${stats.skipped} deferred) in ${stats.ms} ms`,
      );
    }
    return stats;
  }

  /** Fills the addresses of one report's rows in place and stores new trip / stop / alert addresses. */
  async enrichReport(type: ReportType, rows: unknown[]): Promise<EnrichStats | null> {
    const fields = addressFieldsFor(type);
    if (!fields || !rows.length || !this.geocoder.enabled) return null;
    const budget = type === 'POSITIONS' ? POSITIONS_ADDRESS_BUDGET : DEFAULT_ADDRESS_BUDGET;
    const before = rows.map((r) => fields.map((f) => missing(f.get(r as never))));
    const stats = await this.enrich(rows as never[], fields, { budget });
    if (stats.filled && (type === 'TRIPS' || type === 'STOPS' || type === 'IDLE' || type === 'HALT' || type === 'ALERTS')) {
      const changed = rows.filter((r, i) => fields.some((f, j) => before[i][j] && !missing(f.get(r as never))));
      await this.persist(type, changed);
    }
    return stats;
  }

  /** Writes newly resolved addresses back where they were still null (one statement per chunk). */
  private async persist(type: ReportType, rows: unknown[]): Promise<void> {
    try {
      for (let i = 0; i < rows.length; i += CACHE_CHUNK) {
        const chunk = rows.slice(i, i + CACHE_CHUNK);
        if (type === 'TRIPS') {
          const trips = chunk as TripDto[];
          await this.prisma.$executeRaw`
            UPDATE "Trip" t SET "startAddress" = coalesce(t."startAddress", v.s), "endAddress" = coalesce(t."endAddress", v.e)
            FROM unnest(${trips.map((r) => r.id)}::uuid[], ${trips.map((r) => r.startAddress)}::text[], ${trips.map((r) => r.endAddress)}::text[]) AS v(id, s, e)
            WHERE t.id = v.id AND (t."startAddress" IS NULL OR t."endAddress" IS NULL)`;
        } else if (type === 'ALERTS') {
          const alerts = chunk as AlertDto[];
          await this.prisma.$executeRaw`
            UPDATE "Alert" a SET address = v.a
            FROM unnest(${alerts.map((r) => r.id)}::uuid[], ${alerts.map((r) => r.address)}::text[]) AS v(id, a)
            WHERE a.id = v.id AND a.address IS NULL`;
        } else {
          const stops = chunk as StopDto[];
          await this.prisma.$executeRaw`
            UPDATE "Stop" s SET address = v.a
            FROM unnest(${stops.map((r) => r.id)}::uuid[], ${stops.map((r) => r.address)}::text[]) AS v(id, a)
            WHERE s.id = v.id AND s.address IS NULL`;
        }
      }
    } catch (error) {
      this.logger.warn(`Storing report addresses failed: ${(error as Error).message}`);
    }
  }
}
