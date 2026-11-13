import { Controller, Get, Inject, Injectable, UseGuards } from '@nestjs/common';
import {
  can,
  canOverrideMaxRide,
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
import { RedisService } from '../redis/redis.service';
import { liveRoutingWorkers } from '../routing-switch/routing-readiness';
import { platformRoutingSnapshot, routingOffReasonNow } from '../routing-switch/routing-switch';
import { readMatrixConfig } from '../routing/matrix/matrix-config';
import { OptimizerClient } from '../routing/optimizer/optimizer.client';
import { ROUTING_PROVIDER, type RoutingProvider } from '../routing/provider/routing-provider';
import { PrismaService } from '../prisma/prisma.service';
import { maxRidePolicyOf } from './max-ride';

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
    private readonly prisma: PrismaService,
  ) {}

  /** Live routing-worker processes: heartbeat keys `vt:health:proc:routing-worker:*` (TTL 20 s). */
  workers(): Promise<number> {
    return liveRoutingWorkers(this.redis.client);
  }

  async get(ctx: AuthContext, now = Date.now()): Promise<RoutingCapabilitiesDto> {
    // v1.16: env kill switch, platform switch (process snapshot) and the company's own switch (AuthContext).
    const offReason = routingOffReasonNow(ctx.autoRouting);
    const access = {
      enabled: offReason === null,
      canView: can(ctx.permissions, ETMS_PLANNING_MENU, 'view'),
      canPlan: can(ctx.permissions, ETMS_PLANNING_MENU, 'create'),
      canEdit: can(ctx.permissions, ETMS_PLANNING_MENU, 'edit'),
      canDelete: can(ctx.permissions, ETMS_PLANNING_MENU, 'delete'),
      canPublish: can(ctx.permissions, ETMS_PLANNING_MENU, 'command') && can(ctx.permissions, 'etms_dispatch', 'command'),
      scope: ctx.dataScope === 'COMPANY' ? ('COMPANY' as const) : ('ASSIGNED' as const),
      support: false,
      branches: await this.branches(ctx),
      // Owner decision 1: whether the caller may override the company max ride for one plan, and the policy itself.
      canOverrideMaxRide: canOverrideMaxRide(ctx.permissions, ctx.dataScope),
      maxRidePolicyS: await this.maxRidePolicy(ctx),
    };
    if (!this.cached || now - this.cached.at > CACHE_MS) this.cached = { at: now, value: await this.collect() };
    // The engine / optimiser / worker numbers are platform-wide; `enabled` is this company's decision.
    return { ...this.cached.value, enabled: offReason === null, offReason, access };
  }

  /**
   * T2-D5: the branches a branch-scoped caller plans for (their own, ids and names; never another company's, even if
   * the context named one). Whole-company roles need none, so none are listed.
   */
  private async branches(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
    if (ctx.dataScope === 'COMPANY' || !ctx.branchIds.length) return [];
    const rows = await this.prisma.branch.findMany({ where: { companyId: ctx.companyId, id: { in: ctx.branchIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return rows.map((b) => ({ id: b.id, name: b.name }));
  }

  private async maxRidePolicy(ctx: AuthContext): Promise<number | null> {
    if (ctx.allCompanies) return null;
    return maxRidePolicyOf(this.prisma, ctx.companyId).catch(() => null);
  }

  private async collect(): Promise<Omit<RoutingCapabilitiesDto, 'access'>> {
    // Probed only while routing can run at all (env not off and the platform switch on): no GraphHopper / optimiser
    // traffic from planner page loads while it is switched off.
    const enabled = etmsRoutingEnabled() && platformRoutingSnapshot();
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
 * limits. Behind ETMS auth (company add-on etms, menu etms_planning:view) but NOT behind the routing switches, so the
 * planner can say "automatic routing is switched off" and why (`offReason`: ENV_OFF / PLATFORM_OFF / COMPANY_OFF). Never returns a host, URL or engine message.
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
