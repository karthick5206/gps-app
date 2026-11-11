import { Injectable, Logger } from '@nestjs/common';
import { GapEstimateResponse, GapEstimateSegment } from '@veetracer/shared';
import { RedisService } from '../redis/redis.service';
import { decodePolyline, MAX_ESTIMATE_STRAIGHT_M, plausibleRoute } from './route-estimate';
import { fillLegs, parseGraphHopperRoute, parseValhallaTrip, RouteViaLeg, RouteViaResult, ViaPoint } from './route-via';
import { haversineMeters } from '../tracking/geo';

const CACHE_TTL_SEC = 30 * 86_400;
const MISS_TTL_SEC = 86_400;
/** Pairwise leg requests run this many at a time. */
const LEG_CONCURRENCY = 6;

/**
 * Likely roads through track gaps (History draws them dashed as "estimated"), from a self-hosted routing engine:
 * env ROUTER_URL (e.g. http://host:8989) and ROUTER_ENGINE `graphhopper` or `valhalla` (default). Off when ROUTER_URL
 * is not set. Answers are cached in Redis by the gap's ends rounded to ~11 m; an engine failure only means no estimate.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly baseUrl = (process.env.ROUTER_URL ?? '').replace(/\/+$/, '');
  private readonly engine = (process.env.ROUTER_ENGINE ?? 'valhalla').toLowerCase();

  constructor(private readonly redis: RedisService) {}

  get enabled(): boolean {
    return !!this.baseUrl;
  }

  async estimateGaps(segments: GapEstimateSegment[]): Promise<GapEstimateResponse> {
    if (!this.enabled) return { enabled: false, routes: segments.map(() => null) };
    const routes = await Promise.all(segments.map((s) => this.estimate(s).catch(() => null)));
    return { enabled: true, routes };
  }

  private async estimate(gap: GapEstimateSegment): Promise<[number, number][] | null> {
    if (haversineMeters(gap.fromLat, gap.fromLng, gap.toLat, gap.toLng) > MAX_ESTIMATE_STRAIGHT_M) return null;
    const key = `route:est:${gap.fromLat.toFixed(4)},${gap.fromLng.toFixed(4)}:${gap.toLat.toFixed(4)},${gap.toLng.toFixed(4)}`;
    const cached = await this.redis.client.get(key);
    let route: { m: number; s: number; shape: [number, number][] } | null;
    if (cached !== null) {
      route = cached === '' ? null : (JSON.parse(cached) as typeof route);
    } else {
      route = await this.fetchRoute(gap);
      await this.redis.client.set(key, route ? JSON.stringify(route) : '', 'EX', route ? CACHE_TTL_SEC : MISS_TTL_SEC);
    }
    return route && plausibleRoute(gap, route.m, route.s) ? route.shape : null;
  }

  /**
   * Road route between two points (delivery ETA): metres, seconds and [lng, lat] shape (GeoJSON order, as
   * decodePolyline returns it); null without an engine or route. Cached 60 s on ~110 m rounded ends so a share page
   * polled every few seconds costs one engine call a minute.
   */
  async route(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<{ m: number; s: number; shape: [number, number][] } | null> {
    if (!this.enabled) return null;
    const key = `route:eta:${from.lat.toFixed(3)},${from.lng.toFixed(3)}:${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
    const cached = await this.redis.client.get(key).catch(() => null);
    if (cached !== null) return cached === '' ? null : (JSON.parse(cached) as { m: number; s: number; shape: [number, number][] });
    const r = await this.fetchRoute({ fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng } as GapEstimateSegment).catch(() => null);
    await this.redis.client.set(key, r ? JSON.stringify(r) : '', 'EX', 60).catch(() => undefined);
    return r;
  }

  /**
   * Road route through all points in order (planned-trip routes): [lng, lat] path, total metres / seconds and one leg
   * per consecutive pair. GraphHopper: one `/route` call with every point for the path, plus one call per pair for the
   * legs (a failed pair is filled in proportion to its straight length). Valhalla: one call (legs come with it).
   * Null when the engine is off, fails or finds no route. Not cached: called on route save / editor preview only.
   */
  async routeVia(points: ViaPoint[]): Promise<RouteViaResult | null> {
    if (!this.enabled || points.length < 2) return null;
    try {
      if (this.engine !== 'graphhopper') return await this.viaValhalla(points);
      const whole = await this.viaGraphHopper(points);
      if (!whole) return null;
      if (points.length === 2) return { ...whole, legs: [{ distanceM: whole.distanceM, durationSec: whole.durationSec }] };
      const legs: (RouteViaLeg | null)[] = [];
      for (let i = 0; i < points.length - 1; i += LEG_CONCURRENCY) {
        const pairs = points.slice(i, Math.min(points.length, i + LEG_CONCURRENCY + 1));
        const batch = await Promise.all(
          pairs.slice(1).map((p, j) =>
            this.viaGraphHopper([pairs[j], p])
              .then((r) => (r ? { distanceM: r.distanceM, durationSec: r.durationSec } : null))
              .catch(() => null),
          ),
        );
        legs.push(...batch);
      }
      return { ...whole, legs: fillLegs(points, legs, whole.distanceM, whole.durationSec) };
    } catch (error) {
      this.logger.warn(`Route via ${points.length} points failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async viaGraphHopper(points: ViaPoint[]) {
    const q = new URLSearchParams({ profile: 'car', points_encoded: 'true', instructions: 'false', calc_points: 'true' });
    for (const p of points) q.append('point', `${p.lat},${p.lng}`);
    const res = await fetch(`${this.baseUrl}/route?${q.toString()}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      if (res.status !== 400) this.logger.warn(`Routing engine returned ${res.status}`);
      return null;
    }
    return parseGraphHopperRoute(await res.json());
  }

  private async viaValhalla(points: ViaPoint[]): Promise<RouteViaResult | null> {
    const res = await fetch(`${this.baseUrl}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: points.map((p) => ({ lat: p.lat, lon: p.lng, radius: 50 })), costing: 'auto', directions_type: 'none' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status !== 400) this.logger.warn(`Routing engine returned ${res.status}`);
      return null;
    }
    return parseValhallaTrip(await res.json(), points.length);
  }

  private fetchRoute(gap: GapEstimateSegment): Promise<{ m: number; s: number; shape: [number, number][] } | null> {
    return this.engine === 'graphhopper' ? this.fetchGraphHopper(gap) : this.fetchValhalla(gap);
  }

  /** GraphHopper `GET /route` (car profile): distance in m, time in ms, polyline at precision 5. */
  private async fetchGraphHopper(gap: GapEstimateSegment): Promise<{ m: number; s: number; shape: [number, number][] } | null> {
    const q = new URLSearchParams({ profile: 'car', points_encoded: 'true', instructions: 'false', calc_points: 'true' });
    q.append('point', `${gap.fromLat},${gap.fromLng}`);
    q.append('point', `${gap.toLat},${gap.toLng}`);
    const res = await fetch(`${this.baseUrl}/route?${q.toString()}`, { signal: AbortSignal.timeout(5000) });
    // 400 = no route / point not near a road; anything else is an engine problem worth logging.
    if (!res.ok) {
      if (res.status !== 400) this.logger.warn(`Routing engine returned ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { paths?: { distance?: number; time?: number; points?: string; points_encoded_multiplier?: number }[] };
    const path = json.paths?.[0];
    if (!path || typeof path.points !== 'string' || typeof path.distance !== 'number' || typeof path.time !== 'number') return null;
    const coords = decodePolyline(path.points, Math.round(Math.log10(path.points_encoded_multiplier ?? 1e5)));
    return coords.length >= 2 ? { m: path.distance, s: path.time / 1000, shape: coords } : null;
  }

  /** Valhalla `POST /route` (auto costing): length in km, time in s, polyline at precision 6. */
  private async fetchValhalla(gap: GapEstimateSegment): Promise<{ m: number; s: number; shape: [number, number][] } | null> {
    const body = {
      locations: [
        { lat: gap.fromLat, lon: gap.fromLng, radius: 50 },
        { lat: gap.toLat, lon: gap.toLng, radius: 50 },
      ],
      costing: 'auto',
      directions_type: 'none',
    };
    const res = await fetch(`${this.baseUrl}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    // 400 = no route between the points (e.g. across water); anything else is an engine problem worth logging.
    if (!res.ok) {
      if (res.status !== 400) this.logger.warn(`Routing engine returned ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { trip?: { summary?: { length?: number; time?: number }; legs?: { shape?: string }[] } };
    const shape = json.trip?.legs?.[0]?.shape;
    const km = json.trip?.summary?.length;
    const sec = json.trip?.summary?.time;
    if (!shape || typeof km !== 'number' || typeof sec !== 'number') return null;
    const coords = decodePolyline(shape);
    return coords.length >= 2 ? { m: km * 1000, s: sec, shape: coords } : null;
  }
}
