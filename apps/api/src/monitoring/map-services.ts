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
 *
 * Local only: the services are self-hosted, so only loopback, private-network and single-label hosts are probed (see
 * isLocalHost). A public host (e.g. GEOCODER_URL=https://photon.komoot.io) is a misconfiguration: it is reported as a
 * `maps.<name>` WARN and never fetched, unless MAP_PROBE_ALLOW_PUBLIC=1 is set. URLs shown on the page, in issue
 * messages and in e-mails never carry userinfo, a query string or a fragment (redactUrl).
 */
export interface MapServiceTarget {
  name: MapServiceName;
  label: string;
  /** Full probe URL, or null when the service is not configured. */
  probeUrl: string | null;
  /** Why a configured service is not probed (public host, invalid URL), else null. */
  blocked: string | null;
}

/** Last probe of one service, the input of the `maps.*` checks. */
export interface MapServiceState {
  name: MapServiceName;
  label: string;
  configured: boolean;
  /** Probe URL for display: no userinfo, query or fragment. */
  probeUrl: string | null;
  /** Configured but not probed on purpose (see MapServiceTarget.blocked); reported as a WARN. */
  misconfigured: string | null;
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

/** Set to 1 / true to let the probes reach a public host (not recommended: the services are meant to be local). */
export const MAP_PROBE_ALLOW_PUBLIC_ENV = 'MAP_PROBE_ALLOW_PUBLIC';

/** `<base><path>`, keeping a query string of the base where it belongs (after the path). */
function join(base: string, path: string): string {
  try {
    const u = new URL(base);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}${path}`;
    return u.toString();
  } catch {
    return `${base.replace(/\/+$/, '')}${path}`;
  }
}

/**
 * Loopback, private-network (RFC 1918, link-local, IPv6 ULA) and internal names (`localhost`, `*.localhost`,
 * `*.local`, `*.internal`, `*.lan`, or a single label such as a compose service name). Takes a URL `hostname`.
 * No DNS lookup: a public name that resolves to a private address still counts as public (the safe side).
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!h) return false;
  if (h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return !h.includes('.');
}

/** A URL without userinfo, query string or fragment, for display and logs. */
export function redactUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '(invalid URL)';
  }
}

function blockedReason(probeUrl: string | null, allowPublic: boolean): string | null {
  if (!probeUrl) return null;
  let host: string;
  try {
    host = new URL(probeUrl).hostname;
  } catch {
    return 'not probed: the setting is not a valid URL';
  }
  if (allowPublic || isLocalHost(host)) return null;
  return `not probed: ${host} is not a loopback or private host (self-hosted services only; ${MAP_PROBE_ALLOW_PUBLIC_ENV}=1 allows it)`;
}

/** Which services are configured, from the API environment. */
export function mapServiceTargets(env: NodeJS.ProcessEnv = process.env): MapServiceTarget[] {
  const router = (env.ROUTER_URL ?? '').trim();
  const routerEngine = (env.ROUTER_ENGINE ?? 'valhalla').trim().toLowerCase();
  const geocoder = (env.GEOCODER_URL ?? '').trim();
  const geocoderKind = (env.GEOCODER ?? 'none').trim().toLowerCase();
  const martin = (env.MARTIN_URL ?? '').trim();
  const allowPublic = /^(1|true|yes)$/i.test((env[MAP_PROBE_ALLOW_PUBLIC_ENV] ?? '').trim());
  const target = (name: MapServiceName, label: string, probeUrl: string | null): MapServiceTarget => ({
    name,
    label,
    probeUrl,
    blocked: blockedReason(probeUrl, allowPublic),
  });
  return [
    target('graphhopper', 'Routing (GraphHopper)', router && routerEngine === 'graphhopper' ? join(router, '/health') : null),
    target('photon', 'Addresses (Photon)', geocoder && geocoderKind === 'photon' ? join(geocoder, '/status') : null),
    target('martin', 'Map tiles (Martin)', martin ? join(martin, '/health') : null),
  ];
}

/**
 * One GET with a timeout; never throws. Userinfo in the URL is sent as Basic auth, not in the request URL (fetch
 * rejects such URLs, and its error message would carry the password).
 */
export async function probeMapService(url: string, timeoutMs = MAP_PROBE_TIMEOUT_MS, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
    const u = new URL(url);
    if (u.username || u.password) {
      headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
      u.username = '';
      u.password = '';
    }
    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(timeoutMs), headers });
    // Read the body (releases the connection). The timeout covers it: headers followed by a stalled body is a failure,
    // not "up" (the error goes to the catch below).
    await res.arrayBuffer();
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
      this.state.set(t.name, {
        name: t.name,
        label: t.label,
        configured: !!t.probeUrl,
        probeUrl: redactUrl(t.probeUrl),
        misconfigured: t.probeUrl ? t.blocked : null,
        ok: !(t.probeUrl && t.blocked),
        latencyMs: null,
        error: t.probeUrl ? t.blocked : null,
        consecutiveFailures: 0,
        checkedAt: null,
      });
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
        if (!t.probeUrl || t.blocked) return; // not configured, or a public host: never fetched
        const r = await probeMapService(t.probeUrl, this.timeoutMs, this.fetchImpl);
        const prev = this.state.get(t.name)!;
        this.state.set(t.name, { ...prev, ok: r.ok, latencyMs: r.latencyMs, error: r.error, consecutiveFailures: r.ok ? 0 : prev.consecutiveFailures + 1, checkedAt: now });
      }),
    );
    return this.snapshot();
  }
}
