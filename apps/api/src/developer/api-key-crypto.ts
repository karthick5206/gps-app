import { API_SCOPES, ApiScope } from '@veetracer/shared';
import { BlockList, isIP } from 'node:net';
import { randomToken, sha256 } from '../common/secrets';

/** Every customer API key starts with this; user access tokens (JWTs) never do. */
export const API_KEY_PREFIX = 'vtx_live_';
/** Characters of the key kept for display (`vtx_live_` + 6). */
const DISPLAY_CHARS = API_KEY_PREFIX.length + 6;
const KEY_RE = /^vtx_live_[A-Za-z0-9_-]{40,64}$/;

/** A new key: 32 random bytes (base64url, 43 chars) after the prefix. */
export function generateApiKey(): { secret: string; hash: string; prefix: string } {
  const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { secret, hash: hashApiKey(secret), prefix: displayPrefix(secret) };
}

/** Keys are high-entropy, so a fast SHA-256 is enough at rest (no bcrypt cost on every request). */
export const hashApiKey = (secret: string): string => sha256(secret);

export const displayPrefix = (secret: string): string => secret.slice(0, DISPLAY_CHARS);

export const looksLikeApiKey = (token: string): boolean => token.startsWith('vtx_');

export const isWellFormedApiKey = (token: string): boolean => KEY_RE.test(token);

/** Unknown scopes are dropped; `write:commands:critical` implies `write:commands`. */
export function normaliseScopes(scopes: readonly string[]): ApiScope[] {
  const set = new Set(scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)));
  if (set.has('write:commands:critical')) set.add('write:commands');
  return API_SCOPES.filter((s) => set.has(s));
}

export function hasScope(granted: readonly string[], required: ApiScope): boolean {
  if (granted.includes(required)) return true;
  return required === 'write:commands' && granted.includes('write:commands:critical');
}

/** Normalised allow-list entry (IPv4/IPv6 address or CIDR), or null when invalid. */
export function parseIpEntry(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const [addr, bits, extra] = v.split('/');
  if (extra !== undefined) return null;
  const family = isIP(addr);
  if (!family) return null;
  if (bits === undefined) return addr.toLowerCase();
  if (!/^\d{1,3}$/.test(bits)) return null;
  const n = Number(bits);
  if (n > (family === 4 ? 32 : 128)) return null;
  return `${addr.toLowerCase()}/${n}`;
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`, as Express reports IPv4 callers on dual-stack sockets) → `1.2.3.4`. */
export function unmapIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
}

/** True when `ip` matches one of the entries; an empty list allows every address. */
export function ipAllowed(entries: readonly string[], ip: string | null): boolean {
  if (!entries.length) return true;
  if (!ip) return false;
  const addr = unmapIp(ip);
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of entries) {
    const [a, bits] = entry.split('/');
    const f = isIP(a);
    if (!f) continue;
    const type = f === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(a, type);
    else list.addSubnet(a, Number(bits), type);
  }
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}
