/**
 * C3 kit: builds GraphHopper matrices with the API's own MatrixBuilder (cold, no cache) and writes them as JSON for
 * the solver helpers. Used by B3 (full vs sparse k-nearest + depot) and R-5 (matrix load generator, --loop).
 *   run through ../b3-sparse-quality.sh or ../r5-isolation.sh (never on its own)
 *   --n 200 --ks 20,40,60 --city chennai --out <dir> [--concurrency 4] [--loop <seconds>]
 * Point 0 is the depot (site); the rest are synthetic points (jittered grid, no addresses).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GraphHopperMatrixEngine } from '../../../../apps/api/src/routing/matrix/gh-matrix-client';
import { MatrixBuilder } from '../../../../apps/api/src/routing/matrix/matrix-builder';
import { MatrixCache } from '../../../../apps/api/src/routing/matrix/matrix-cache';
import { MatrixConfig } from '../../../../apps/api/src/routing/matrix/matrix-config';
import { MatrixMetrics } from '../../../../apps/api/src/routing/matrix/matrix-metrics';
import { kNearestPairs } from '../../../../apps/api/src/routing/matrix/sparse';
import { syntheticPoints, testConfig } from '../../../../apps/api/src/routing/matrix/testing/matrix-test-kit';
import { arg, c3Guard } from '../lib/guard';

const CITIES: Record<string, { lat: number; lng: number }> = {
  chennai: { lat: 13.0604, lng: 80.2496 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
};

async function main() {
  const url = process.env.C3_GH_URL ?? '';
  const dry = c3Guard([url]);
  const n = Number(arg('n', '200'));
  const ks = arg('ks', '').split(',').filter(Boolean).map(Number);
  const city = arg('city', 'chennai');
  const out = arg('out', '');
  const concurrency = Number(arg('concurrency', '4'));
  const loopS = Number(arg('loop', '0'));
  if (dry) {
    console.log(`   plan: ${loopS ? `repeat cold builds for ${loopS} s` : 'one build each'}: full ${n}x${n}${ks.length ? ` + sparse k=${ks.join('/')}` : ''}, ${city}, ${concurrency} in flight, against ${url || '(C3_GH_URL unset)'}`);
    return;
  }
  if (!out) throw new Error('--out is required');
  mkdirSync(out, { recursive: true });
  const engine = new GraphHopperMatrixEngine(url);
  const health = await engine.health();
  if ('kind' in health) throw new Error(`GraphHopper not reachable at ${url}: ${health.message}`);
  const pts = syntheticPoints(n, CITIES[city], 0.12, 500 + n);
  const build = async (k: number) => {
    // A new graphVersion per build keeps every build cold (no cache hits), as in scripts/etms-matrix-bench.ts.
    const config: MatrixConfig = { ...testConfig({ strategy: 'auto', concurrency, legsPerRequest: 50, budgetMs: 900_000, maxPoints: 2000 }), graphVersion: `c3-${Date.now()}-${k}` };
    const builder = new MatrixBuilder(config, { engine }, new MatrixCache(null, null, 60, 0), new MatrixMetrics());
    const t0 = performance.now();
    const b = await builder.buildMatrix(pts, 'car', k > 0 ? { pairs: kNearestPairs(pts, k, [0]) } : {});
    return { b, wallS: Math.round((performance.now() - t0) / 10) / 100 };
  };
  if (loopS > 0) {
    const end = Date.now() + loopS * 1000;
    let i = 0;
    while (Date.now() < end) {
      const { b, wallS } = await build(0);
      console.log(JSON.stringify({ build: ++i, n, status: b.status, wallS, requests: b.stats.engineCalls, t: new Date().toISOString() }));
    }
    return;
  }
  for (const k of [0, ...ks]) {
    const { b, wallS } = await build(k);
    const name = k ? `k${k}.json` : 'full.json';
    writeFileSync(join(out, name), JSON.stringify({ n, k, city, status: b.status, wallS, stats: b.stats, unknownCells: b.unknownCells.length, durationsS: b.durationsS, distancesM: b.distancesM }));
    console.log(JSON.stringify({ file: name, status: b.status, wallS, cells: b.stats.requested, unknownCells: b.unknownCells.length }));
    if (b.status !== 'COMPLETE' && k === 0) throw new Error(`full matrix is ${b.status}: ${b.degraded?.message ?? ''}`);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
