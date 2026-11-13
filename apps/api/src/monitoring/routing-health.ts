import type { ProcessHeartbeat, RoutingHealthDto, RoutingReadinessDto } from '@veetracer/shared';
import { etmsRoutingEnabled } from '../etms/transport-feature.guard';
import type { RoutingJobStore } from '../routing-jobs/job-store';
import { optimizerHealth, OptimizerHealth, optimizerProbeUrl } from '../routing-jobs/optimizer-port';
import { OptimizerClient, readOptimizerConfig } from '../routing/optimizer/optimizer.client';

/** Probes are reused for this long (the monitor evaluates every 15 s; page refreshes add no probes). */
const OPTIMIZER_PROBE_MIN_INTERVAL_MS = 10_000;

export const DISABLED_ROUTING_HEALTH: RoutingHealthDto = {
  enabled: false,
  status: 'DISABLED',
  workers: 0,
  optimizer: { configured: false, ok: false, probeUrl: null, latencyMs: null, error: null, checkedAt: null },
  jobs: null,
};

/** v1.16: the platform switch and the readiness checklist (RoutingSwitchService); absent in tests = platform on, no checklist. */
export interface RoutingSwitchPort {
  platformOn(): Promise<boolean>;
  readinessNow(): Promise<RoutingReadinessDto | null>;
}

/**
 * System Health entry of ETMS planning (E4 WP 4.2): routing worker heartbeats, the optimiser's /health and the job
 * queue counts. v1.16:
 *   - ETMS_ROUTING=off (kill switch): DISABLED, nothing probed or counted, no readiness;
 *   - platform switch off: DISABLED ("installed, switched off"), no issue raised, but the worker count and the
 *     readiness checklist are shown so the Super Admin sees what switching on needs;
 *   - platform switch on: as before (issues routing.* from checks.ts) plus the checklist.
 */
export class RoutingHealthMonitor {
  private last: { at: number; h: OptimizerHealth } | null = null;

  constructor(
    private readonly store: Pick<RoutingJobStore, 'stats'>,
    private readonly optimizer: Pick<OptimizerClient, 'health' | 'configured' | 'config'> = new OptimizerClient(readOptimizerConfig()),
    private readonly enabled: () => boolean = () => etmsRoutingEnabled(),
    private readonly switches?: RoutingSwitchPort,
  ) {}

  async collect(heartbeats: ProcessHeartbeat[], now: number, staleSec: number): Promise<RoutingHealthDto> {
    if (!this.enabled()) return { ...DISABLED_ROUTING_HEALTH, switch: { envMode: 'off', platform: (await this.switches?.platformOn().catch(() => false)) ?? false }, readiness: null };
    const platform = this.switches ? await this.switches.platformOn().catch(() => false) : true;
    const readiness = this.switches ? await this.switches.readinessNow().catch(() => null) : undefined;
    const workers = heartbeats.filter((h) => h.role === 'routing-worker' && (now - Date.parse(h.at)) / 1000 <= staleSec).length;
    const extra = { switch: { envMode: 'auto' as const, platform }, ...(readiness !== undefined ? { readiness } : {}) };
    if (!platform) return { ...DISABLED_ROUTING_HEALTH, workers, ...extra };
    if (!this.last || now - this.last.at >= OPTIMIZER_PROBE_MIN_INTERVAL_MS) this.last = { at: now, h: await optimizerHealth(this.optimizer) };
    const h = this.last.h;
    const jobs = await this.store
      .stats(new Date(now))
      .then((s) => ({ queued: s.queued, running: s.running, failed24h: s.failed24h, oldestQueuedAgeSec: s.oldestQueuedAt ? Math.max(0, Math.round((now - s.oldestQueuedAt.getTime()) / 1000)) : null }))
      .catch(() => null);
    return {
      enabled: true,
      status: 'OK', // set from the routing.* issues by the caller
      workers,
      optimizer: { configured: h.configured, ok: h.ok, probeUrl: optimizerProbeUrl(this.optimizer), latencyMs: h.latencyMs, error: h.error, checkedAt: new Date(this.last.at).toISOString() },
      jobs,
      ...extra,
    };
  }
}
