import { MapServiceName } from '@veetracer/shared';
import { shortError } from './util';

/**
 * Health probes of the self-hosted map services (ops/deploy/linux/maps/README.md), run by SystemHealthService.collect.
 *
 *   graphhopper  GET <ROUTER_URL>/health    when ROUTER_URL is set and ROUTER_ENGINE=graphhopper
 *   photon       GET <GEOCODER_URL>/status  when GEOCODER=photon and GEOCODER_URL is set
 *   martin       GET <MARTIN_URL>/health    when MARTIN_URL is set (production http://127.0.0.1:3000)
 *
 * A service whose setting is missing is "not configured": it is not probed and raises nothing. Any 2xx answer within
 * the timeout counts as up. Results are cached for `minIntervalMs`, so page refreshes do not add probes, and the
 * checks only raise an issue after MAP_FAILS_BEFORE_ISSUE failed probes in a row (no flapping on one slow answer).
 */
export interface MapServiceTarget {
  name: MapServiceName;
  label: string;
  /** Full probe URL, or null when the service is not configured. */
  probeUrl: string | null;
}

/** Last probe of one service, the input of the `maps.*` checks. */
export interface MapServiceState {
  name: MapServiceName;
  label: string;
  configured: boolean;
  probeUrl: string | null;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  consecutiveFailures: number;
  checkedAt: number | null;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export const MAP_PROBE_TIMEOUT_MS = 2000;
/** The monitor evaluates every 15 s; probes are reused for 10 s so the API page adds no extra traffic. */
export const MAP_PROBE_MIN_INTERVAL_MS = 10_000;

const join = (base: string, path: string) => `${base.trim().replace(/\/+$/, '')}${path}`;

/** Which services are configured, from the API environment. */
export function mapServiceTargets(env: NodeJS.ProcessEnv = process.env): MapServiceTarget[] {
  const router = (env.ROUTER_URL ?? '').trim();
  const routerEngine = (env.ROUTER_ENGINE ?? 'valhalla').trim().toLowerCase();
  const geocoder = (env.GEOCODER_URL ?? '').trim();
  const geocoderKind = (env.GEOCODER ?? 'none').trim().toLowerCase();
  const martin = (env.MARTIN_URL ?? '').trim();
  return [
    { name: 'graphhopper', label: 'Routing (GraphHopper)', probeUrl: router && routerEngine === 'graphhopper' ? join(router, '/health') : null },
    { name: 'photon', label: 'Addresses (Photon)', probeUrl: geocoder && geocoderKind === 'photon' ? join(geocoder, '/status') : null },
    { name: 'martin', label: 'Map tiles (Martin)', probeUrl: martin ? join(martin, '/health') : null },
  ];
}

/** One GET with a timeout; never throws. */
export async function probeMapService(url: string, timeoutMs = MAP_PROBE_TIMEOUT_MS, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/plain, */*' } });
    // Drain the body so the connection is released.
    await res.arrayBuffer().catch(() => undefined);
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    return res.ok ? { ok: true, latencyMs, error: null } : { ok: false, latencyMs, error: `HTTP ${res.status}` };
  } catch (error) {
    const e = error as { name?: string; cause?: { code?: string } };
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : (e?.cause?.code ?? shortError(error));
    return { ok: false, latencyMs: null, error: reason };
  }
}

export interface MapServiceMonitorOptions {
  timeoutMs?: number;
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

/** Keeps the last probe result per service in memory (one instance per API process). */
export class MapServiceMonitor {
  private readonly state = new Map<MapServiceName, MapServiceState>();
  private inflight: Promise<MapServiceState[]> | null = null;
  private lastRun = 0;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly targets: MapServiceTarget[] = mapServiceTargets(),
    options: MapServiceMonitorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? MAP_PROBE_TIMEOUT_MS;
    this.minIntervalMs = options.minIntervalMs ?? MAP_PROBE_MIN_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    for (const t of targets) {
      this.state.set(t.name, { ...t, configured: !!t.probeUrl, ok: true, latencyMs: null, error: null, consecutiveFailures: 0, checkedAt: null });
    }
  }

  /** Current states, probing first when the last probe is older than minIntervalMs. */
  async collect(now = Date.now()): Promise<MapServiceState[]> {
    if (this.inflight) return this.inflight;
    if (this.lastRun && now - this.lastRun < this.minIntervalMs) return this.snapshot();
    this.inflight = this.probeAll(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  snapshot(): MapServiceState[] {
    return this.targets.map((t) => ({ ...this.state.get(t.name)! }));
  }

  private async probeAll(now: number): Promise<MapServiceState[]> {
    this.lastRun = now;
    await Promise.all(
      this.targets.map(async (t) => {
        if (!t.probeUrl) return;
        const r = await probeMapService(t.probeUrl, this.timeoutMs, this.fetchImpl);
        const prev = this.state.get(t.name)!;
        this.state.set(t.name, { ...prev, ok: r.ok, latencyMs: r.latencyMs, error: r.error, consecutiveFailures: r.ok ? 0 : prev.consecutiveFailures + 1, checkedAt: now });
      }),
    );
    return this.snapshot();
  }
}
