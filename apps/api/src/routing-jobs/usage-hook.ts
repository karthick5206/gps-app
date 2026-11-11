import { Logger } from '@nestjs/common';

/** Per-company daily routing usage (shared `RoutingUsageDay` counters). */
export interface UsageDelta {
  routes?: number;
  matrixCells?: number;
  optimizeJobs?: number;
  cacheHits?: number;
}

/**
 * Metering hook of the jobs and the worker. E4-D ports the usage module (`RoutingUsage`, upsert-increment per UTC
 * day); bind it to `ROUTING_USAGE_HOOK` when it lands. Until then the default only counts in memory (worker
 * heartbeat metrics). A metering failure never fails a job.
 */
export interface RoutingUsageHook {
  add(companyId: string, delta: UsageDelta): Promise<void>;
}

export const ROUTING_USAGE_HOOK = Symbol('ROUTING_USAGE_HOOK');

export class InMemoryUsageHook implements RoutingUsageHook {
  private readonly logger = new Logger('RoutingUsage');
  readonly totals: Required<UsageDelta> = { routes: 0, matrixCells: 0, optimizeJobs: 0, cacheHits: 0 };

  async add(_companyId: string, d: UsageDelta): Promise<void> {
    try {
      this.totals.routes += d.routes ?? 0;
      this.totals.matrixCells += d.matrixCells ?? 0;
      this.totals.optimizeJobs += d.optimizeJobs ?? 0;
      this.totals.cacheHits += d.cacheHits ?? 0;
    } catch (e) {
      this.logger.warn(`usage metering failed: ${(e as Error).message}`);
    }
  }
}

/** Wraps a hook so a throwing implementation never fails the caller. */
export function safeUsage(hook: RoutingUsageHook, logger = new Logger('RoutingUsage')): RoutingUsageHook {
  return {
    add: async (companyId, d) => {
      try {
        await hook.add(companyId, d);
      } catch (e) {
        logger.warn(`usage metering failed for a company: ${(e as Error).message}`);
      }
    },
  };
}
