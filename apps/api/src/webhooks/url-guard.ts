import { LookupAddress, lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF protection for webhook URLs: https only (plain http to localhost outside production), no credentials in the
 * URL, and every resolved address must be public unless private targets are explicitly allowed.
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** Loopback, private, link-local, CGNAT, multicast, documentation and reserved ranges (IPv4-mapped IPv6 included). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = isIP(v);
  if (!family) return true; // not an address: refuse
  return PRIVATE.check(v, family === 4 ? 'ipv4' : 'ipv6');
}

export interface UrlPolicy {
  /** Production: https only and no private / loopback targets. */
  production: boolean;
  /** Allow private targets even in production (WEBHOOK_ALLOW_PRIVATE=true, e.g. an on-premise ERP). */
  allowPrivate: boolean;
}

export function webhookUrlPolicy(env: NodeJS.ProcessEnv = process.env): UrlPolicy {
  const production = env.NODE_ENV === 'production';
  return { production, allowPrivate: env.WEBHOOK_ALLOW_PRIVATE === 'true' || !production };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Syntactic check of an endpoint URL; returns an error message or null. */
export function checkWebhookUrl(raw: string, policy: UrlPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a valid URL';
  }
  if (raw.length > 2000) return 'The URL is too long';
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !policy.production)) {
    return 'The URL must use https:// (http:// only to localhost during development)';
  }
  if (url.username || url.password) return 'The URL must not contain a user name or password';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate && (local || (isIP(host) && isPrivateAddress(host)))) {
    return 'The URL must point to a public internet address';
  }
  return null;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `lookup` for http(s).request that refuses private addresses at connect time, so a hostname that re-resolves to an
 * internal address (DNS rebinding) is still blocked.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (!list.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(Object.assign(new Error(`${hostname} resolves to a private address (${bad.address})`), { code: 'EPRIVATE' }), []);
      }
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}
