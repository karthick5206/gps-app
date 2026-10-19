import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { AppEnv } from '../config/env';
import { checkWebhookUrl, isPrivateAddress } from '../webhooks/url-guard';

/**
 * Safety checks of forwarding targets:
 *  - loop guard: never forward to VeeTrax itself (loopback, this host's addresses or the configured public hosts) on a
 *    device / media port — that would feed the copy back into the gateway;
 *  - SSRF guard: in production no private / loopback targets unless RELAY_ALLOW_PRIVATE=true (HTTP_JSON reuses the
 *    webhook URL policy: https only, no credentials in the URL).
 */
export interface RelayPolicy {
  production: boolean;
  allowPrivate: boolean;
  /** Lower-case host names / addresses of this deployment (RELAY_OWN_HOSTS, MEDIA_PUBLIC_HOST, WEB_URL host). */
  ownHosts: string[];
  /** Device-facing ports of this deployment (GT06, Teltonika, JT808, AIS-140, media, attachments). */
  devicePorts: number[];
}

export const RELAY_LIMITS = {
  maxTargets: () => positive(process.env.RELAY_MAX_TARGETS, 20),
  maxSocketsPerTarget: () => positive(process.env.RELAY_MAX_SOCKETS_PER_TARGET, 5000),
  bufferBytes: () => positive(process.env.RELAY_BUFFER_KB, 64) * 1024,
  bufferFrames: () => positive(process.env.RELAY_BUFFER_FRAMES, 500),
  httpQueueItems: () => positive(process.env.RELAY_HTTP_QUEUE, 10_000),
};

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function relayPolicy(env: Pick<AppEnv, 'gt06Port' | 'teltonikaPort' | 'jt808Port' | 'ais140Port' | 'mediaPort' | 'attachPort' | 'mediaPublicHost' | 'webUrl'>, raw: NodeJS.ProcessEnv = process.env): RelayPolicy {
  const production = raw.NODE_ENV === 'production';
  const ownHosts = new Set<string>(['localhost']);
  for (const h of (raw.RELAY_OWN_HOSTS ?? '').split(',')) if (h.trim()) ownHosts.add(h.trim().toLowerCase());
  if (env.mediaPublicHost) ownHosts.add(env.mediaPublicHost.toLowerCase());
  try {
    ownHosts.add(new URL(env.webUrl).hostname.toLowerCase());
  } catch {
    // no usable WEB_URL
  }
  const devicePorts = [env.gt06Port, env.teltonikaPort, env.jt808Port, env.ais140Port, env.mediaPort, env.attachPort].filter((p) => p > 0);
  return { production, allowPrivate: raw.RELAY_ALLOW_PRIVATE === 'true' || !production, ownHosts: [...ownHosts], devicePorts };
}

/** This machine's interface addresses (plus loopback). */
export function localAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.add(a.address.toLowerCase());
  return out;
}

const isLoopback = (ip: string) => /^127\./.test(ip) || ip === '::1' || ip === '0.0.0.0' || ip === '::' || /^::ffff:127\./.test(ip);

/** Host name rules (syntax only): returns an error or null. */
export function checkTcpHost(host: string, port: number, policy: RelayPolicy): string | null {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h.length > 253) return 'Enter the host name or IP address';
  if (!isIP(h) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) return 'Enter a valid host name or IP address';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter a port between 1 and 65535';
  const own = policy.ownHosts.includes(h) || (isIP(h) > 0 && isLoopback(h));
  if (own && policy.devicePorts.includes(port)) return 'This points back at VeeTrax itself (loop): choose another server';
  if (!policy.allowPrivate && isIP(h) && isPrivateAddress(h)) return 'The host must be a public internet address';
  return null;
}

/** Resolved-address rules, used before saving and by the gateway before every connect. */
export function checkAddresses(addresses: string[], port: number, policy: RelayPolicy, local: Set<string> = localAddresses()): string | null {
  for (const raw of addresses) {
    const a = raw.toLowerCase();
    const self = isLoopback(a) || local.has(a) || policy.ownHosts.includes(a);
    if (self && policy.devicePorts.includes(port)) return `${a}:${port} is VeeTrax itself (loop)`;
    if (!policy.allowPrivate && isPrivateAddress(a)) return `${a} is a private address`;
  }
  return null;
}

/** Full check of a RAW_TCP target, including DNS resolution of the host. */
export async function checkTcpTarget(host: string, port: number, policy: RelayPolicy): Promise<string | null> {
  const syntax = checkTcpHost(host, port, policy);
  if (syntax) return syntax;
  const h = host.trim().replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(h) ? [h] : (await lookup(h, { all: true })).map((a) => a.address);
  } catch {
    return `Cannot resolve ${h}`;
  }
  return checkAddresses(addresses, port, policy);
}

/** HTTP_JSON target URL: webhook URL policy plus "not VeeTrax itself". */
export function checkHttpTarget(url: string, policy: RelayPolicy): string | null {
  const err = checkWebhookUrl(url, { production: policy.production, allowPrivate: policy.allowPrivate });
  if (err) return err;
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (policy.production && policy.ownHosts.includes(host)) return 'This points back at VeeTrax itself (loop): choose another server';
  return null;
}
