// C3 kit: pass/fail evaluation of collected results. Exit 0 = PASS, 1 = FAIL, 2 = usage.
//   node evaluate.mjs b2 <b2.jsonl> <results dir>      200 x 200 full matrix < 60 s wall, every city (doc 06 §7)
//   node evaluate.mjs b6 <baseline.json> <load.json>   tracker /route p95 under load <= 2 x baseline (doc 06 §7)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, a, b] = process.argv.slice(2);
if (mode === 'b2') {
  const rows = readFileSync(a, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.bench === 'B2');
  const r200 = rows.filter((r) => r.n === 200 && !String(r.strategy).includes('k='));
  const pass = r200.length > 0 && r200.every((r) => r.status === 'COMPLETE' && r.wallS < 60);
  const csv = ['city,n,strategy,status,wallS,cells,cellsPerS,nodeCpuS,ghCpuS', ...rows.map((r) => [r.city, r.n, r.strategy, r.status, r.wallS, r.cells, r.cellsPerS, r.nodeCpuS, r.ghCpuS ?? ''].join(','))];
  writeFileSync(join(b, 'b2.csv'), csv.join('\n') + '\n');
  for (const r of r200) console.log(`  ${r.city} n=200: ${r.status} ${r.wallS} s`);
  console.log(`${pass ? 'PASS' : 'FAIL'} B2 200 x 200 full matrix COMPLETE in < 60 s, every city (doc 06 §7)`);
  process.exit(pass ? 0 : 1);
} else if (mode === 'b6') {
  const base = JSON.parse(readFileSync(a, 'utf8'));
  const load = JSON.parse(readFileSync(b, 'utf8'));
  const ratio = load.route.p95Ms / base.route.p95Ms;
  const matchRatio = load.match.requests ? load.match.p95Ms / base.match.p95Ms : null;
  const pass = Number.isFinite(ratio) && ratio <= 2 && base.route.requests > 0 && load.route.errors <= base.route.errors + Math.ceil(0.001 * load.route.requests);
  console.log(`  /route p95 baseline ${base.route.p95Ms} ms, under load ${load.route.p95Ms} ms, ratio ${ratio.toFixed(2)} (limit 2.00)`);
  console.log(`  /route errors baseline ${base.route.errors}, under load ${load.route.errors}`);
  console.log(`  /match p95 baseline ${base.match.p95Ms} ms, under load ${load.match.p95Ms} ms, ratio ${matchRatio?.toFixed(2) ?? 'n/a'} (threshold TBD (owner): doc 06 §7 sets a limit for route only)`);
  console.log(`${pass ? 'PASS' : 'FAIL'} tracker /route p95 under load <= 2 x baseline (doc 06 §7 B6)`);
  process.exit(pass ? 0 : 1);
} else if (mode === 'r5') {
  const dir = a;
  const j = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const csv = (f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const pctl = (v, p) => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN; };
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`${pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };
  const base = j('replay-base.json'), load = j('replay-load.json');
  const ratio = load.route.p95Ms / base.route.p95Ms;
  add('1 tracker /route p95 under load <= 2 x baseline (doc 06 §7 B6)', Number.isFinite(ratio) && ratio <= 2, `${base.route.p95Ms} -> ${load.route.p95Ms} ms, ratio ${ratio.toFixed(2)}`);
  const solves = j('solves.json').rows;
  const ok = solves.filter((s) => s.http === 200);
  const bad = solves.filter((s) => s.http !== 200 && s.http !== 429);
  const slow = ok.filter((s) => s.wallS > 66 || !['FEASIBLE', 'OPTIMAL'].includes(s.status));
  add('2 500 pax / 40 veh solves FEASIBLE in <= 60 s (+10 %), no 503 / reset (doc 11 §5.2)', ok.length > 0 && !bad.length && !slow.length,
    `${ok.length} solved, ${solves.length - ok.length - bad.length} busy (429), ${bad.length} failed, ${slow.length} slow/infeasible; max wall ${Math.max(0, ...ok.map((s) => s.wallS))} s`);
  const opt = j('optimizer.json');
  const field = (s, k) => (s.match(new RegExp(`${k}=(\\S+)`)) ?? [])[1];
  const peak = Number(field(opt.after, 'MemoryPeak'));
  const restarts = Number(field(opt.after, 'NRestarts')) - Number(field(opt.before, 'NRestarts'));
  add('3 optimiser: no restart, no OOM kill, MemoryPeak < 3G (doc 06 §7 limits, doc 16 §3.1)', restarts === 0 && opt.oomLines === 0 && Number.isFinite(peak) && peak < 3 * 1024 ** 3,
    `restarts +${restarts}, OOM/killed journal lines ${opt.oomLines}, MemoryPeak ${Number.isFinite(peak) ? (peak / 1024 ** 2).toFixed(0) + ' MiB' : field(opt.after, 'MemoryPeak')}`);
  const m = [...csv('metrics-base.csv'), ...csv('metrics-load.csv')];
  const not200 = m.filter((r) => r[1] !== '200');
  add('4 /api/health/tracking 200 at every poll (doc 14 G6)', m.length > 0 && !not200.length, `${m.length} polls, ${not200.length} not 200`);
  const pos = ['base', 'load'].map((p) => j(`positions-${p}.json`));
  add('5 positions: 0 lost (doc 11 §5.2)', pos.every((p) => p.sent !== null && p.stored !== null && p.stored >= p.sent),
    pos.map((p) => `${p.phase}: sent ${p.sent}, stored ${p.stored}`).join('; '));
  const q = csv('metrics-load.csv').map((r) => Number(r[2])).filter(Number.isFinite);
  add('6 PROXY vt_queue_oldest_pending_seconds p95 <= 3 s under load (doc 11 §5.2 fix -> map p95 <= 3 s)', q.length > 0 && pctl(q, 95) <= 3, `p95 ${pctl(q, 95)} s over ${q.length} samples`);
  add('7 /match p95 ratio (threshold TBD (owner))', null, `${base.match.p95Ms} -> ${load.match.p95Ms} ms`);
  writeFileSync(join(dir, 'r5-checks.json'), JSON.stringify(checks, null, 2));
  process.exit(checks.some((c) => c.pass === false) ? 1 : 0);
} else {
  console.error('usage: evaluate.mjs b2|b6|r5 ...');
  process.exit(2);
}
