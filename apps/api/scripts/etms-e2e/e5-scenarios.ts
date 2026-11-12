/**
 * ETMS E5 scenario runner (doc 12 WP 5.5; doc 11 §6 / §7 E5): `sim:route` scenarios etms-on-time, etms-no-show and
 * etms-offline-driver end to end against the real built API, processor and notifier, on a scratch database.
 *
 *   E3H_PG_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm run etms:e5 -w @veetracer/api [-- --scenario etms-no-show]
 *
 *   1. creates `veetrax_e5s_<stamp>_test` (only host / port / user / password are taken from the URL) and runs
 *      `prisma migrate deploy`;
 *   2. `nest build` (unless --no-build), GraphHopper stub, then dist/ API + processor + notifier on free ports, a
 *      private Valkey index (--valkey-db, default 14, never 0, must be empty; flushed after), PUSH_PROVIDER=fake
 *      (pushes go to <out>/push.log, nothing leaves the machine), SMS_PROVIDER=console;
 *   3. seeds synthetic accounts (http-seed.ts: 12 passengers with 9 logins, 3 drivers), gives the drivers a login
 *      through the real admin API;
 *   4. runs the scenarios in order (etms-on-time first: it is the R6 baseline of etms-offline-driver), each on its own
 *      vehicle, driver and passengers (e5-bots.ts), then the notification / push checks;
 *   5. stops every process, flushes the Valkey index, drops the database (unless --keep), prints and writes the summary
 *      to apps/api/var/etms-e2e/e5-<stamp>/ (git-ignored).
 * Exit code: 0 = PASS (tests tagged `pending known-defect …` are reported, not failed, unless --known-defects), 1 =
 * FAIL, 2 = setup error. Refuses any database name that is not `veetrax_e5s_*_test`.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GraphHopperStub } from '../../src/etms/testing/graphhopper-stub';
import { parseScenario, type EtmsScenario } from '../../src/etms/testing/e5-scenario';
import { driverLogins, notificationChecks, runScenario, type ScenarioOutcome, type ScenarioSlot } from './e5-bots';
import { Api, Recorder } from './http-client';
import { HTTP_PASSWORD, seedHttpAccounts } from './http-seed';
import { claimValkeyDb, flushValkeyDb, redact, Stack, valkeyUrl } from './stack';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const API_DIR = resolve(__dirname, '..', '..');
const SCENARIO_DIR = join(API_DIR, 'src', 'simulator', 'scenarios');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = resolve(opt('out') ?? join(API_DIR, 'var', 'etms-e2e', `e5-${STAMP}`));
const ALL = ['etms-on-time', 'etms-no-show', 'etms-offline-driver'];
const SLOTS: Record<string, ScenarioSlot> = {
  'etms-on-time': { paxFrom: 0, vehicle: 0, driver: 0 },
  'etms-no-show': { paxFrom: 3, vehicle: 1, driver: 1 },
  'etms-offline-driver': { paxFrom: 6, vehicle: 4, driver: 2 },
};

const withDb = (base: string, db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};

function runNode(args: string[], env: NodeJS.ProcessEnv, log: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: API_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    child.on('close', (code) => {
      writeFileSync(join(OUT, log), redact(out));
      done(code ?? 1);
    });
  });
}

async function main() {
  const base = process.env.E3H_PG_URL ?? '';
  if (!base) throw new Error('Set E3H_PG_URL (postgresql://user:pass@host:port/postgres); only its server and credentials are used');
  const wanted = opt('scenario') ? opt('scenario')!.split(',') : ALL;
  for (const w of wanted) if (!ALL.includes(w)) throw new Error(`unknown scenario ${w} (one of ${ALL.join(', ')})`);
  // The R6 baseline runs first whenever the offline scenario is asked for.
  const names = ALL.filter((n) => wanted.includes(n) || (n === 'etms-on-time' && wanted.includes('etms-offline-driver')));
  const scenarios: EtmsScenario[] = names.map((n) => parseScenario(JSON.parse(readFileSync(join(SCENARIO_DIR, `${n}.json`), 'utf8'))));
  mkdirSync(OUT, { recursive: true });
  const name = opt('name') ?? `veetrax_e5s_${STAMP}_test`;
  if (!/^veetrax_e5s_[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing database name ${name}`);
  const scratch = withDb(base, name);
  const admin = new PrismaClient({ datasourceUrl: withDb(base, 'postgres') });
  const prismaBin = join(dirname(require.resolve('prisma/package.json', { paths: [API_DIR] })), 'build', 'index.js');
  const started = Date.now();
  const rec = new Recorder({ secfix: false, known: flag('known-defects') });
  const valkeyDb = Number(opt('valkey-db') ?? 14);
  const redisUrl = valkeyUrl(opt('valkey-url') ?? process.env.E3H_VALKEY_URL ?? 'redis://127.0.0.1:6379', valkeyDb);
  const pushLog = join(OUT, 'push.log');
  console.log(`ETMS E5 scenarios ${STAMP}: ${names.join(', ')} on ${name}, Valkey db ${valkeyDb}`);
  let setupError: string | null = null;
  try {
    await claimValkeyDb(redisUrl);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    if ((await runNode([prismaBin, 'migrate', 'deploy'], { DATABASE_URL: scratch }, 'migrate.log')) !== 0) throw new Error('migrate deploy failed (see migrate.log)');
    if (!flag('no-build')) {
      console.log('  nest build …');
      const cli = join(dirname(require.resolve('@nestjs/cli/package.json', { paths: [API_DIR] })), 'bin', 'nest.js');
      if ((await runNode([cli, 'build'], {}, 'build.log')) !== 0) throw new Error('nest build failed (see build.log)');
    }
    const stub = new GraphHopperStub();
    const routerUrl = await stub.start(0);
    const stack = new Stack({ apiDir: API_DIR, databaseUrl: scratch, redisUrl, routerUrl, outDir: OUT, notifier: true, extraEnv: { PUSH_PROVIDER: 'fake', PUSH_FAKE_LOG: pushLog, SMS_PROVIDER: 'console' } });
    const prisma = new PrismaClient({ datasourceUrl: scratch });
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    try {
      const acc = await seedHttpAccounts(prisma, `e5s-${STAMP}`, { passengers: 12, logins: 9, drivers: 3 });
      await stack.start();
      console.log(`  stack up: API :${stack.apiPort}, processor, notifier (PUSH_PROVIDER=fake), Valkey db ${valkeyDb}`);
      const api = new Api(stack.api);
      const adminTok = await api.login(acc.users.admin.email, HTTP_PASSWORD);
      const drivers = await driverLogins(api, acc, prisma);
      const done: Record<string, ScenarioOutcome> = {};
      for (const s of scenarios) {
        console.log(`  scenario ${s.name}: ${s.description.slice(0, 90)}…`);
        const slot = SLOTS[s.name];
        const t0 = Date.now();
        let out: ScenarioOutcome | null = null;
        await rec.step(s.name, `${s.name} run`, async () => {
          out = await runScenario(s, slot, { api, acc, prisma, redis, rec, adminTok, driverTok: drivers[slot.driver], pushLog, baseline: s.compareWith ? done[s.compareWith] : undefined });
        });
        if (out) {
          done[s.name] = out;
          await rec.step('NOTIFY', `${s.name} notifications`, () => notificationChecks(s, slot, (out as ScenarioOutcome).tripId!, { api, acc, prisma, rec, driverTok: drivers[slot.driver], pushLog }));
        }
        rec.check(s.name, `scenario wall time ${Math.round((Date.now() - t0) / 1000)} s`, true);
      }
    } finally {
      await stack.stop();
      await stub.stop();
      redis.disconnect();
      await prisma.$disconnect();
    }
  } catch (e) {
    setupError = (e as Error).message;
    console.error(redact(`  setup error: ${setupError}`));
  } finally {
    await flushValkeyDb(redisUrl).catch((e: Error) => console.error(`  Valkey flush failed: ${e.message}`));
    if (!flag('keep')) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((e: Error) => console.error(`DROP failed: ${e.message}`));
    console.log(`  Valkey db ${valkeyDb} flushed; ${flag('keep') ? `kept ${name}` : `dropped ${name}`}`);
    await admin.$disconnect();
  }

  const criteria = [...names, 'R6', 'NOTIFY'].filter((c) => c !== 'R6' || names.includes('etms-offline-driver'));
  const rows = criteria.map((c) => {
    const mine = rec.results.filter((r) => r.criterion === c);
    const passed = mine.filter((r) => r.status === 'passed').length;
    const failed = mine.filter((r) => r.status === 'failed').length;
    const pending = mine.filter((r) => r.status === 'pending').length;
    return { c, passed, failed, pending, verdict: failed ? 'FAIL' : passed ? (pending ? 'PASS*' : 'PASS') : 'NO TEST' };
  });
  const failed = rec.results.filter((r) => r.status === 'failed');
  const pending = rec.results.filter((r) => r.status === 'pending');
  const overall = !setupError && !failed.length && rows.every((r) => r.verdict.startsWith('PASS'));
  const text = [
    `ETMS E5 scenarios ${STAMP} (${Math.round((Date.now() - started) / 1000)} s) on ${name}`,
    '',
    '| Criterion | Passed | Failed | Pending | Verdict |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.c} | ${r.passed} | ${r.failed} | ${r.pending} | **${r.verdict}** |`),
    '',
    `Checks: ${rec.results.filter((r) => r.status === 'passed').length} passed, ${failed.length} failed, ${pending.length} pending (known defects; run with --known-defects to fail on them).`,
    ...(setupError ? ['', `Setup error: ${redact(setupError)}`] : []),
    ...(failed.length ? ['', 'Failed:', ...failed.map((f) => `- ${f.title}\n    ${JSON.stringify(f.detail ?? '').slice(0, 400)}`)] : []),
    ...(pending.length ? ['', 'Pending (known defects):', ...pending.map((p) => `- ${p.title}\n    ${JSON.stringify(p.detail ?? '').slice(0, 600)}`)] : []),
    '',
    `E5 SCENARIOS: ${overall ? 'PASS' : 'FAIL'}${pending.length ? ` (${pending.length} known-defect checks pending)` : ''}`,
  ].join('\n');
  console.log(`\n${text}`);
  writeFileSync(join(OUT, 'summary.md'), `${text}\n`);
  writeFileSync(join(OUT, 'results.json'), redact(JSON.stringify({ stamp: STAMP, database: name, scenarios: names, overall: overall ? 'PASS' : 'FAIL', rows, checks: rec.results }, null, 2)));
  console.log(`\nEvidence: ${OUT}`);
  process.exitCode = setupError ? 2 : overall ? 0 : 1;
}

main().catch((e: Error) => {
  console.error(redact(`e5 scenarios error: ${e.message}`));
  process.exitCode = 2;
});
