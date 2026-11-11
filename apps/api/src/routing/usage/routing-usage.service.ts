import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { etmsRoutingEnabled } from '../etms-routing-flag';

/** What one routing call costs (all counters optional, default 0). */
export interface UsageDelta {
  routes?: number;
  matrixCells?: number;
  optimizeJobs?: number;
  cacheHits?: number;
}

export type UsageCounters = Required<UsageDelta>;

/** One day of a company's routing usage (API shape; moves to the shared contracts with P4). */
export interface RoutingUsageDay extends UsageCounters {
  /** YYYY-MM-DD (UTC). */
  day: string;
}

/** Most days `list` returns (the branch's retention keeps 400 days of rows). */
export const USAGE_MAX_DAYS = 400;

/** UTC calendar day (DATE column). */
export const usageDay = (now = new Date()): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Non-negative whole numbers only; anything else counts as 0 (a metering bug must not corrupt the totals). */
export function normaliseDelta(d: UsageDelta): UsageCounters {
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { routes: n(d.routes), matrixCells: n(d.matrixCells), optimizeJobs: n(d.optimizeJobs), cacheHits: n(d.cacheHits) };
}

/**
 * Storage of the per-company daily counters. The `RoutingUsage` table (PK `(companyId, day)`, doc 17 §1.3) comes with
 * the E4 routing migration (P6, schema agent); until then nothing calls the store, because metering is off unless
 * `ETMS_ROUTING=on`.
 */
export interface RoutingUsageStore {
  increment(companyId: string, day: Date, inc: UsageCounters): Promise<void>;
  list(companyId: string, fromDay: Date): Promise<RoutingUsageDay[]>;
}

/**
 * PostgreSQL store: one atomic upsert-increment per call (the branch's Prisma `upsert` with `increment`, written as
 * SQL so it compiles before the model exists; switch to `prisma.routingUsage` once P6 lands).
 */
export class PrismaRoutingUsageStore implements RoutingUsageStore {
  constructor(private readonly prisma: Pick<PrismaService, '$executeRaw' | '$queryRaw'>) {}

  async increment(companyId: string, day: Date, inc: UsageCounters): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "RoutingUsage" ("companyId", "day", "routes", "matrixCells", "optimizeJobs", "cacheHits", "updatedAt")
      VALUES (${companyId}::uuid, ${day}::date, ${inc.routes}, ${inc.matrixCells}, ${inc.optimizeJobs}, ${inc.cacheHits}, now())
      ON CONFLICT ("companyId", "day") DO UPDATE SET
        "routes" = "RoutingUsage"."routes" + EXCLUDED."routes",
        "matrixCells" = "RoutingUsage"."matrixCells" + EXCLUDED."matrixCells",
        "optimizeJobs" = "RoutingUsage"."optimizeJobs" + EXCLUDED."optimizeJobs",
        "cacheHits" = "RoutingUsage"."cacheHits" + EXCLUDED."cacheHits",
        "updatedAt" = now()`);
  }

  async list(companyId: string, fromDay: Date): Promise<RoutingUsageDay[]> {
    const rows = await this.prisma.$queryRaw<{ day: Date; routes: number; matrixCells: number; optimizeJobs: number; cacheHits: number }[]>(Prisma.sql`
      SELECT "day", "routes", "matrixCells", "optimizeJobs", "cacheHits" FROM "RoutingUsage"
      WHERE "companyId" = ${companyId}::uuid AND "day" >= ${fromDay}::date ORDER BY "day" DESC`);
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
