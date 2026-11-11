/**
 * ETMS E3 test gate runner (12 WP 3.8; QA 2026-11-11 "test gate NOT MET as written"). One command, PASS / FAIL per
 * doc 12 §5 E3 exit criterion:
 *
 *   E3H_PG_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm run etms:gate -w @veetracer/api [-- --secfix] [--keep]
 *
 * What it does (local only; nothing shared is touched):
 *   1. creates a scratch database `veetrax_e3h_<stamp>_test` on the server of E3H_PG_URL (only host / port / user /
 *      password are taken from it; the database named in the URL is never opened except `postgres` for CREATE / DROP);
 *   2. `prisma migrate deploy` from zero;
 *   3. the DB suites with CI=true DB_TEST_REQUIRED=1: `etms-e3-gate.db-test.ts` (this WP) and the E3 backend's
 *      `etms-bookings-trips.db-test.ts` (schema, constraints, purge);
 *   4. the regression unit specs behind criteria 7 and 10 (reports, planned trips, E3 rules, harness parts);
 *   5. with --http: the HTTP stage (http-stage.ts): nest build, the real dist/ API + processor on free ports against
 *      the scratch database and a private Valkey index (--valkey-db, default 11, never 0, must be empty; flushed after),
 *      GraphHopper stub; HTTP checks (guards, Idempotent-Replay, 429 + Retry-After, etms-off 404, auth on every route),
 *      the bot cycle and sim-trip through the processor (criterion 3b); every process stopped, also on failure;
 *   6. drops the scratch database (unless --keep) and prints / writes the summary to apps/api/var/etms-e2e/<stamp>/.
 *
 * Flags: --secfix / --known-defects (kept, harmless: the B1-B5 and HD1 / HD2 regression tests now always run; they only
 * matter for future tests tagged `[pending …]`), --http [--no-build] [--valkey-db 11] [--valkey-url redis://127.0.0.1:6379],
 * --http-only (skip the jest stages; debugging), --keep, --skip-unit,
 * --out <dir>. Refuses any database name that is not `veetrax_e3h_*_test`, and the names veetracer / veetrax_assess.
 */
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runHttpStage } from './http-stage';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const API_DIR = resolve(__dirname, '..', '..');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = resolve(opt('out') ?? join(API_DIR, 'var', 'etms-e2e', STAMP));
const SECFIX = flag('secfix');
const KNOWN = flag('known-defects');
const HTTP = flag('http');

/** doc 12 §5 E3 exit criteria, in order. */
const CRITERIA: Record<string, string> = {
  AC1: 'Recurring week, 200 synthetic passengers (IST + US DST): generated, modified, cancelled with correct counts',
  AC2: 'Double submit → 1 booking (and one change-set publish per key)',
  AC3: 'Publish creates PlannedTrip + header + passengers atomically',
  AC4: 'Capacity never exceeded under concurrent change sets (409 on version conflict)',
  AC5: 'Passenger sees only own leg; vehicle only inside the window',
  AC6: 'GPS stop arrival never sets BOARDED (passengers stay PENDING)',
  AC7: 'trip-performance by route: null-route label, never "No driver"',
  AC8: 'Booking burst measured on T3 (indicative)',
  AC9: 'Works with GraphHopper stopped / hanging (no road ETA, no invented numbers)',
  AC10: 'Existing Routes / Planned trips behaviour unchanged (regression)',
  UNIT: 'E3 unit rules (dispatch, schedules, bookings, change ops)',
  ISO: 'Tenant / branch isolation of bookings and dispatch (doc 11 §3, supporting)',
  DB: 'E3 schema: tables, CHECKs, EXCLUDE, FK actions, purge (supporting)',
  ...(HTTP
    ? {
        AC3b: 'v1.8 tracker follows the published ETMS trip under sim-trip (stop arrivals, ETA, auto-complete; GPS never boards) [--http]',
        HTTP: 'Real API over HTTP: auth on every route, permission / feature guards, Idempotent-Replay, 429 + Retry-After, etms-off 404 [--http]',
        BOT: 'Dispatcher + passenger bots: booking → dispatch → publish → start → outcomes → complete over HTTP [--http]',
      }
    : {}),
};

/** Criterion of a test: `[ACn]` / `[ISO]` tags; titles of the E3 backend DB suite and of the unit specs by keyword. */
function criterionOf(file: string, title: string): string {
  const tag = /\[(AC\d+|ISO)\]/.exec(title)?.[1];
  if (tag) return tag;
  const t = title.toLowerCase();
  if (/etms-bookings-trips\.db-test/.test(file)) {
    if (t.includes('recurring week')) return 'AC1';
    if (t.includes('double submit')) return 'AC2';
    if (t.includes('capacity') || t.includes('two dispatchers')) return 'AC4';
    if (t.includes('gps stop arrival')) return 'AC6';
    return 'DB';
  }
  if (/trip-performance|planned-trips-report/.test(file)) return 'AC7';
  if (/planned-trips|routes|tracker|snapshot/.test(file)) return 'AC10';
  if (/isolation-matrix/.test(file)) return 'ISO';
  if (/etms\/dispatch\//.test(file)) return 'UNIT';
  if (/e3-harness/.test(file)) return 'AC9';
  return 'AC10';
}

function scratchName(): string {
  const name = opt('name') ?? `veetrax_e3h_${STAMP}_test`;
  if (!/^veetrax_e3h_[a-z0-9_]+_test$/.test(name) || /^(veetracer|veetrax_assess)$/.test(name)) throw new Error(`refusing database name ${name}`);
  return name;
}

function withDb(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

const redact = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:/@]+):[^@]*@/g, '$1:***@');

function run(label: string, args: string[], env: NodeJS.ProcessEnv, log: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: API_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b: Buffer) => {
      out += b.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      writeFileSync(join(OUT, log), redact(out));
      console.log(`  ${label}: exit ${code}`);
      done({ code: code ?? 1, out });
    });
  });
}

interface JestJson {
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: { name: string; status: string; message: string; assertionResults: { fullName: string; title: string; status: string; duration?: number | null; failureMessages: string[] }[] }[];
}

async function main() {
  const base = process.env.E3H_PG_URL ?? process.env.DATABASE_URL ?? '';
  if (!base) throw new Error('Set E3H_PG_URL (postgresql://user:pass@host:port/postgres); only its server and credentials are used');
  mkdirSync(OUT, { recursive: true });
  const name = scratchName();
  const scratch = withDb(base, name);
  const admin = new PrismaClient({ datasourceUrl: withDb(base, 'postgres') });
  const jestBin = join(dirname(require.resolve('jest/package.json', { paths: [API_DIR] })), 'bin', 'jest.js');
  const prismaBin = join(dirname(require.resolve('prisma/package.json', { paths: [API_DIR] })), 'build', 'index.js');
  const started = Date.now();
  console.log(`ETMS E3 gate ${STAMP}: scratch database ${name}${SECFIX ? ', secfix tests ON' : ''}`);
  const results: { file: string; title: string; status: string; criterion: string; ms: number | null; failure?: string }[] = [];
  let metrics: Record<string, unknown> | null = null;
  let migrated = false;
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const mig = await run('prisma migrate deploy', [prismaBin, 'migrate', 'deploy'], { DATABASE_URL: scratch }, 'migrate.log');
    if (mig.code !== 0) throw new Error('migrate deploy failed (see migrate.log)');
    migrated = true;
    const dbJson = join(OUT, 'jest-db.json');
    const files: string[] = [];
    if (!flag('http-only')) {
    const db = await run(
      'DB suites (gate + E3 backend)',
      [jestBin, '--testRegex', '(etms-e3-gate|etms-bookings-trips)\\.db-test\\.ts$', '--runInBand', '--json', '--outputFile', dbJson],
      { CI: 'true', DB_TEST_REQUIRED: '1', ETMS_DB_TEST_URL: scratch, ETMS_E3_SECFIX: SECFIX ? '1' : '0', ETMS_E3_KNOWN_DEFECTS: KNOWN ? '1' : '0' },
      'jest-db.log',
    );
    const m = /E3-GATE-SUMMARY (\{.*\})/.exec(db.out);
    if (m) metrics = JSON.parse(m[1]) as Record<string, unknown>;
    files.push(dbJson);
    }
    if (!flag('skip-unit') && !flag('http-only')) {
      const unitJson = join(OUT, 'jest-unit.json');
      await run('regression unit specs', [jestBin, '--json', '--outputFile', unitJson, 'trip-performance', 'planned-trips', 'reports/', 'etms/dispatch/', 'etms/testing/', 'routes/'], {}, 'jest-unit.log');
      files.push(unitJson);
    }
    for (const f of files) {
      let j: JestJson;
      try {
        j = JSON.parse(readFileSync(f, 'utf8')) as JestJson;
      } catch {
        results.push({ file: f, title: 'jest did not produce results', status: 'failed', criterion: 'DB', ms: null });
        continue;
      }
      for (const s of j.testResults) {
        const rel = s.name.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/');
        if (!s.assertionResults.length && s.status === 'failed') results.push({ file: rel, title: 'suite failed to run', status: 'failed', criterion: criterionOf(rel, ''), ms: null, failure: s.message.slice(0, 400) });
        for (const a of s.assertionResults) results.push({ file: rel, title: a.fullName, status: a.status, criterion: criterionOf(rel, a.fullName), ms: a.duration ?? null, failure: a.failureMessages[0]?.slice(0, 400) });
      }
    }
    if (HTTP) {
      console.log('  HTTP stage (real dist/ API + processor) …');
      const http = await runHttpStage({ apiDir: API_DIR, databaseUrl: scratch, outDir: OUT, build: !flag('no-build'), valkeyBase: opt('valkey-url') ?? process.env.E3H_VALKEY_URL ?? 'redis://127.0.0.1:6379', valkeyDb: Number(opt('valkey-db') ?? 11), secfix: SECFIX, known: KNOWN, tag: `e3h-${STAMP}` });
      writeFileSync(join(OUT, 'http.json'), redact(JSON.stringify(http, null, 2)));
      for (const r of http) results.push({ file: 'http-stage', title: r.title, status: r.status, criterion: r.criterion, ms: null, failure: r.status === 'failed' ? JSON.stringify(r.detail ?? '').slice(0, 400) : undefined });
    }
  } finally {
    if (!flag('keep')) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((e: Error) => console.error(`DROP failed: ${e.message}`));
      console.log(`  dropped ${name}`);
    } else console.log(`  kept ${name} (--keep)`);
    await admin.$disconnect();
  }

  // ── summary ──
  const rows = Object.entries(CRITERIA).map(([id, text]) => {
    const mine = results.filter((r) => r.criterion === id);
    const passed = mine.filter((r) => r.status === 'passed').length;
    const failed = mine.filter((r) => r.status === 'failed').length;
    const pending = mine.filter((r) => r.status === 'pending' || r.status === 'skipped' || r.status === 'todo').length;
    const verdict = failed ? 'FAIL' : passed ? (pending ? 'PASS*' : 'PASS') : pending ? 'PENDING' : 'NO TEST';
    return { id, text, passed, failed, pending, verdict };
  });
  const failedTests = results.filter((r) => r.status === 'failed');
  const skippedOf = (re: RegExp) => results.filter((r) => r.status !== 'passed' && r.status !== 'failed' && re.test(r.title));
  const pendingTests = skippedOf(/pending secfix/);
  const knownTests = skippedOf(/known defect/);
  const required = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'AC9', 'AC10', 'UNIT', 'ISO', 'DB', ...(HTTP ? ['AC3b', 'HTTP', 'BOT'] : [])];
  const overall = migrated && !failedTests.length && required.every((id) => rows.find((r) => r.id === id)!.verdict.startsWith('PASS'));
  const lines = [
    `ETMS E3 gate ${STAMP} (${Math.round((Date.now() - started) / 1000)} s) on ${name}${HTTP ? ' [--http]' : ''}${SECFIX ? ' [secfix tests ON]' : ''}${KNOWN ? ' [known-defect tests ON]' : ''}`,
    '',
    '| Criterion | Passed | Failed | Pending | Verdict | |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.passed} | ${r.failed} | ${r.pending} | **${r.verdict}** | ${r.text} |`),
    '',
    `Tests: ${results.filter((r) => r.status === 'passed').length} passed, ${failedTests.length} failed, ${results.length - results.filter((r) => r.status === 'passed').length - failedTests.length} skipped (of which ${pendingTests.length} pending secfix, ${knownTests.length} known defects).`,
    'PASS* = passed, with some tests skipped (e.g. tests tagged [pending …], or skips inside the regression specs).',
    ...(failedTests.length ? ['', 'Failed:', ...failedTests.map((f) => `- [${f.criterion}] ${f.file}: ${f.title}\n    ${(f.failure ?? '').split('\n')[0]}`)] : []),
    ...(pendingTests.length ? ['', 'Pending secfix (skipped):', ...pendingTests.map((p) => `- ${p.title}`)] : []),
    ...(knownTests.length ? ['', 'Known defects (skipped, see README):', ...knownTests.map((p) => `- ${p.title}`)] : []),
    '',
    HTTP ? 'Not automated here (see README "Gaps"): Playwright journeys, mobile (Maestro).' : 'Not run: the --http stage (real API / processor, sim-trip, bots). Not automated at all: Playwright journeys, mobile.',
    '',
    `GATE: ${overall ? 'PASS' : 'FAIL'}${pendingTests.length || knownTests.length ? ` (automated part; ${pendingTests.length} pending secfix, ${knownTests.length} known defects skipped)` : ''}`,
  ];
  const text = lines.join('\n');
  console.log(`\n${text}`);
  writeFileSync(join(OUT, 'summary.md'), `${text}\n`);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ stamp: STAMP, database: name, secfix: SECFIX, knownDefects: KNOWN, http: HTTP, overall: overall ? 'PASS' : 'FAIL', criteria: rows, metrics, tests: results }, null, 2));
  console.log(`\nEvidence: ${OUT}`);
  process.exitCode = overall ? 0 : 1;
}

main().catch((e: Error) => {
  console.error(redact(`gate error: ${e.message}`));
  process.exitCode = 2;
});
