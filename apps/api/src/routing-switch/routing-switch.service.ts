import { ConflictException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { RoutingOffReason, RoutingPlatformSwitchDto, RoutingReadinessDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OptimizerClient } from '../routing/optimizer/optimizer.client';
import { GraphHopperProvider } from '../routing/provider/graphhopper.provider';
import { evaluateRoutingReadiness, liveRoutingWorkers } from './routing-readiness';
import { prismaPlatformSwitchReader, ROUTING_SETTINGS_ID, routingEnvMode, routingOffReasonFor, RoutingSwitchCache } from './routing-switch';

/** Readiness results are reused this long (System Health refreshes, page loads); a switch-ON always re-checks. */
const READINESS_CACHE_MS = 10_000;
/** The API re-reads the platform switch this often (other API instances see a change within this time). */
const REFRESH_MS = 5_000;

/**
 * v1.16 automatic route planning: the platform switch (Super Admin), its readiness check and the per-company decision.
 * The API keeps the process snapshot fresh (PlanningFeatureGuard reads it synchronously).
 *
 * Switching OFF while jobs run: nothing is interrupted. A job already RUNNING finishes normally (its own timeout bounds
 * it, 60 s solve + the matrix); a job still QUEUED is claimed by the worker and ended FAILED with ROUTING_OFF (its plan
 * goes back to DRAFT, nothing is lost). New jobs are refused at once (the planning routes answer 404, the planner
 * shows "switched off").
 */
@Injectable()
export class RoutingSwitchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RoutingSwitch');
  readonly cache: RoutingSwitchCache;
  private timer: NodeJS.Timeout | null = null;
  private readiness: { at: number; value: RoutingReadinessDto } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly optimizer: OptimizerClient,
    private readonly engine: GraphHopperProvider,
  ) {
    this.cache = new RoutingSwitchCache(prismaPlatformSwitchReader(prisma));
  }

  onModuleInit(): void {
    void this.cache.platformOn(true);
    this.timer = setInterval(() => void this.cache.platformOn(true), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  platformOn(): Promise<boolean> {
    return this.cache.platformOn();
  }

  offReasonFor(companyId: string): Promise<RoutingOffReason | null> {
    return routingOffReasonFor(this.prisma, this.cache, companyId);
  }

  async readinessNow(force = false): Promise<RoutingReadinessDto> {
    const now = Date.now();
    if (!force && this.readiness && now - this.readiness.at < READINESS_CACHE_MS) return this.readiness.value;
    const value = await evaluateRoutingReadiness({
      envMode: routingEnvMode(),
      optimizer: this.optimizer,
      workers: () => liveRoutingWorkers(this.redis.client),
      engine: () => this.engine.health(),
    });
    this.readiness = { at: now, value };
    return value;
  }

  async get(ctx: AuthContext, force = false): Promise<RoutingPlatformSwitchDto> {
    this.assertSuperAdmin(ctx);
    const [row, readiness, companiesOn, openJobs] = await Promise.all([
      this.prisma.routingSettings.findUnique({ where: { id: ROUTING_SETTINGS_ID } }),
      this.readinessNow(force),
      this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Company" WHERE "settings" -> 'etms' ->> 'autoRouting' = 'true'`.then((r) => Number(r[0]?.n ?? 0)),
      this.prisma.routingJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
    ]);
    const enabled = row?.enabled === true;
    this.cache.store(enabled);
    const by = row?.updatedById ? await this.prisma.user.findUnique({ where: { id: row.updatedById }, select: { name: true } }) : null;
    const envMode = routingEnvMode();
    return { enabled, envMode, active: enabled && envMode === 'auto', updatedAt: row?.updatedAt.toISOString() ?? null, updatedBy: by?.name ?? null, companiesOn, openJobs, readiness };
  }

  /**
   * ON is refused (409 ROUTING_NOT_READY, with the fresh readiness) unless every readiness item passes; OFF always works.
   * Every change is audited (entity RoutingSettings), a no-op is not.
   */
  async set(ctx: AuthContext, enabled: boolean): Promise<RoutingPlatformSwitchDto> {
    this.assertSuperAdmin(ctx);
    const before = (await this.prisma.routingSettings.findUnique({ where: { id: ROUTING_SETTINGS_ID }, select: { enabled: true } }))?.enabled === true;
    if (enabled) {
      const readiness = await this.readinessNow(true);
      if (!readiness.ready) {
        throw new ConflictException({ message: 'Automatic route planning cannot be switched on yet: some readiness checks fail', code: 'ROUTING_NOT_READY', readiness });
      }
    }
    if (before !== enabled) {
      await this.prisma.$transaction(async (tx) => {
        await tx.routingSettings.upsert({ where: { id: ROUTING_SETTINGS_ID }, create: { id: ROUTING_SETTINGS_ID, enabled, updatedById: ctx.userId }, update: { enabled, updatedById: ctx.userId } });
        await this.audit.record(ctx, { action: 'UPDATE', entity: 'RoutingSettings', entityId: ROUTING_SETTINGS_ID, before: { enabled: before }, after: { enabled } }, tx);
      });
      this.logger.log(`automatic route planning switched ${enabled ? 'ON' : 'OFF'} by user ${ctx.userId}`);
    }
    this.cache.store(enabled);
    return this.get(ctx);
  }

  private assertSuperAdmin(ctx: AuthContext): void {
    if (!ctx.isSuperAdmin) throw new ForbiddenException({ message: 'Only the Super Admin can change automatic route planning', code: 'FORBIDDEN' });
  }
}
