/**
 * C3 kit: replays the tracker's GraphHopper traffic at fixed rates (open loop: requests are sent on schedule, not after
 * the previous answer, so a slow engine shows up as latency instead of a lower rate).
 *   - live ETA: GET /route, 2 points, calc_points=true, points_encoded=true, instructions=false (as RoutingService)
 *   - map matching: POST /match with a synthetic GPX track (as point-quality/road-match.ts)
 * Used by B6 (doc 06 §7) and R-5. Rates are inputs: doc 06 §7 says "at production rates" and no document gives the
 * number, so C3_TRACKER_ROUTE_RPS / C3_MATCH_RPS must be supplied by the owner / ops from production logs (TBD).
 *   run through ../b6-mixed-load.sh or ../r5-isolation.sh (never on its own)
 *   --duration 300 --route-rps <n> --match-rps <n> --out <file.json> [--city chennai]
 */
import { writeFileSync } from 'fs';
import { syntheticPoints } from '../../../../apps/api/src/routing/matrix/testing/matrix-test-kit';
import { arg, c3Guard, pct } from '../lib/guard';

const CITIES: Record<string, { lat: number; lng: number }> = {
  chennai: { lat: 13.0604, lng: 80.2496 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
};

function gpxTrack(a: { lat: number; lng: number }, b: { lat: number; lng: number }, seed: number): string {
  const n = 30;
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31), x / 2 ** 31);
  const t0 = Date.UTC(2026, 0, 1, 4, 0, 0);
  const pts = Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1);
    // ~10 m GPS jitter around the straight line (synthetic; the engine snaps it to roads)
    return `<trkpt lat="${(a.lat + (b.lat - a.lat) * f + (rnd() - 0.5) * 0.0002).toFixed(6)}" lon="${(a.lng + (b.lng - a.lng) * f + (rnd() - 0.5) * 0.0002).toFixed(6)}"><time>${new Date(t0 + i * 5000).toISOString()}</time></trkpt>`;
  });
  return `<?xml version="1.0"?><gpx version="1.1" creator="c3-kit"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

async function main() {
  const url = (process.env.C3_GH_URL ?? '').replace(/\/+$/, '');
  const dry = c3Guard([url]);
  const duration = Number(arg('duration', '300'));
  const routeRps = Number(arg('route-rps', process.env.C3_TRACKER_ROUTE_RPS ?? 'NaN'));
  const matchRps = Number(arg('match-rps', process.env.C3_MATCH_RPS ?? 'NaN'));
  const out = arg('out', '');
  const city = arg('city', 'chennai');
  if (!(routeRps >= 0) || !(matchRps >= 0)) {
    console.error('C3: --route-rps / --match-rps (C3_TRACKER_ROUTE_RPS / C3_MATCH_RPS) are required: production rates, TBD (owner/ops)');
    if (!dry) process.exit(2);
  }
  if (dry) {
    console.log(`   plan: ${duration} s open-loop replay against ${url || '(C3_GH_URL unset)'}: /route ${routeRps}/s, /match ${matchRps}/s`);
    return;
  }
  const pts = syntheticPoints(120, CITIES[city], 0.12, 77);
  const lat = { route: [] as number[], match: [] as number[] };
  const err = { route: 0, match: 0 };
  const noMatch = { route: 0, match: 0 };
  const pending: Promise<void>[] = [];
  let seq = 0;
  const fire = (kind: 'route' | 'match') => {
    const i = seq++;
    const a = pts[i % pts.length];
    const b = pts[(i * 7 + 13) % pts.length];
    const t = performance.now();
    const req =
      kind === 'route'
        ? fetch(`${url}/route?profile=car&point=${a.lat},${a.lng}&point=${b.lat},${b.lng}&calc_points=true&points_encoded=true&instructions=false`, { signal: AbortSignal.timeout(10_000) })
        : fetch(`${url}/match?profile=car&points_encoded=false&instructions=false&calc_points=true&gps_accuracy=20`, {
            method: 'POST', headers: { 'Content-Type': 'application/gpx+xml' }, body: gpxTrack(a, b, i), signal: AbortSignal.timeout(10_000),
          });
    pending.push(
      req
        .then(async (r) => {
          await r.arrayBuffer();
          lat[kind].push(performance.now() - t);
          if (r.status === 400) noMatch[kind]++; // no route / not near a road: an engine answer, not an error
          else if (!r.ok) err[kind]++;
        })
        .catch(() => {
          err[kind]++;
        }),
    );
  };
  const timers: NodeJS.Timeout[] = [];
  if (routeRps > 0) timers.push(setInterval(() => fire('route'), 1000 / routeRps));
  if (matchRps > 0) timers.push(setInterval(() => fire('match'), 1000 / matchRps));
  await new Promise((r) => setTimeout(r, duration * 1000));
  timers.forEach(clearInterval);
  await Promise.all(pending);
  const summary = (k: 'route' | 'match') => ({
    requests: lat[k].length, errors: err[k], engine400: noMatch[k],
    p50Ms: +pct(lat[k], 50).toFixed(1), p95Ms: +pct(lat[k], 95).toFixed(1), p99Ms: +pct(lat[k], 99).toFixed(1),
  });
  const res = { durationS: duration, routeRps, matchRps, route: summary('route'), match: summary('match'), endedUtc: new Date().toISOString() };
  console.log(JSON.stringify(res));
  if (out) writeFileSync(out, JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
