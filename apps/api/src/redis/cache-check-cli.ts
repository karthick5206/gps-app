/**
 * Pre-cut-over check of a cache from the app server, with exactly the app's connection code (TLS / ACL from
 * REDIS_TLS_* and the URL). Prints version, ACL user, round-trip time and exercises the command families VeeTrax needs
 * on throw-away keys (vt:cutover:check:*), which are deleted again.
 *
 *   node dist/redis/cache-check-cli.js --url "redis://veetrax:<password>@10.0.0.5:6379"
 *   node dist/redis/cache-check-cli.js            (uses REDIS_URL from the environment / .env)
 * Exit code 0 when every check passed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from '../config/env';
import { createRedis, redactRedisUrl } from './connection';

async function main(): Promise<number> {
  const envFile = join(APP_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const i = process.argv.indexOf('--url');
  const url = i >= 0 ? process.argv[i + 1] : process.env.REDIS_URL;
  if (!url) throw new Error('pass --url or set REDIS_URL');
  console.log(`cache: ${redactRedisUrl(url)}`);
  const r = createRedis(url, { maxRetriesPerRequest: 1, connectTimeout: 5000, retryStrategy: () => null });
  r.on('error', () => undefined);
  const k = `vt:cutover:check:${process.pid}`;
  let failed = 0;
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const out = await fn();
      console.log(`ok    ${name}${out !== undefined ? `: ${String(out)}` : ''}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}: ${(error as Error).message}`);
    }
  };
  await step('PING', () => r.ping());
  await step('server', async () => {
    const info = await r.info('server');
    return /valkey_version:(\S+)/.exec(info)?.[1] ?? /redis_version:(\S+)/.exec(info)?.[1];
  });
  await step('ACL user', () => r.call('ACL', 'WHOAMI').catch(() => '(ACL WHOAMI not available)'));
  await step('round trip (median of 50 PINGs, ms)', async () => {
    const t: number[] = [];
    for (let n = 0; n < 50; n++) {
      const s = performance.now();
      await r.ping();
      t.push(performance.now() - s);
    }
    return t.sort((a, b) => a - b)[25].toFixed(2);
  });
  await step('persistence (appendonly)', async () => {
    const p = await r.info('persistence');
    return `aof_enabled=${/aof_enabled:(\d)/.exec(p)?.[1]}, rdb_last_bgsave_status=${/rdb_last_bgsave_status:(\w+)/.exec(p)?.[1]}`;
  });
  await step('streams: XADD / XGROUP / XREADGROUP / XACK / XAUTOCLAIM / XINFO lag', async () => {
    await r.xadd(`${k}:s`, 'MAXLEN', '~', 100, '*', 'data', '{}');
    await r.xgroup('CREATE', `${k}:s`, 'g', '0', 'MKSTREAM');
    const got = (await r.xreadgroup('GROUP', 'g', 'c', 'COUNT', 1, 'STREAMS', `${k}:s`, '>')) as [string, [string, string[]][]][];
    await r.xautoclaim(`${k}:s`, 'g', 'c', 0, '0-0', 'COUNT', 1);
    await r.xack(`${k}:s`, 'g', got[0][1][0][0]);
    const groups = (await r.xinfo('GROUPS', `${k}:s`)) as unknown[][];
    if (!groups[0].includes('lag')) throw new Error('XINFO GROUPS has no lag field (needs Redis 7 semantics)');
  });
  await step('Lua EVAL, MULTI, SET NX PX, SET … GET, LPOP count', async () => {
    await r.set(`${k}:a`, '1', 'PX', 60_000, 'NX');
    await r.eval("return redis.call('GET', KEYS[1])", 1, `${k}:a`);
    await r.multi().incr(`${k}:n`).expire(`${k}:n`, 60).exec();
    await r.call('SET', `${k}:a`, '2', 'EX', '60', 'GET');
    await r.rpush(`${k}:l`, 'x', 'y');
    await r.lpop(`${k}:l`, 2);
  });
  await step('Pub/Sub on vt:*', () => r.publish(`${k}:ch`, 'x'));
  await step('cleanup', () => r.del(`${k}:s`, `${k}:a`, `${k}:n`, `${k}:l`));
  r.disconnect();
  console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
