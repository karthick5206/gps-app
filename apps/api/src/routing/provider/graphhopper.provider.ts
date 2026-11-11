import { Logger } from '@nestjs/common';
import type { InPoint } from '../../point-quality/analyze';
import { distanceToRoad, lineLengthM, matchSegment, OFFROAD_M } from '../../point-quality/road-match';
import { decodePolyline } from '../route-estimate';
import { fillLegs, parseGraphHopperRoute, RouteViaLeg } from '../route-via';
import { readRouterConfig, RouterConfig } from './router-config';
import {
  AVAILABLE_PROFILES,
  EtaModel,
  MapMatchResult,
  MatrixRequest,
  MatrixResult,
  PointRoute,
  ProviderCapabilities,
  ProviderHealth,
  Pt,
  Result,
  RouteOptions,
  RoutingProfile,
  RoutingProvider,
  TracePoint,
  unavailable,
  Unavailable,
  ViaRoute,
} from './routing-provider';

/** Same values as `RoutingService` so outputs and timing stay identical. */
const ROUTE_TIMEOUT_MS = 5000;
const VIA_TIMEOUT_MS = 10_000;
const LEG_CONCURRENCY = 6;
const INFO_TIMEOUT_MS = 3000;
const HEALTH_TIMEOUT_MS = 2000;

export const GRAPHHOPPER_ATTRIBUTION = '© OpenStreetMap contributors · GraphHopper';

type GhAnswer = { ok: true; json: unknown } | Unavailable;

interface GhInfo {
  version?: unknown;
  data_date?: unknown;
  import_date?: unknown;
  profiles?: { name?: unknown }[];
}

/**
 * `RoutingProvider` over the self-hosted GraphHopper (`GET /route`, `POST /match`, `GET /info`, `GET /health`).
 * A thin wrapper over the v1.8 `RoutingService` GraphHopper behaviour: same requests, same parsing helpers
 * (`parseGraphHopperRoute`, `fillLegs`, `decodePolyline`, `matchSegment`), same timeouts, so `route` / `routeVia`
 * values are identical (verified in `graphhopper.provider.spec.ts`). Unlike `RoutingService` it is not cached and it
 * reports why a call failed instead of returning null.
 */
export class GraphHopperProvider implements RoutingProvider {
  private readonly logger = new Logger(GraphHopperProvider.name);
  private info: { engineVersion: string | null; graphVersion: string | null; profiles: string[] } | null = null;

  constructor(readonly config: RouterConfig = readRouterConfig()) {
    if (config.state === 'refused') this.logger.error(config.message);
  }

  get enabled(): boolean {
    return this.config.state === 'graphhopper';
  }

  async capabilities(): Promise<Result<ProviderCapabilities>> {
    const off = this.off();
    if (off) return off;
    const info = await this.readInfo();
    if (!info.ok) return info;
    const profiles = AVAILABLE_PROFILES.filter((p) => info.value.profiles.includes(p));
    return this.ok({
      engine: 'graphhopper',
      engineVersion: info.value.engineVersion,
      graphVersion: info.value.graphVersion,
      profiles,
      matrix: { native: false, maxSyncCells: 0, maxAsyncCells: 0 },
      mapMatching: true,
      isochrone: false,
      coverage: 'india',
    });
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const off = this.off();
    if (off) return { reachable: false, checkedAt, degraded: off.degraded, message: off.message };
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const latencyMs = Date.now() - started;
      if (res.ok) return { reachable: true, latencyMs, checkedAt };
      return { reachable: false, latencyMs, checkedAt, degraded: 'ENGINE_UNREACHABLE', message: `GraphHopper /health returned ${res.status}` };
    } catch (error) {
      const u = this.thrown(error);
      return { reachable: false, checkedAt, degraded: u.degraded, message: u.message };
    }
  }

  /** Same request and numbers as `RoutingService.route` (uncached): raw metres, seconds, [lng, lat] path. */
  async route(from: Pt, to: Pt, opts: RouteOptions = {}): Promise<Result<PointRoute>> {
    const off = this.off() ?? this.profileOff(opts.profile);
    if (off) return off;
    const answer = await this.ghRoute([from, to], ROUTE_TIMEOUT_MS);
    if (!answer.ok) return answer;
    const path = (answer.json as { paths?: { distance?: number; time?: number; points?: string; points_encoded_multiplier?: number }[] } | null)?.paths?.[0];
    if (!path || typeof path.points !== 'string' || typeof path.distance !== 'number' || typeof path.time !== 'number') {
      return unavailable('NO_ROUTE', 'GraphHopper answer has no usable path');
    }
    const coords = decodePolyline(path.points, Math.round(Math.log10(path.points_encoded_multiplier ?? 1e5)));
    if (coords.length < 2) return unavailable('NO_ROUTE', 'GraphHopper path has fewer than two points');
    return this.ok({ path: coords, distanceM: path.distance, durationS: path.time / 1000 });
  }

  /**
   * Same algorithm as `RoutingService.routeVia` for GraphHopper: one `/route` with every point for the path and
   * totals, one `/route` per consecutive pair for the legs (6 at a time). A failed pair is split in proportion to
   * straight-line length exactly as v1.8 does, and its index is listed in `estimatedLegs`.
   */
  async routeVia(points: Pt[], opts: RouteOptions = {}): Promise<Result<ViaRoute>> {
    const off = this.off() ?? this.profileOff(opts.profile);
    if (off) return off;
    if (points.length < 2) return unavailable('INVALID_INPUT', 'routeVia needs at least two points');
    const answer = await this.ghRoute(points, VIA_TIMEOUT_MS);
    if (!answer.ok) return answer;
    const whole = parseGraphHopperRoute(answer.json);
    if (!whole) return unavailable('NO_ROUTE', 'GraphHopper answer has no usable path');
    if (points.length === 2) {
      return this.ok({ ...whole, legs: [{ distanceM: whole.distanceM, durationSec: whole.durationSec }], estimatedLegs: [] });
    }
    const legs: (RouteViaLeg | null)[] = [];
    for (let i = 0; i < points.length - 1; i += LEG_CONCURRENCY) {
      const pairs = points.slice(i, Math.min(points.length, i + LEG_CONCURRENCY + 1));
      const batch = await Promise.all(
        pairs.slice(1).map(async (p, j) => {
          const leg = await this.ghRoute([pairs[j], p], VIA_TIMEOUT_MS);
          const r = leg.ok ? parseGraphHopperRoute(leg.json) : null;
          return r ? { distanceM: r.distanceM, durationSec: r.durationSec } : null;
        }),
      );
      legs.push(...batch);
    }
    const estimatedLegs = legs.flatMap((l, i) => (l ? [] : [i]));
    return this.ok({ ...whole, legs: fillLegs(points, legs, whole.distanceM, whole.durationSec), estimatedLegs });
  }

  /** Not built yet: the M1 matrix from `/route` calls with a graph-versioned cache is doc 17 §7 P7 (WP 4.1b). */
  async matrix(req: MatrixRequest): Promise<Result<MatrixResult>> {
    const off = this.off() ?? this.profileOff(req.profile);
    if (off) return off;
    return unavailable('NOT_IMPLEMENTED', 'Routing matrix is not implemented yet (E4 WP 4.1b); no matrix numbers are available.');
  }

  /**
   * Map matching, delegated to `point-quality/road-match.ts` `matchSegment` (the same `/match` request, thinning and
   * chunking point-quality uses). Off-road indexes use point-quality's rule: farther than max(60 m, 2 × accuracy).
   */
  async mapMatch(trace: TracePoint[], profile?: RoutingProfile): Promise<Result<MapMatchResult>> {
    const off = this.off() ?? this.profileOff(profile);
    if (off) return off;
    if (trace.length < 3) return unavailable('INVALID_INPUT', 'map matching needs at least three fixes');
    const points: InPoint[] = trace.map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, acc: p.acc ?? null, spdKph: 0, mock: false }));
    let road: [number, number][] | null;
    try {
      road = await matchSegment(this.baseUrl, points, points.map((_, i) => i));
    } catch (error) {
      return this.thrown(error);
    }
    if (!road) return unavailable('NO_ROUTE', 'GraphHopper could not match the trace to roads');
    const offRoadIndexes: number[] = [];
    let hint = 0;
    points.forEach((p, i) => {
      const r = distanceToRoad(p.lat, p.lng, road, hint);
      hint = r.idx;
      if (r.d > Math.max(OFFROAD_M, 2 * (p.acc ?? 0))) offRoadIndexes.push(i);
    });
    return this.ok({ path: road, matchedDistanceM: Math.round(lineLengthM(road)), offRoadIndexes });
  }

  /** Not built yet: GraphHopper `/nearest` replaces Valhalla `/locate` in WP 4.1b. */
  async locate(_points: Pt[], profile?: RoutingProfile): Promise<Result<{ onRoad: boolean; snapDistanceM: number }[]>> {
    const off = this.off() ?? this.profileOff(profile);
    if (off) return off;
    return unavailable('NOT_IMPLEMENTED', 'locate is not implemented yet (E4 WP 4.1b).');
  }

  // ---- internals ----

  private get baseUrl(): string {
    return this.config.state === 'graphhopper' ? this.config.baseUrl : '';
  }

  private off(): Unavailable | null {
    if (this.config.state === 'disabled') return unavailable('ENGINE_DISABLED', this.config.message);
    if (this.config.state === 'refused') return unavailable('ENGINE_NOT_SUPPORTED', this.config.message);
    return null;
  }

  private profileOff(profile: RoutingProfile | undefined): Unavailable | null {
    const p = profile ?? 'car';
    return AVAILABLE_PROFILES.includes(p) ? null : unavailable('PROFILE_NOT_AVAILABLE', `Routing profile "${p}" is not available on this graph (only: ${AVAILABLE_PROFILES.join(', ')}).`);
  }

  private eta(): EtaModel {
    return { source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion: this.info?.graphVersion ?? null };
  }

  private ok<T>(value: T): Result<T> {
    return { ok: true, value, eta: this.eta(), attribution: GRAPHHOPPER_ATTRIBUTION };
  }

  private thrown(error: unknown): Unavailable {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return unavailable('ENGINE_TIMEOUT', 'GraphHopper did not answer in time');
    return unavailable('ENGINE_UNREACHABLE', `GraphHopper unreachable: ${(error as Error)?.message ?? String(error)}`);
  }

  /** `GET /route` exactly as `RoutingService` sends it (car profile, encoded points, no instructions). */
  private async ghRoute(points: Pt[], timeoutMs: number): Promise<GhAnswer> {
    const q = new URLSearchParams({ profile: 'car', points_encoded: 'true', instructions: 'false', calc_points: 'true' });
    for (const p of points) q.append('point', `${p.lat},${p.lng}`);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/route?${q.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return this.thrown(error);
    }
    if (!res.ok) {
      const message = await res
        .json()
        .then((j: { message?: unknown }) => (typeof j?.message === 'string' ? j.message : ''))
        .catch(() => '');
      // 400 = no route / point not near a road; anything else is an engine problem worth logging (as RoutingService).
      if (res.status === 400) {
        return /cannot find point/i.test(message)
          ? unavailable('POINT_NOT_ON_ROAD', message)
          : unavailable('NO_ROUTE', message || 'GraphHopper found no route');
      }
      this.logger.warn(`Routing engine returned ${res.status}`);
      return unavailable('ENGINE_UNREACHABLE', `GraphHopper returned ${res.status}${message ? `: ${message}` : ''}`);
    }
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return unavailable('ENGINE_UNREACHABLE', 'GraphHopper answer is not JSON');
    }
  }

  private async readInfo(): Promise<Result<NonNullable<GraphHopperProvider['info']>>> {
    try {
      const res = await fetch(`${this.baseUrl}/info`, { signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
      if (!res.ok) return unavailable('ENGINE_UNREACHABLE', `GraphHopper /info returned ${res.status}`);
      const json = (await res.json()) as GhInfo;
      const version = typeof json.version === 'string' ? json.version : null;
      const date = typeof json.data_date === 'string' ? json.data_date : typeof json.import_date === 'string' ? json.import_date : null;
      this.info = {
        engineVersion: version,
        graphVersion: version && date ? `gh-${version}/${date}` : null,
        profiles: (json.profiles ?? []).map((p) => p?.name).filter((n): n is string => typeof n === 'string'),
      };
      return this.ok(this.info);
    } catch (error) {
      return this.thrown(error);
    }
  }
}
