import { isLocalHost } from '../monitoring/map-services';

/**
 * Self-hosted routing services (GraphHopper, the OR-Tools optimiser) must be reached on a private network. Ported from
 * the routing branch (`routing-v2/private-url.ts`, doc 17 §5.1) onto the map-service rule, so the API has one
 * definition of "local": `isLocalHost` (loopback, RFC 1918, link-local, IPv6 ULA, `localhost`, `*.local` /
 * `*.internal` / `*.lan`, single-label service names). No DNS lookup: a public name that resolves to a private address
 * is still refused (the safe side).
 *
 * Returns why a URL is refused, or null when it is acceptable. `ROUTING_ALLOW_PUBLIC_ENGINE=1` is an explicit escape
 * hatch for a test rig (never set in production), like `MAP_PROBE_ALLOW_PUBLIC` for the probes.
 */
export const ROUTING_ALLOW_PUBLIC_ENV = 'ROUTING_ALLOW_PUBLIC_ENGINE';

export function privateServiceUrlProblem(raw: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `unsupported protocol ${u.protocol}`;
  if (u.username || u.password) return 'credentials in the URL are not allowed (use the *_TOKEN variable)';
  if (/^(1|true|yes)$/i.test((env[ROUTING_ALLOW_PUBLIC_ENV] ?? '').trim())) return null;
  if (isLocalHost(u.hostname)) return null;
  return `${u.hostname} is not a loopback or private host (self-hosted services only)`;
}
