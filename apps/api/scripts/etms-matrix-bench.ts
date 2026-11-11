/**
 * Indicative benchmark of the ETMS M1 travel-time matrix (doc 06 §7 B1 / B2; doc 17 §7 P7).
 *
 *   npx tsx scripts/etms-matrix-bench.ts                       # local matrix stub (synthetic engine, NOT a sign-off)
 *   npx tsx scripts/etms-matrix-bench.ts --url http://127.0.0.1:8989 [--gh-pid 1234]   # a real GraphHopper 11 (staging C3)
 *
 * Options: --sizes 25,50,100,200  --strategy auto|walk|pairwise|both  --concurrency 3  --legs 50  --stub-leg-ms 0
 *          --cities chennai,bengaluru  --b1-pairs 200  --json out.jsonl  --k 20,40 (extra sparse rows: k-nearest + depot 0)
 *
 * Synthetic points only (jittered grids ~8 km across central Chennai / Bengaluru; no real addresses). Cold builds:
 * no cache. Measures wall time, engine requests, cells/s, this process's CPU, and (Linux, with --gh-pid) the
 * GraphHopper process CPU seconds per matrix from /proc. B1 = single `/route` (calc_points=false) latency at c1/c4/c8.
 *
 * Never point this at production (doc 06 §7: production benchmarks only with owner approval, off-peak). The script
 * refuses the production host names it knows.
 */
import { readFileSync, appendFileSync } from 'fs';
import { GraphHopperMatrixEngine } from '../src/routing/matrix/gh-matrix-client';
import { MatrixBuilder } from '../src/routing/matrix/matrix-builder';
import { MatrixCache } from '../src/routing/matrix/matrix-cache';
import { MatrixConfig } from '../src/routing/matrix/matrix-config';
import { MatrixMetrics } from '../src/routing/matrix/matrix-metrics';
import { percentile } from '../src/routing/matrix/limiter';
import { kNearestPairs } from '../src/routing/matrix/sparse';
import { GraphHopperMatrixStub } from '../src/routing/matrix/testing/gh-matrix-stub';
import { syntheticPoints, testConfig } from '../src/routing/matrix/testing/matrix-test-kit';

const CITIES: Record<string, { lat: number; lng: number }> = {
  chennai: { lat: 13.0604, lng: 80.2496 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
};
const PRODUCTION = [/veetrax\.com$/i, /^103\.176\.85\.69$/];

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function ghCpuSeconds(pid: string): number | null {
  if (!pid) return null;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100; // utime + stime in clock ticks (USER_HZ = 100)
  } catch {
    return null;
  }
}

async function b1(engine: GraphHopperMatrixEngine, pairs: number, centre: { lat: number; lng: number }) {
  const pts = syntheticPoints(Math.ceil(Math.sqrt(pairs)) + 1, centre, 0.08, 11);
  const jobs: [number, number][] = [];
  for (let a = 0; a < pts.length && jobs.length < pairs; a++) for (let b = 0; b < pts.length && jobs.length < pairs; b++) if (a !== b) jobs.push([a, b]);
  const out: Record<string, { p50: number; p95: number; failures: number }> = {};
  for (const c of [1, 4, 8]) {
    const lat: number[] = [];
    let failures = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: c }, async () => {
        while (next < jobs.length) {
          const [a, b] = jobs[next++];
          const t0 = performance.now();
          const r = await engine.pair(pts[a], pts[b], 'car');
          lat.push(performance.now() - t0);
          if (r.kind !== 'ok') failures++;
        }
      }),
    );
    out[`c${c}`] = { p50: Math.round(percentile(lat, 50) * 10) / 10, p95: Math.round(percentile(lat, 95) * 10) / 10, failures };
  }
  return out;
}

async function main() {
  let url = arg('url', '');
  const sizes = arg('sizes', '25,50,100,200').split(',').map(Number);
  const strategies = arg('strategy', 'both') === 'both' ? (['auto', 'pairwise'] as const) : [arg('strategy', 'auto') as MatrixConfig['strategy']];
  const concurrency = Number(arg('concurrency', '3'));
  const legs = Number(arg('legs', '50'));
  const cities = arg('cities', 'chennai,bengaluru').split(',');
  const ghPid = arg('gh-pid', '');
  const jsonOut = arg('json', '');
  let stub: GraphHopperMatrixStub | null = null;
  if (url) {
    const host = new URL(url).hostname;
    if (PRODUCTION.some((re) => re.test(host))) throw new Error(`Refusing to benchmark ${host}: production (doc 06 §7).`);
  } else {
    stub = new GraphHopperMatrixStub();
    stub.legDelayMs = Number(arg('stub-leg-ms', '0'));
    url = await stub.start();
  }
  const engine = new GraphHopperMatrixEngine(url);
  const health = await engine.health();
  if ('kind' in health) throw new Error(`Engine not reachable at ${url}: ${health.message}`);
  const info = await engine.info();
  console.log(`# ETMS matrix benchmark — ${stub ? 'LOCAL STUB (synthetic engine; not a B1–B3 sign-off)' : `GraphHopper at ${url}`}`);
  console.log(`engine info: ${JSON.stringify(info)}; concurrency ${concurrency}; legs/request ${legs}; node ${process.version}`);

  for (const city of cities) {
    const centre = CITIES[city];
    if (!centre) continue;
    const b1r = await b1(engine, Number(arg('b1-pairs', '200')), centre);
    stub?.reset(); // B1 runs above the matrix cap on purpose (c8); count the matrix builds' in-flight only
    console.log(`\nB1 ${city}: single /route latency ms ${JSON.stringify(b1r)}`);
    if (jsonOut) appendFileSync(jsonOut, `${JSON.stringify({ bench: 'B1', city, engine: stub ? 'stub' : url, ...b1r })}\n`);
    console.log(`\n| city | n | strategy | status | wall s | cells | requests (snap/pair/walk) | cells/s | ms/cell | node CPU s | GH CPU s |`);
    console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const n of sizes) {
      const ks = arg('k', '').split(',').filter(Boolean).map(Number);
      for (const [strategy, k] of [...strategies.map((x) => [x, 0] as const), ...ks.map((k) => [strategies[0], k] as const)]) {
        const config: MatrixConfig = { ...testConfig({ strategy, concurrency, legsPerRequest: legs, budgetMs: 900_000, maxPoints: 2000 }), graphVersion: `bench-${Date.now()}` };
        const builder = new MatrixBuilder(config, { engine }, new MatrixCache(null, null, 60, 0), new MatrixMetrics());
        const pts = syntheticPoints(n, centre, 0.08, n);
        const cpu0 = process.cpuUsage();
        const gh0 = ghCpuSeconds(ghPid);
        const t0 = performance.now();
        const b = await builder.buildMatrix(pts, 'car', k > 0 ? { pairs: kNearestPairs(pts, k, [0]) } : {});
        const wall = (performance.now() - t0) / 1000;
        const cpu = process.cpuUsage(cpu0);
        const gh1 = ghCpuSeconds(ghPid);
        const s = b.stats;
        const row = {
          bench: 'B2',
          city,
          n,
          strategy: `${s.strategy === 'walk' ? `${strategy}→walk` : `${strategy}→pairwise`}${k > 0 ? ` k=${k}+depot` : ''}`,
          status: b.status,
          wallS: Math.round(wall * 100) / 100,
          cells: s.requested,
          requests: s.engineCalls,
          cellsPerS: Math.round(s.requested / wall),
          msPerCell: Math.round(((wall * 1000) / Math.max(1, s.requested)) * 100) / 100,
          nodeCpuS: Math.round(((cpu.user + cpu.system) / 1e6) * 100) / 100,
          ghCpuS: gh0 !== null && gh1 !== null ? Math.round((gh1 - gh0) * 100) / 100 : null,
          noRoute: s.noRoute,
          excluded: s.excluded,
          unknown: s.unknown,
        };
        console.log(
          `| ${city} | ${n} | ${row.strategy} | ${row.status} | ${row.wallS} | ${row.cells} | ${s.engineCalls.snap}/${s.engineCalls.pair}/${s.engineCalls.walk} | ${row.cellsPerS} | ${row.msPerCell} | ${row.nodeCpuS} | ${row.ghCpuS ?? 'n/a'} |`,
        );
        if (jsonOut) appendFileSync(jsonOut, `${JSON.stringify({ engine: stub ? 'stub' : url, ...row })}\n`);
      }
    }
  }
  if (stub) {
    console.log(`\nstub max requests in flight during the last city's matrix builds: ${stub.maxInFlight} (cap ${concurrency})`);
    await stub.stop();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
