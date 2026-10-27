import { Injectable, Logger } from '@nestjs/common';
import { GapEstimateResponse, GapEstimateSegment } from '@veetracer/shared';
import { RedisService } from '../redis/redis.service';
import { decodePolyline, MAX_ESTIMATE_STRAIGHT_M, plausibleRoute } from './route-estimate';
import { haversineMeters } from '../tracking/geo';

const CACHE_TTL_SEC = 30 * 86_400;
const MISS_TTL_SEC = 86_400;

/**
 * Likely roads through track gaps (History draws them dashed as "estimated"), from a self-hosted Valhalla engine
 * (env ROUTER_URL, e.g. http://host:8002). Off when ROUTER_URL is not set. Answers are cached in Redis by the gap's
 * ends rounded to ~11 m; an engine failure only means no estimate.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly baseUrl = (process.env.ROUTER_URL ?? '').replace(/\/+$/, '');

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

  private async fetchRoute(gap: GapEstimateSegment): Promise<{ m: number; s: number; shape: [number, number][] } | null> {
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
