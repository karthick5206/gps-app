/**
 * Reproducible chaos test for the GPS ingestion path (docs/reliability/chaos-testing.md).
 *
 *   npx tsx scripts/chaos/chaos-run.ts [--scenarios baseline,cache-kill,...] [--devices 40] [--interval 2]
 *                                      [--prolonged-min 11] [--out <dir>]
 *
 * Needs (all local, nothing shared is touched):
 *   - apps/api built (npm run build) — the real dist/ binaries of api, gateway and processor are started
 *   - CHAOS_DATABASE_URL: a scratch PostgreSQL database whose name ends in _test, migrated, seeded, with the simulator
 *     devices registered (npx tsx src/simulator/register.ts --count <devices> --imei-start 868120009000001)
 *   - WSL with valkey-server: a private instance is started on 127.0.0.1:6390 (data in /tmp/vtchaos); the harness
 *     kills / restarts / wipes ONLY that instance
 *   - or an existing cache: --cache-url rediss://veetrax:<pw>@127.0.0.1:16380 (TLS / ACL settings from REDIS_TLS_*,
 *     see src/redis/connection.ts) with --cache-ctl docker:<container> to kill / start its systemd valkey unit
 *     (cache-restart-empty is not supported there)
 *
 * Topology: simulator → gateway (GT06 :15023) → cache proxy :6391 → valkey :6390; api / processor reach PostgreSQL
 * through a proxy on :15432 and the cache through :6391. The proxies cut (RST) or blackhole (pause) traffic.
 *
 * For each scenario the simulator records every GPS fix it wrote to a connected socket; after the scenario the
 * harness waits for the pipeline to drain and compares the sent fixes with the Position rows in PostgreSQL.
 */
import { PrismaClient } from '@prisma/client';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync, WriteStream } from 'node:fs';
import { connect, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { createRedis, redactRedisUrl } from '../../src/redis/connection';
import { decodeFrames, encodeGps22, encodeLogin, frameProtocol } from '../../src/gateway/gt06/codec';
import { ChaosProxy } from './tcp-proxy';

// ── configuration ────────────────────────────────────────────────────────────

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '');
const API_DIR = resolve(__dirname, '..', '..');
const DEVICES = Number(args.get('devices') ?? 40);
const INTERVAL_MS = Number(args.get('interval') ?? 2) * 1000;
const PROLONGED_MIN = Number(args.get('prolonged-min') ?? 11);
const IMEI_START = 868120009000001;
const OUT = resolve(args.get('out') ?? join(API_DIR, 'var', 'chaos', new Date().toISOString().replace(/[:.]/g, '-')));
const ALL = ['baseline', 'cache-kill', 'cache-restart-empty', 'net-blackhole', 'net-cut', 'gateway-restart', 'processor-restart', 'db-interruption', 'dup-ooo', 'prolonged'];
const SCENARIOS = (args.get('scenarios') ?? ALL.join(',')).split(',').filter(Boolean);
const PORTS = { valkey: 6390, valkeyProxy: 6391, pgProxy: 15432, api: 14100, gt06: 15023, gwHealth: 14121 };
/** External cache under test (e.g. the ops/valkey kit in a container, TLS + ACL); default: private WSL valkey. */
const CACHE_URL = args.get('cache-url') ?? null;
const CACHE_CTL = args.get('cache-ctl') ?? null;
const cacheTarget = CACHE_URL ? new URL(CACHE_URL) : null;
/** What the processes under test use: the same URL (scheme, user, password) pointed at the cut/blackhole proxy. */
const proxiedCache = (() => {
  if (!cacheTarget) return `redis://127.0.0.1:${PORTS.valkeyProxy}`;
  const u = new URL(CACHE_URL!);
  u.hostname = '127.0.0.1';
  u.port = String(PORTS.valkeyProxy);
  return u.toString();
})();

const dbUrl = process.env.CHAOS_DATABASE_URL ?? '';
const parsedDb = new URL(dbUrl || 'postgresql://x@127.0.0.1:5432/none');
if (!dbUrl || !parsedDb.pathname.replace('/', '').endsWith('_test')) {
  console.error('CHAOS_DATABASE_URL must point at a scratch database whose name ends in _test');
  process.exit(2);
}
const proxiedDb = new URL(dbUrl);
proxiedDb.hostname = '127.0.0.1';
proxiedDb.port = String(PORTS.pgProxy);

mkdirSync(OUT, { recursive: true });
const harnessLog = createWriteStream(join(OUT, 'harness.log'));
const t0 = Date.now();
function log(msg: string): void {
  const line = `${new Date().toISOString()} [+${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`;
  console.log(line);
  harnessLog.write(`${line}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── private valkey in WSL ────────────────────────────────────────────────────

function wsl(cmd: string): string {
  try {
    return execFileSync('wsl', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `ERR ${(error as Error).message.split('\n')[0]}`;
  }
}
const docker = (container: string, cmd: string) => wsl(`docker exec ${container} bash -lc "${cmd}"`);
const externalValkey = CACHE_CTL?.startsWith('docker:')
  ? (() => {
      const c = CACHE_CTL.slice('docker:'.length);
      return {
        start: () => docker(c, 'systemctl start valkey && sleep 1 && systemctl is-active valkey'),
        kill9: () => docker(c, 'systemctl kill -s SIGKILL valkey; sleep 0.3; systemctl is-active valkey || true'),
        wipe: () => 'not supported on an external cache',
        version: () => docker(c, '/usr/local/bin/valkey-server --version'),
      };
    })()
  : null;
const localValkey = {
  start: () => wsl(`mkdir -p /tmp/vtchaos && valkey-server --port ${PORTS.valkey} --bind 127.0.0.1 --appendonly yes --appendfsync everysec --save '' --dir /tmp/vtchaos --pidfile /tmp/vtchaos/valkey.pid --logfile /tmp/vtchaos/valkey.log --daemonize yes && sleep 1 && valkey-cli -p ${PORTS.valkey} ping`),
  kill9: () => wsl(`kill -9 $(cat /tmp/vtchaos/valkey.pid) 2>/dev/null; sleep 0.5; valkey-cli -p ${PORTS.valkey} ping 2>&1 | head -1`),
  wipe: () => wsl(`valkey-cli -p ${PORTS.valkey} shutdown nosave >/dev/null 2>&1; sleep 0.5; rm -rf /tmp/vtchaos/appendonlydir /tmp/vtchaos/*.rdb; echo wiped`),
  version: () => wsl(`valkey-server --version`),
};
const valkey = externalValkey ?? localValkey;

// ── processes under test ─────────────────────────────────────────────────────

interface Proc {
  name: string;
  child: ChildProcess | null;
  lines: { at: number; line: string }[];
  file: WriteStream;
}
const procs = new Map<string, Proc>();
const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: proxiedDb.toString(),
  REDIS_URL: proxiedCache,
  API_PORT: String(PORTS.api),
  GT06_PORT: String(PORTS.gt06),
  TELTONIKA_PORT: '0',
  JT808_PORT: '0',
  AIS140_PORT: '0',
  MEDIA_PORT: '0',
  ATTACH_PORT: '0',
  GATEWAY_HEALTH_PORT: String(PORTS.gwHealth),
  GATEWAY_ID: 'gw-chaos',
  GATEWAY_SPOOL_DIR: join(OUT, 'spool'),
  PROCESSOR_CONSUMER: 'processor-chaos',
  SYSTEM_HEALTH_ROLES: 'api,gateway,processor',
  SYSTEM_ALERT_EMAILS: 'ops@chaos.test',
  SYSTEM_ALERT_COOLDOWN_MIN: '1',
  HEALTH_PERSIST_STALE_WARN_SEC: '45',
  HEALTH_PERSIST_STALE_CRIT_SEC: '90',
  HEALTH_SPOOL_STUCK_MIN: '5',
  GEOCODER: 'none',
});
function startProc(name: 'api' | 'gateway' | 'processor'): void {
  const entry = { api: 'dist/main.js', gateway: 'dist/gateway/main.js', processor: 'dist/processor/main.js' }[name];
  let p = procs.get(name);
  if (!p) {
    p = { name, child: null, lines: [], file: createWriteStream(join(OUT, `${name}.log`), { flags: 'a' }) };
    procs.set(name, p);
  }
  const child = spawn(process.execPath, [entry], { cwd: API_DIR, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  p.child = child;
  const onData = (buf: Buffer) => {
    for (const raw of buf.toString('utf8').split(/\r?\n/)) {
      if (!raw.trim()) continue;
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
      p!.lines.push({ at: Date.now(), line });
      p!.file.write(`${new Date().toISOString()} ${line}\n`);
    }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  child.on('exit', (code, signal) => log(`${name} exited (code ${code}, signal ${signal})`));
  log(`${name} started (pid ${child.pid})`);
}
async function killProc(name: string): Promise<void> {
  const p = procs.get(name);
  if (!p?.child || p.child.exitCode !== null) return;
  const exited = new Promise((r) => p.child!.once('exit', r));
  p.child.kill('SIGKILL');
  await exited;
}

// ── simulator with an exact record of what was sent ─────────────────────────

interface SentFix {
  imei: string;
  fixSec: number;
  scenario: string;
}
let scenario = 'setup';
const sent: SentFix[] = [];
let dupMode = false;
class Device {
  socket: Socket | null = null;
  ready = false;
  serial = 0;
  lastFix = 0;
  timer: NodeJS.Timeout | null = null;
  stopped = false;
  rest = Buffer.alloc(0);
  constructor(
    readonly imei: string,
    readonly special: boolean,
  ) {}

  connect(): void {
    if (this.stopped) return;
    const s = connect({ host: '127.0.0.1', port: PORTS.gt06 });
    this.socket = s;
    s.setNoDelay(true);
    s.on('connect', () => s.write(encodeLogin(this.imei, this.next(), 0x3612, 0)));
    s.on('data', (d) => {
      const { frames, rest } = decodeFrames(Buffer.concat([this.rest, d]));
      this.rest = Buffer.from(rest);
      if (frames.some((f) => frameProtocol(f) === 0x01)) this.ready = true;
    });
    s.on('error', () => undefined);
    s.on('close', () => {
      this.ready = false;
      this.socket = null;
      if (!this.stopped) setTimeout(() => this.connect(), 2000);
    });
  }

  next(): number {
    this.serial = (this.serial + 1) & 0xffff;
    return this.serial;
  }

  frame(fixSec: number): Buffer {
    const fix = { time: new Date(fixSec * 1000), gpsInfoLength: 12, satellites: 9, lat: 13.08 + (fixSec % 1000) * 1e-5, lng: 80.27, speedKph: 30, course: 90, positioned: true };
    return encodeGps22({ fix, lbs: { mcc: 404, mnc: 45, lac: 1, cellId: 2 }, acc: true }, this.next());
  }

  write(fixSec: number, times = 1): void {
    if (!this.ready || !this.socket || this.socket.destroyed) return;
    const buf = this.frame(fixSec);
    for (let i = 0; i < times; i++) this.socket.write(buf);
    sent.push({ imei: this.imei, fixSec, scenario });
  }

  tick(): void {
    if (!this.ready) return;
    let fix = Math.floor(Date.now() / 1000);
    if (fix <= this.lastFix) fix = this.lastFix + 1;
    if (dupMode && this.special) {
      // Out of order and duplicated: t+1 is sent before t, and every frame twice.
      if (fix <= this.lastFix + 1) fix = this.lastFix + 2;
      this.write(fix + 1, 2);
      this.write(fix, 2);
      this.lastFix = fix + 1;
      return;
    }
    this.write(fix);
    this.lastFix = fix;
  }

  start(): void {
    this.connect();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS + Math.floor(Math.random() * 200));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.destroy();
  }
}
const imeis = Array.from({ length: DEVICES }, (_, i) => String(IMEI_START + i));
const devices = imeis.map((imei, i) => new Device(imei, i < 5));

// ── observation ──────────────────────────────────────────────────────────────

const direct = createRedis(CACHE_URL ?? `redis://127.0.0.1:${PORTS.valkey}`, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => 1000 });
direct.on('error', () => undefined);
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function getJson(url: string): Promise<{ code: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { code: res.status, body };
  } catch {
    return { code: 0, body: null };
  }
}

interface HealthSample {
  at: number;
  ready: number;
  tracking: string;
  gateway: string;
  spoolPending: number | null;
}
let samples: HealthSample[] = [];
async function sampleHealth(): Promise<void> {
  const [ready, tracking, gw] = await Promise.all([
    getJson(`http://127.0.0.1:${PORTS.api}/api/health`),
    getJson(`http://127.0.0.1:${PORTS.api}/api/health/tracking`),
    getJson(`http://127.0.0.1:${PORTS.gwHealth}/health`),
  ]);
  const spool = (gw.body?.spool as { pendingEntries?: number } | undefined)?.pendingEntries ?? null;
  samples.push({
    at: Date.now(),
    ready: ready.code,
    tracking: tracking.code ? `${tracking.code} ${String(tracking.body?.status ?? '?')}` : 'down',
    gateway: gw.code ? `${gw.code} ${String(gw.body?.status ?? '?')}` : 'down',
    spoolPending: spool,
  });
}
/** Distinct consecutive states, e.g. "200 → 503 → 200". */
const transitions = (values: string[]) => values.filter((v, i) => i === 0 || v !== values[i - 1]).join(' → ');

async function pipelineIdle(): Promise<{ idle: boolean; detail: string }> {
  const gw = await getJson(`http://127.0.0.1:${PORTS.gwHealth}/health`);
  const spool = (gw.body?.spool as { pendingEntries?: number } | undefined)?.pendingEntries ?? -1;
  try {
    if (direct.status !== 'ready') await direct.connect().catch(() => undefined);
    const groups = (await direct.xinfo('GROUPS', 'vt:positions')) as unknown[][];
    let lag = -1;
    let pending = -1;
    for (const g of groups) {
      const m = new Map<string, unknown>();
      for (let i = 0; i < g.length; i += 2) m.set(String(g[i]), g[i + 1]);
      if (m.get('name') === 'processor') {
        lag = Number(m.get('lag') ?? 0);
        pending = Number(m.get('pending') ?? 0);
      }
    }
    return { idle: spool === 0 && lag === 0 && pending === 0, detail: `spool=${spool} lag=${lag} pending=${pending}` };
  } catch (error) {
    return { idle: false, detail: `spool=${spool} cache: ${(error as Error).message}` };
  }
}

async function waitDrained(maxMs: number): Promise<number> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    await sampleHealth();
    const s = await pipelineIdle();
    last = s.detail;
    if (s.idle) {
      await sleep(4000); // the last batch commits after its XACK window
      return Date.now() - start;
    }
    await sleep(2000);
  }
  log(`not drained after ${maxMs / 1000}s (${last})`);
  return -1;
}

interface Result {
  scenario: string;
  sent: number;
  persisted: number;
  lost: number;
  extra: number;
  dbDuplicates: number;
  streamDupsDropped: number;
  drainMs: number;
  readiness: string;
  tracking: string;
  gateway: string;
  maxSpool: number;
  alerts: string[];
  notes: string[];
}
const results: Result[] = [];

async function processorDuplicates(): Promise<number> {
  const p = procs.get('processor');
  // Duplicates appear in the heartbeat; read it from the cache directly.
  try {
    const keys = await direct.zrange('vt:health:procs', 0, -1);
    let n = 0;
    for (const k of keys.filter((x) => x.includes(':processor:'))) {
      const v = await direct.get(k);
      if (v) n += (JSON.parse(v) as { metrics?: { duplicates?: number } }).metrics?.duplicates ?? 0;
    }
    return n;
  } catch {
    return p ? -1 : 0;
  }
}

async function verify(name: string, startedAt: number, drainMs: number, notes: string[], dupBefore: number): Promise<Result> {
  const mine = name === 'WHOLE RUN' ? sent : sent.filter((s) => s.scenario === name);
  const key = (imei: string, sec: number) => `${imei}@${sec}`;
  const expected = new Set(mine.map((s) => key(s.imei, s.fixSec)));
  const secs = mine.map((s) => s.fixSec);
  const from = new Date((Math.min(...secs, Math.floor(startedAt / 1000)) - 5) * 1000);
  const to = new Date((Math.max(...secs, Math.floor(Date.now() / 1000)) + 5) * 1000);
  const rows = await prisma.$queryRaw<{ uniqueId: string; fixTime: Date; n: bigint }[]>`
    SELECT d."uniqueId", p."fixTime", count(*) AS n FROM "Position" p JOIN "Device" d ON d.id = p."deviceId"
    WHERE d."uniqueId" = ANY(${imeis}) AND p."fixTime" BETWEEN ${from} AND ${to}
    GROUP BY 1, 2`;
  const got = new Set(rows.map((r) => key(r.uniqueId, Math.round(r.fixTime.getTime() / 1000))));
  const lost = [...expected].filter((k) => !got.has(k));
  // Fixes from other scenarios that fall in the same time window are not "extra".
  const allSent = new Set(sent.map((s) => key(s.imei, s.fixSec)));
  const extra = [...got].filter((k) => !allSent.has(k));
  if (lost.length) notes.push(`lost sample: ${lost.slice(0, 5).join(', ')}`);
  const sinceSamples = samples.filter((s) => s.at >= startedAt);
  const api = procs.get('api');
  const alerts = (api?.lines ?? []).filter((l) => l.at >= startedAt && /Mail "\[VeeTrax\]/.test(l.line)).map((l) => /Mail "([^"]+)"/.exec(l.line)?.[1] ?? l.line);
  const dupAfter = await processorDuplicates();
  return {
    scenario: name,
    sent: expected.size,
    persisted: [...expected].filter((k) => got.has(k)).length,
    lost: lost.length,
    extra: extra.length,
    dbDuplicates: rows.filter((r) => Number(r.n) > 1).length,
    streamDupsDropped: dupAfter >= 0 && dupBefore >= 0 ? dupAfter - dupBefore : -1,
    drainMs,
    readiness: transitions(sinceSamples.map((s) => String(s.ready))),
    tracking: transitions(sinceSamples.map((s) => s.tracking)),
    gateway: transitions(sinceSamples.map((s) => s.gateway)),
    maxSpool: Math.max(0, ...sinceSamples.map((s) => s.spoolPending ?? 0)),
    alerts: [...new Set(alerts)],
    notes,
  };
}

/** Samples health every 3 s while `fn` runs. */
async function observed(fn: () => Promise<void>): Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      await sampleHealth();
      await sleep(3000);
    }
  })();
  try {
    await fn();
  } finally {
    running = false;
    await loop;
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────

const cacheProxy = new ChaosProxy('cache', PORTS.valkeyProxy, cacheTarget?.hostname ?? '127.0.0.1', cacheTarget ? Number(cacheTarget.port || 6379) : PORTS.valkey);
const pgProxy = new ChaosProxy('postgres', PORTS.pgProxy, parsedDb.hostname, Number(parsedDb.port || 5432));

async function runScenario(name: string): Promise<void> {
  scenario = name;
  samples = [];
  const startedAt = Date.now();
  const notes: string[] = [];
  const dupBefore = await processorDuplicates();
  log(`── scenario ${name} ──`);
  await observed(async () => {
    switch (name) {
      case 'baseline':
        await sleep(40_000);
        break;
      case 'cache-kill':
        await sleep(10_000);
        log(`kill -9 valkey: ${valkey.kill9()}`);
        await sleep(60_000);
        log(`valkey restart (AOF kept): ${valkey.start()}`);
        await sleep(20_000);
        break;
      case 'cache-restart-empty':
        await sleep(10_000);
        log(`valkey shutdown + data wiped: ${valkey.wipe()}`);
        await sleep(20_000);
        log(`valkey start (empty): ${valkey.start()}`);
        notes.push('cache came back EMPTY (stream, consumer group, live state gone)');
        await sleep(30_000);
        break;
      case 'net-blackhole':
        await sleep(10_000);
        log('cache proxy → blackhole (connections open, nothing delivered)');
        cacheProxy.setMode('blackhole');
        await sleep(45_000);
        log('cache proxy → up (held data delivered late)');
        cacheProxy.setMode('up');
        await sleep(25_000);
        break;
      case 'net-cut':
        await sleep(10_000);
        log('cache proxy → cut (RST, new connections refused)');
        cacheProxy.setMode('cut');
        await sleep(40_000);
        cacheProxy.setMode('up');
        log('cache proxy → up');
        await sleep(20_000);
        break;
      case 'gateway-restart':
        await sleep(10_000);
        log('kill -9 gateway');
        await killProc('gateway');
        await sleep(10_000);
        startProc('gateway');
        await sleep(30_000);
        break;
      case 'processor-restart':
        await sleep(10_000);
        log('kill -9 processor');
        await killProc('processor');
        await sleep(30_000);
        startProc('processor');
        await sleep(40_000);
        break;
      case 'db-interruption':
        await sleep(10_000);
        log('postgres proxy → cut');
        pgProxy.setMode('cut');
        await sleep(60_000);
        pgProxy.setMode('up');
        log('postgres proxy → up');
        await sleep(30_000);
        break;
      case 'dup-ooo': {
        dupMode = true;
        await sleep(30_000);
        dupMode = false;
        // Stream-level duplicate: the same entry (same mid) XADDed twice, as after an XADD that timed out but was
        // applied and was then replayed from the spool.
        const fixSec = Math.floor(Date.now() / 1000) - 3600;
        const data = JSON.stringify({ protocol: 'gt06', uniqueId: imeis[DEVICES - 1], fixTime: new Date(fixSec * 1000).toISOString(), receivedAt: new Date().toISOString(), lat: 13.1, lng: 80.2, speedKph: 0, course: 0, altitude: null, satellites: 9, valid: true, ignition: true, attributes: {} });
        for (let i = 0; i < 2; i++) await direct.xadd('vt:positions', '*', 'data', data, 'remote', 'chaos', 'mid', 'chaos-dup-1');
        sent.push({ imei: imeis[DEVICES - 1], fixSec, scenario });
        notes.push('one entry XADDed twice with the same mid (expect 1 row, 1 duplicate dropped)');
        await sleep(10_000);
        break;
      }
      case 'prolonged':
        await sleep(10_000);
        log(`kill -9 valkey for ${PROLONGED_MIN} min: ${valkey.kill9()}`);
        await sleep(PROLONGED_MIN * 60_000);
        log(`valkey restart: ${valkey.start()}`);
        await sleep(20_000);
        break;
      default:
        throw new Error(`unknown scenario ${name}`);
    }
  });
  // Fixes sent from here on belong to the drain window; they are checked by the whole-run verification at the end.
  scenario = `${name}:drain`;
  const drainMs = await waitDrained(name === 'prolonged' ? 15 * 60_000 : 5 * 60_000);
  if (name === 'dup-ooo') {
    // Live state must hold the newest fix of each out-of-order device, not the last one received.
    const special = devices.filter((d) => d.special).map((d) => d.imei);
    const objects = await prisma.$queryRaw<{ uniqueId: string; objectId: string }[]>`
      SELECT DISTINCT d."uniqueId", p."objectId"::text AS "objectId" FROM "Position" p JOIN "Device" d ON d.id = p."deviceId"
      WHERE d."uniqueId" = ANY(${special}) AND p."objectId" IS NOT NULL`;
    for (const o of objects) {
      const live = JSON.parse((await direct.get(`vt:live:${o.objectId}`)) ?? '{}') as { fixTime?: string };
      const newest = Math.max(...sent.filter((s) => s.imei === o.uniqueId).map((s) => s.fixSec));
      const ok = live.fixTime && Math.round(Date.parse(live.fixTime) / 1000) >= newest - Math.ceil((INTERVAL_MS * 3) / 1000);
      notes.push(`live ${o.uniqueId}: ${live.fixTime ?? 'none'} ${ok ? 'OK (newest fix)' : 'STALE'}`);
    }
  }
  const r = await verify(name, startedAt, drainMs, notes, dupBefore);
  results.push(r);
  log(`result ${JSON.stringify(r)}`);
  writeReport();
}

function writeReport(): void {
  const rows = results.map(
    (r) =>
      `| ${r.scenario} | ${r.sent} | ${r.persisted} | ${r.lost} | ${r.extra} | ${r.dbDuplicates} | ${r.streamDupsDropped} | ${r.maxSpool} | ${r.drainMs >= 0 ? `${Math.round(r.drainMs / 1000)} s` : 'NOT DRAINED'} | ${r.readiness} | ${r.tracking} | ${r.gateway} | ${r.alerts.join('; ') || '—'} | ${r.notes.join('; ') || ''} |`,
  );
  const md = [
    `# Chaos run ${new Date(t0).toISOString()}`,
    '',
    `Devices ${DEVICES}, one GT06 0x22 fix every ${INTERVAL_MS / 1000} s each (no device ACK for these frames). Valkey: ${valkey.version()}.`,
    '',
    '| Scenario | Sent | Persisted | Lost | Extra | Dup rows in DB | Stream dups dropped (mid) | Max spooled | Drain after fault | /api/health | /api/health/tracking | gateway /health | Alert e-mails | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'results.md'), md);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`output: ${OUT}`);
  log(`scenarios: ${SCENARIOS.join(', ')}`);
  rmSync(join(OUT, 'spool'), { recursive: true, force: true });
  if (CACHE_URL) log(`external cache ${redactRedisUrl(CACHE_URL)} (${valkey.version()}); processes use ${redactRedisUrl(proxiedCache)}`);
  else log(`valkey: ${valkey.wipe()} / ${valkey.start()} (${valkey.version()})`);
  await cacheProxy.start();
  await pgProxy.start();
  await direct.connect();
  // Fresh pipeline state for the sim devices (scratch DB only).
  await prisma.$executeRaw`DELETE FROM "Position" WHERE "deviceId" IN (SELECT id FROM "Device" WHERE "uniqueId" = ANY(${imeis}))`;
  startProc('api');
  startProc('processor');
  startProc('gateway');
  // Wait for the API.
  for (let i = 0; i < 90; i++) {
    if ((await getJson(`http://127.0.0.1:${PORTS.api}/api/health`)).code === 200) break;
    await sleep(2000);
  }
  log('api ready; starting devices');
  devices.forEach((d) => d.start());
  scenario = 'warmup';
  await sleep(15_000);
  for (const name of SCENARIOS) await runScenario(name);
  devices.forEach((d) => d.stop());
  // Whole run: every fix sent while connected, including warm-up and drain windows, after the pipeline is idle.
  scenario = 'final';
  samples = [];
  const drainMs = await waitDrained(5 * 60_000);
  results.push(await verify('WHOLE RUN', t0, drainMs, [], 0));
  writeFileSync(join(OUT, 'sent.jsonl'), sent.map((s) => JSON.stringify(s)).join('\n'));
  writeReport();
  log(`done; report in ${join(OUT, 'results.md')}`);
  for (const name of ['gateway', 'processor', 'api']) await killProc(name);
  await cacheProxy.stop();
  await pgProxy.stop();
  direct.disconnect();
  await prisma.$disconnect();
  log(`spool dir after run: ${readdirSync(join(OUT, 'spool')).join(', ')}`);
  harnessLog.end();
  process.exit(0);
}

main().catch((error) => {
  log(`FAILED: ${(error as Error).stack}`);
  writeReport();
  process.exit(1);
});
