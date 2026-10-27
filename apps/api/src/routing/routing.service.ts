import { Injectable, Logger } from '@nestjs/common';
import { GapEstimateResponse, GapEstimateSegment } from '@veetracer/shared';
import { RedisService } from '../redis/redis.service';
import { decodePolyline, MAX_ESTIMATE_STRAIGHT_M, plausibleRoute } from './route-estimate';
import { haversineMeters } from '../tracking/geo';

const CACHE_TTL_SEC = 30 * 86_400;
const MISS_TTL_SEC = 86_400;

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
