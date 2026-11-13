import type { PrismaClient } from '@prisma/client';
import { routingEnvModeOf, routingOffReason, transportSettingsOf, type RoutingEnvMode, type RoutingOffReason } from '@veetracer/shared';

/**
 * v1.16 automatic route planning switches (shared routing-switch.ts has the rule):
 *   ETMS_ROUTING=off (or ETMS=off)  → hard kill, nothing runs whatever the UI says (env, read per call);
 *   platform switch (RoutingSettings "default", Super Admin, default OFF) → read from the database with a short cache;
 *   company switch (Company.settings.etms.autoRouting, default OFF) → read with the company row / AuthContext.
 */

export const ROUTING_SETTINGS_ID = 'default';

/** The env kill switch as the API, the worker and the retention job read it. */
export const routingEnvMode = (env: NodeJS.ProcessEnv = process.env): RoutingEnvMode => routingEnvModeOf(env);

/** The company's own switch from `Company.settings` (absent / malformed = off). */
export const companyAutoRouting = (settings: unknown): boolean => transportSettingsOf(settings).autoRouting === true;

/**
 * Process-wide last known platform switch, for synchronous gates (PlanningFeatureGuard.hiddenFor runs inside the global
 * PermissionGuard). Kept fresh by RoutingSwitchCache reads (the API refreshes every few seconds and sets it at once on a
 * change). Starts OFF: a process that never read the database treats routing as off.
 */
let platformSnapshot = false;
export const platformRoutingSnapshot = (): boolean => platformSnapshot;
/** Set by RoutingSwitchCache, and by tests. */
export const setPlatformRoutingSnapshot = (on: boolean): void => {
  platformSnapshot = on;
};

/** Synchronous decision for a request: env + platform snapshot + the caller's company switch. */
export function routingOffReasonNow(companyOn: boolean | undefined, env: NodeJS.ProcessEnv = process.env): RoutingOffReason | null {
  return routingOffReason({ envMode: routingEnvMode(env), platform: platformRoutingSnapshot(), company: companyOn === true });
}

export type PlatformSwitchReader = () => Promise<boolean>;

/** One primary-key lookup; no row = OFF. */
export const prismaPlatformSwitchReader =
  (prisma: Pick<PrismaClient, 'routingSettings'>): PlatformSwitchReader =>
  async () =>
    (await prisma.routingSettings.findUnique({ where: { id: ROUTING_SETTINGS_ID }, select: { enabled: true } }))?.enabled === true;

/**
 * Short-lived cache of the platform switch (default 5 s) so the worker's idle loop and the API's gates cost one tiny
 * query every few seconds at most. A failed read keeps the last known value (a database outage stops jobs anyway).
 */
export class RoutingSwitchCache {
  private value: boolean | null = null;
  private at = 0;
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly read: PlatformSwitchReader,
    readonly ttlMs = 5_000,
    private readonly clock: () => number = Date.now,
    /** Whether this cache feeds the process-wide snapshot (the API and the worker: yes). */
    private readonly publish = true,
  ) {}

  /** Last known value without a read (false until the first read). */
  get known(): boolean {
    return this.value === true;
  }

  async platformOn(force = false): Promise<boolean> {
    if (!force && this.value !== null && this.clock() - this.at < this.ttlMs) return this.value;
    this.inflight ??= this.read()
      .then((v) => {
        this.store(v);
        return v;
      })
      .catch(() => this.value === true)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** After a write in this process: no waiting for the TTL. */
  store(v: boolean): void {
    this.value = v;
    this.at = this.clock();
    if (this.publish) setPlatformRoutingSnapshot(v);
  }
}

/**
 * Asynchronous decision for one company (worker before a job, retention, capabilities): env, platform (cached) and the
 * company row read now.
 */
export async function routingOffReasonFor(
  prisma: Pick<PrismaClient, 'company'>,
  cache: Pick<RoutingSwitchCache, 'platformOn'>,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RoutingOffReason | null> {
  const envMode = routingEnvMode(env);
  if (envMode === 'off') return 'ENV_OFF';
  if (!(await cache.platformOn())) return 'PLATFORM_OFF';
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  return routingOffReason({ envMode, platform: true, company: companyAutoRouting(c?.settings) });
}
