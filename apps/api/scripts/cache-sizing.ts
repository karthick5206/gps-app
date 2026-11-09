/**
 * Measures how much cache memory VeeTrax needs (docs/reliability/valkey-sizing.md). Run against a TEST cache only:
 * it writes ~N temporary stream entries under vt:sizing:* and deletes them again.
 *
 *   npx tsx scripts/cache-sizing.ts --url <redis url> [--entries 100000]
 *
 * Reports bytes per vt:positions entry (a real gateway entry copied from vt:positions, plus a heavier Teltonika-like
 * entry with ~30 IO attributes) and bytes per tracked object (vt:live + vt:track + vt:alertstate + detector state).
 */
import { createRedis } from '../src/redis/connection';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const r = createRedis(arg('url', process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'), { maxRetriesPerRequest: 2 });
  const n = Number(arg('entries', '100000'));
  const used = async () => Number(/used_memory:(\d+)/.exec(await r.info('memory'))![1]);

  const sample = (await r.xrevrange('vt:positions', '+', '-', 'COUNT', 1)) as [string, string[]][];
  if (!sample.length) throw new Error('vt:positions is empty: run some simulator traffic first');
  const fields = sample[0][1];
  const data = fields[fields.indexOf('data') + 1];
  const pos = JSON.parse(data) as Record<string, unknown>;
  const heavy = { ...pos, protocol: 'teltonika', attributes: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`io${i + 1}`, i * 137])) };

  const measure = async (key: string, make: (i: number) => string) => {
    await r.del(key);
    const before = await used();
    for (let i = 0; i < n; i += 1000) {
      const p = r.pipeline();
      for (let j = i; j < Math.min(n, i + 1000); j++) p.xadd(key, '*', 'data', make(j), 'remote', '106.51.12.34:40112', 'mid', `a1b2c3d4-${j.toString(36)}`);
      await p.exec();
    }
    const after = await used();
    await r.del(key);
    return (after - before) / n;
  };
  const t0 = Date.parse(String(pos.fixTime));
  const gt06 = await measure('vt:sizing:gt06', (i) => JSON.stringify({ ...pos, fixTime: new Date(t0 + i * 1000).toISOString(), receivedAt: new Date(t0 + i * 1000).toISOString() }));
  const telt = await measure('vt:sizing:teltonika', (i) => JSON.stringify({ ...heavy, fixTime: new Date(t0 + i * 1000).toISOString() }));

  // Per tracked object.
  const perPrefix: Record<string, number[]> = {};
  for (const pattern of ['vt:live:*', 'vt:track:*', 'vt:alertstate:*', 'vt:fuel:*', 'vt:io:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      for (const k of keys) {
        if (k.startsWith('vt:live:company:')) continue;
        const bytes = Number(await r.call('MEMORY', 'USAGE', k));
        (perPrefix[pattern] ??= []).push(bytes);
      }
    } while (cursor !== '0');
  }
  const avg = (xs: number[] = []) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const perObject = Object.values(perPrefix).reduce((s, xs) => s + avg(xs), 0);
  const baseline = await used();
  const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
  console.log(JSON.stringify({
    entriesMeasured: n,
    gatewayEntryJsonBytes: data.length,
    bytesPerStreamEntryGt06: Math.round(gt06),
    bytesPerStreamEntryTeltonika30io: Math.round(telt),
    bytesPerObject: perObject,
    perObjectBreakdown: Object.fromEntries(Object.entries(perPrefix).map(([k, xs]) => [k, { keys: xs.length, avgBytes: avg(xs) }])),
    usedMemoryNow: baseline,
  }, null, 2));
  console.log(`stream full at 2,000,000 entries: GT06 ${mb(gt06 * 2e6)}, Teltonika ${mb(telt * 2e6)}; 1,000,000: GT06 ${mb(gt06 * 1e6)}`);
  console.log(`live/detector state: 1,000 objects ${mb(perObject * 1000)}, 10,000 objects ${mb(perObject * 10000)}`);
  r.disconnect();
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
