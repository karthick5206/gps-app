import Redis, { RedisOptions } from 'ioredis';
import { readFileSync } from 'node:fs';

/**
 * One place that turns REDIS_URL + REDIS_TLS_* into ioredis options, so every process connects the same way.
 *
 *   REDIS_URL=redis://veetrax:<password>@10.0.0.5:6379          ACL user + password, plain TCP (private network)
 *   REDIS_URL=rediss://veetrax:<password>@cache.example:6380    TLS (ioredis enables TLS for rediss://)
 *   REDIS_TLS_CA_FILE=C:\apps\veetracer\valkey-ca.crt           trust a self-managed CA (otherwise the OS store)
 *   REDIS_TLS_SERVERNAME=valkey.veetrax.internal                 name to verify when connecting by IP
 *   REDIS_TLS_CERT_FILE / REDIS_TLS_KEY_FILE                     client certificate, only with tls-auth-clients yes
 *   REDIS_TLS=on                                                 force TLS with a redis:// URL
 * Username and password come from the URL (ioredis: redis://user:pass@host). Certificate checks are never disabled.
 */
export function redisTlsOptions(url: string, env: NodeJS.ProcessEnv = process.env): RedisOptions['tls'] | undefined {
  const wantTls = url.startsWith('rediss://') || (env.REDIS_TLS ?? '').toLowerCase() === 'on';
  if (!wantTls) return undefined;
  const tls: NonNullable<RedisOptions['tls']> = {};
  if (env.REDIS_TLS_CA_FILE) tls.ca = readFileSync(env.REDIS_TLS_CA_FILE);
  if (env.REDIS_TLS_CERT_FILE) tls.cert = readFileSync(env.REDIS_TLS_CERT_FILE);
  if (env.REDIS_TLS_KEY_FILE) tls.key = readFileSync(env.REDIS_TLS_KEY_FILE);
  if (env.REDIS_TLS_SERVERNAME) tls.servername = env.REDIS_TLS_SERVERNAME;
  return tls;
}

export function redisOptions(url: string, extra: RedisOptions = {}, env: NodeJS.ProcessEnv = process.env): RedisOptions {
  const tls = redisTlsOptions(url, env);
  return tls ? { ...extra, tls: { ...tls, ...(extra.tls ?? {}) } } : extra;
}

/** new Redis(url, options) with the TLS settings from the environment. */
export function createRedis(url: string, extra: RedisOptions = {}): Redis {
  return new Redis(url, redisOptions(url, extra));
}

/** REDIS_URL without its password, for logs. */
export function redactRedisUrl(url: string): string {
  return url.replace(/(rediss?:\/\/[^:@/]*:)[^@]*@/, '$1***@');
}
