import { isIP } from 'node:net';
import { isLocalHost } from '../monitoring/map-services';

export type ApiExposure = 'loopback' | 'private' | 'all-interfaces' | 'specific';

export interface ApiBinding {
  /** Address passed to `app.listen`; undefined = Node's default (every interface, the pre-1.12 behaviour). */
  host: string | undefined;
  exposure: ApiExposure;
}

/**
 * Network binding of the HTTP API (`API_HOST`, doc 17 §5.1 "port as is", from the routing branch's RR-23 hardening).
 *
 * Unset:
 * - `NODE_ENV=production`: 127.0.0.1. Production reaches the API only through a reverse proxy on the same host
 *   (Ubuntu: Caddy `reverse_proxy 127.0.0.1:4000`; Windows: cloudflared and `vite preview` on this machine), so
 *   loopback is enough and nothing else on the network can bypass the proxy.
 * - anything else (development, tests): Node's default, every interface, exactly as before, so a phone on the LAN
 *   (Expo) and the Vite dev proxy keep working.
 *
 * Set (explicit opt-in, any environment):
 * - `loopback` / `localhost` / `127.x` / `::1`: loopback;
 * - a private address (RFC 1918, link-local, IPv6 ULA; same test as the map-service probes, `isLocalHost`) for a
 *   proxy on another host, e.g. a WireGuard peer;
 * - `0.0.0.0` / `::`: every interface (needed inside Docker, where Caddy is another container);
 * - any other literal address: allowed, logged as a warning.
 * Host names are refused: a name could resolve to a public address.
 */
export function resolveApiHost(raw: string | undefined, nodeEnv: string | undefined = process.env.NODE_ENV): ApiBinding {
  const v = (raw ?? '').trim();
  if (!v) return nodeEnv === 'production' ? { host: '127.0.0.1', exposure: 'loopback' } : { host: undefined, exposure: 'all-interfaces' };
  if (v === 'loopback' || v === 'localhost') return { host: '127.0.0.1', exposure: 'loopback' };
  if (v === '0.0.0.0' || v === '::') return { host: v, exposure: 'all-interfaces' };
  if (!isIP(v)) throw new Error(`API_HOST must be an IP address, "loopback", "0.0.0.0" or "::" (got "${v}")`);
  if (v === '::1' || v.startsWith('127.')) return { host: v, exposure: 'loopback' };
  if (isLocalHost(v)) return { host: v, exposure: 'private' };
  return { host: v, exposure: 'specific' };
}

/** The address for the startup log line (IPv6 in brackets). */
export function displayHost(b: ApiBinding): string {
  if (!b.host) return '*';
  return b.host.includes(':') ? `[${b.host}]` : b.host;
}
