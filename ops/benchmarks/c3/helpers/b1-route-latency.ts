/**
 * C3 B1 (doc 06 §7): GraphHopper `/route` latency, calc_points=false, urban pairs Chennai / Bengaluru / Delhi NCR,
 * concurrency 1 / 4 / 8. Pass target (doc 06 §7 benchmark plan, "proposed"): p95 < 20 ms at c4, in every city.
 * Uses the API's own matrix client (`GraphHopperMatrixEngine.pair`, the request the matrix builder sends).
 *   run through ../b1-route-latency.sh (never on its own)
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { GraphHopperMatrixEngine } from '../../../../apps/api/src/routing/matrix/gh-matrix-client';
import { syntheticPoints } from '../../../../apps/api/src/routing/matrix/testing/matrix-test-kit';
import { arg, c3Guard, pct } from '../lib/guard';

// Synthetic jittered grids around public city centres (no addresses).
const CITIES: Record<string, { lat: number; lng: number }> = {
  chennai: { lat: 13.0604, lng: 80.2496 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  'delhi-ncr': { lat: 28.6139, lng: 77.209 },
};
const P95_LIMIT_MS = 20;

async function main() {
  const url = process.env.C3_GH_URL ?? '';
  const dry = c3Guard([url]);
  const pairs = Number(arg('pairs', process.env.C3_B1_PAIRS ?? '400'));
  const cities = arg('cities', 'chennai,bengaluru,delhi-ncr').split(',');
  const levels = [1, 4, 8];
  if (dry) {
    console.log(`   plan: ${cities.join(', ')} x c${levels.join('/c')} x ${pairs} pairs against ${url || '(C3_GH_URL unset)'}; pass = p95 < ${P95_LIMIT_MS} ms at c4`);
    return;
  }
  const engine = new GraphHopperMatrixEngine(url);
  const health = await engine.health();
  if ('kind' in health) throw new Error(`GraphHopper not reachable at ${url}: ${health.message}`);
  const rows: Record<string, unknown>[] = [];
  let pass = true;
  for (const city of cities) {
    const pts = syntheticPoints(Math.ceil(Math.sqrt(pairs)) + 1, CITIES[city], 0.12, 31);
    const jobs: [number, number][] = [];
    for (let a = 0; a < pts.length && jobs.length < pairs; a++) for (let b = 0; b < pts.length && jobs.length < pairs; b++) if (a !== b) jobs.push([a, b]);
    // warm-up (not measured): the first requests load graph pages
    for (const [a, b] of jobs.slice(0, 20)) await engine.pair(pts[a], pts[b], 'car');
    for (const c of levels) {
      const lat: number[] = [];
      let failures = 0;
      let next = 0;
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: c }, async () => {
          while (next < jobs.length) {
            const [a, b] = jobs[next++];
            const s = performance.now();
            const r = await engine.pair(pts[a], pts[b], 'car');
            lat.push(performance.now() - s);
            if (r.kind !== 'ok') failures++;
          }
        }),
      );
      const row = {
        bench: 'B1', city, concurrency: c, requests: lat.length, failures,
        p50Ms: +pct(lat, 50).toFixed(1), p95Ms: +pct(lat, 95).toFixed(1), p99Ms: +pct(lat, 99).toFixed(1),
        rps: +(lat.length / ((performance.now() - t0) / 1000)).toFixed(1),
      };
      if (c === 4 && !(row.p95Ms < P95_LIMIT_MS)) pass = false;
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const out = process.env.C3_RESULTS as string;
  writeFileSync(join(out, 'b1.json'), JSON.stringify({ label: process.env.C3_LABEL, thresholdMs: P95_LIMIT_MS, rows }, null, 2));
  writeFileSync(join(out, 'b1.csv'), ['city,concurrency,requests,failures,p50Ms,p95Ms,p99Ms,rps', ...rows.map((r) => [r.city, r.concurrency, r.requests, r.failures, r.p50Ms, r.p95Ms, r.p99Ms, r.rps].join(','))].join('\n') + '\n');
  console.log(`${pass ? 'PASS' : 'FAIL'} B1 p95 at c4 < ${P95_LIMIT_MS} ms in every city (doc 06 §7)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
