import { Logger } from '@nestjs/common';
import type { RoutingUsageDay } from '@veetracer/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { etmsRoutingEnabled } from '../../etms/transport-feature.guard';

/** What one routing call costs (all counters optional, default 0). */
export interface UsageDelta {
  routes?: number;
  matrixCells?: number;
  optimizeJobs?: number;
  cacheHits?: number;
}

export type UsageCounters = Required<UsageDelta>;

export type { RoutingUsageDay };

/** Most days `list` returns (the branch's retention keeps 400 days of rows). */
export const USAGE_MAX_DAYS = 400;

/** UTC calendar day (DATE column). */
export const usageDay = (now = new Date()): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Non-negative whole numbers only; anything else counts as 0 (a metering bug must not corrupt the totals). */
export function normaliseDelta(d: UsageDelta): UsageCounters {
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { routes: n(d.routes), matrixCells: n(d.matrixCells), optimizeJobs: n(d.optimizeJobs), cacheHits: n(d.cacheHits) };
}

/** Storage of the per-company daily counters (`RoutingUsage`, PK (companyId, day), migration routing_engine_v2, P6). */
export interface RoutingUsageStore {
  increment(companyId: string, day: Date, inc: UsageCounters): Promise<void>;
  list(companyId: string, fromDay: Date): Promise<RoutingUsageDay[]>;
}

/** PostgreSQL store: one atomic upsert-increment per call, as on the branch. */
export class PrismaRoutingUsageStore implements RoutingUsageStore {
  constructor(private readonly prisma: Pick<PrismaService, 'routingUsage'>) {}

  async increment(companyId: string, day: Date, inc: UsageCounters): Promise<void> {
    await this.prisma.routingUsage.upsert({
      where: { companyId_day: { companyId, day } },
      create: { companyId, day, ...inc },
      update: {
        routes: { increment: inc.routes },
        matrixCells: { increment: inc.matrixCells },
        optimizeJobs: { increment: inc.optimizeJobs },
        cacheHits: { increment: inc.cacheHits },
      },
    });
  }

  async list(companyId: string, fromDay: Date): Promise<RoutingUsageDay[]> {
    const rows = await this.prisma.routingUsage.findMany({ where: { companyId, day: { gte: fromDay } }, orderBy: { day: 'desc' } });
    return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), routes: r.routes, matrixCells: r.matrixCells, optimizeJobs: r.optimizeJobs, cacheHits: r.cacheHits }));
  }
}

/**
 * Per-company daily routing usage metering (ported from the routing branch's `usage.service.ts`, doc 17 §5.1).
 * Engine-neutral. A metering failure never fails the routing call (logged instead). With `ETMS_ROUTING` off, `add`
 * does nothing and `list` returns no rows, so the switch-off state never touches the table.
 */
export class RoutingUsageService {
  private readonly logger = new Logger(RoutingUsageService.name);
  private readonly store: RoutingUsageStore;

  constructor(prisma: PrismaService, store?: RoutingUsageStore, private readonly enabled: () => boolean = () => etmsRoutingEnabled()) {
    this.store = store ?? new PrismaRoutingUsageStore(prisma);
  }

  async add(companyId: string, d: UsageDelta, now = new Date()): Promise<void> {
    if (!this.enabled()) return;
    const inc = normaliseDelta(d);
    if (!inc.routes && !inc.matrixCells && !inc.optimizeJobs && !inc.cacheHits) return;
    try {
      await this.store.increment(companyId, usageDay(now), inc);
    } catch (e) {
      this.logger.warn(`usage metering failed for ${companyId}: ${(e as Error).message}`);
    }
  }

  /** Last `days` days (newest first) of one company only; `days` is clamped to 1..USAGE_MAX_DAYS. */
  async list(companyId: string, days: number, now = new Date()): Promise<RoutingUsageDay[]> {
    if (!this.enabled()) return [];
    const span = Math.min(USAGE_MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : 1)));
    return this.store.list(companyId, new Date(usageDay(now).getTime() - (span - 1) * 86_400_000));
  }
}
