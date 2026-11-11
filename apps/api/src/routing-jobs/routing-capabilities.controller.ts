import { Controller, Get, Inject, Injectable, UseGuards } from '@nestjs/common';
import {
  can,
  ETA_BANDS,
  ETMS_PLANNING_MENU,
  OSM_ATTRIBUTION,
  ROUTING_AVAILABLE_PROFILES,
  ROUTING_ENGINE,
  ROUTING_LIMITS,
  type EtaBandStatus,
  type RoutingCapabilities,
  type RoutingDegradedReason,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { etmsRoutingEnabled, TransportFeatureGuard } from '../etms/transport-feature.guard';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { readMatrixConfig } from '../routing/matrix/matrix-config';
import { OptimizerClient } from '../routing/optimizer/optimizer.client';
import { ROUTING_PROVIDER, type RoutingProvider } from '../routing/provider/routing-provider';
import { HEARTBEAT_TTL_SEC } from '../monitoring/heartbeat';

/** Capabilities plus the matrix limits and why the engine is unavailable (no host, URL or message is ever included). */
export type RoutingCapabilitiesDto = RoutingCapabilities & {
  engineDegraded: RoutingDegradedReason | null;
  matrix: { maxPoints: number; maxBuilds: number; maxSyncCells: number; maxAsyncCells: number; sparseAbovePoints: number };
};

/** Results are reused for this long (each call would otherwise probe GraphHopper and the optimiser). */
const CACHE_MS = 10_000;

@Injectable()
export class RoutingCapabilitiesService {
  private cached: { at: number; value: Omit<RoutingCapabilitiesDto, 'access'> } | null = null;

  constructor(
    @Inject(ROUTING_PROVIDER) private readonly provider: RoutingProvider,
    private readonly optimizer: OptimizerClient,
    private readonly redis: RedisService,
  ) {}

  /** Live routing-worker processes: heartbeat keys `vt:health:proc:routing-worker:*` (TTL 20 s). */
  async workers(): Promise<number> {
    try {
      const now = Date.now();
      const keys = await this.redis.client.zrangebyscore(RedisKeys.healthProcessIndex, now - HEARTBEAT_TTL_SEC * 1000, '+inf');
      const mine = keys.filter((k) => k.startsWith(RedisKeys.healthProcess('routing-worker', '')));
      if (!mine.length) return 0;
      return (await Promise.all(mine.map((k) => this.redis.client.exists(k)))).reduce((n, e) => n + e, 0);
    } catch {
      return 0;
    }
  }

  async get(ctx: AuthContext, now = Date.now()): Promise<RoutingCapabilitiesDto> {
    const access = {
      enabled: etmsRoutingEnabled(),
      canView: can(ctx.permissions, ETMS_PLANNING_MENU, 'view'),
      canPlan: can(ctx.permissions, ETMS_PLANNING_MENU, 'create'),
      canEdit: can(ctx.permissions, ETMS_PLANNING_MENU, 'edit'),
      canDelete: can(ctx.permissions, ETMS_PLANNING_MENU, 'delete'),
      canPublish: can(ctx.permissions, ETMS_PLANNING_MENU, 'command') && can(ctx.permissions, 'etms_dispatch', 'command'),
      scope: ctx.dataScope === 'COMPANY' ? ('COMPANY' as const) : ('ASSIGNED' as const),
      support: false,
    };
    if (!this.cached || now - this.cached.at > CACHE_MS) this.cached = { at: now, value: await this.collect() };
    return { ...this.cached.value, access };
  }

  private async collect(): Promise<Omit<RoutingCapabilitiesDto, 'access'>> {
    const enabled = etmsRoutingEnabled();
    const m = readMatrixConfig();
    const etaBands = Object.fromEntries(ETA_BANDS.map((b) => [b, 'uncalibrated'])) as EtaBandStatus;
    const base = { profiles: ROUTING_AVAILABLE_PROFILES, limits: ROUTING_LIMITS, liveTraffic: false as const, attribution: OSM_ATTRIBUTION, etaBands };
    const matrix = { maxPoints: m.maxPoints, maxBuilds: m.maxBuilds, maxSyncCells: ROUTING_LIMITS.matrixCells, maxAsyncCells: ROUTING_LIMITS.asyncMatrixCells, sparseAbovePoints: 60 };
    if (!enabled) {
      return { enabled: false, engine: null, engineReachable: false, engineDegraded: 'ENGINE_DISABLED', engineVersion: null, graphVersion: null, optimizer: false, workers: 0, matrix, ...base };
    }
    const [health, caps, optimizer, workers] = await Promise.all([this.provider.health(), this.provider.capabilities(), this.optimizer.health(), this.workers()]);
    return {
      enabled: true,
      engine: ROUTING_ENGINE,
      engineReachable: health.reachable,
      engineDegraded: health.reachable ? null : (health.degraded ?? 'ENGINE_UNREACHABLE'),
      engineVersion: caps.ok ? caps.value.engineVersion : null,
      graphVersion: caps.ok ? caps.value.graphVersion : null,
      optimizer,
      workers,
      matrix,
      ...base,
    };
  }
}

/**
 * GET /api/routing/capabilities (ETMS planner): whether planning is on, engine / optimiser / worker health and the
 * limits. Behind ETMS auth (company add-on etms, menu etms_planning:view) but NOT behind ETMS_ROUTING, so the planner
 * can say "route planning is switched off". Never returns a host, URL or engine message.
 */
@Controller('routing/capabilities')
@UseGuards(TransportFeatureGuard)
export class RoutingCapabilitiesController {
  constructor(private readonly caps: RoutingCapabilitiesService) {}

  @Get() @RequirePermission(ETMS_PLANNING_MENU, 'view')
  get(@Auth() ctx: AuthContext): Promise<RoutingCapabilitiesDto> {
    return this.caps.get(ctx);
  }
}
