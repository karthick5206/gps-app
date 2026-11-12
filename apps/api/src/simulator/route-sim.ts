/**
 * Route-driving GPS simulator for planned trips (see README.md, "Route simulator").
 *   npm run sim:route -w @veetracer/api -- --scenario on-time --imei 868120000000001 [--dry-run]
 *
 * Route:     --scenario <name|file.json> (scenarios/*.json)  |  --route-file <file.json>  |  --stops "lat,lng;lat,lng;..."
 * Path:      --path-file <file.json>  |  --router-url http://host:8989  |  the route file's path  |  straight lines
 * Driving:   --cruise 30 (km/h)  --interval 5 (s)  --speed-factor 1  --start-dwell 60 (s)  --wait 0 (s, --stops only)
 *            --corridor 200 (m, deviation on/off messages only)
 * Scenario:  --delay-stop <i> --delay-sec <s>  --skip-stop <i>  --deviation "fromFrac,toFrac,offsetM[,left|right]"
 *            --unscheduled "atFrac,sec"   (override / add to the scenario file)
 * Devices:   --imei <imei> (repeatable or comma-separated) | --imei-start <n> --count <n>   --stagger 0 (s)
 * Gateway:   --host 127.0.0.1 --port 5023 --protocol gt06|gt06-4g --tz 330
 * --dry-run prints the timeline as CSV (stdout) and the stop summary (stderr) without connecting.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_IMEI_START, imeiAt, numberArg, parseArgs } from './cli-args';
import { Gt06Link, Gt06Variant } from './gt06-link';
import { arrivalTable, buildTimeline, DriveScenario, DriveTimeline } from './route-drive';
import { fetchGraphHopperPath, parsePath, parseRouteFile, parseStopsArg, RouteSource } from './route-source';

const SCENARIO_DIR = resolve(__dirname, 'scenarios');
const TICK_MS = 200;

interface ScenarioFile {
  name?: string;
  description?: string;
  route?: string;
  cruiseKph?: number;
  scenario?: DriveScenario;
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);

/** All values of a repeatable flag (`--imei a --imei b,c`). */
function multiArg(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${name}`) out.push(...argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
  return out;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

function scenarioPath(raw: string): string {
  // ETMS scenarios (etms-*.json, E5 WP 5.5) need the driver / passenger APIs as well as the vehicle: their own runner.
  if (/(^|[\\/])etms-[a-z0-9-]+(\.json)?$/.test(raw)) throw new Error(`"${raw}" is an ETMS scenario: run it with npm run etms:e5 -w @veetracer/api -- --scenario ${raw.replace(/^.*[\\/]/, '').replace(/\.json$/, '')} (see scripts/etms-e2e/README.md)`);
  const candidates = [raw, resolve(SCENARIO_DIR, raw), resolve(SCENARIO_DIR, `${raw}.json`)];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Scenario "${raw}" not found (looked in ${SCENARIO_DIR})`);
  return found;
}

function fracList(raw: string, flag: string): string[] {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length < 2) throw new Error(`--${flag} has too few values`);
  return parts;
}

async function loadRoute(scenarioFile: ScenarioFile | null, scenarioDir: string): Promise<{ source: RouteSource; pathFrom: string }> {
  let source: RouteSource;
  const routeFile = args.get('route-file') ?? (scenarioFile?.route ? (isAbsolute(scenarioFile.route) ? scenarioFile.route : resolve(scenarioDir, scenarioFile.route)) : undefined);
  if (args.has('stops')) source = { stops: parseStopsArg(args.get('stops')!, numberArg(args, 'wait', 0)), path: null };
  else if (routeFile) source = parseRouteFile(readJson(routeFile));
  else throw new Error('Give --scenario, --route-file or --stops');

  let pathFrom = source.path ? 'route file' : 'straight lines between stops';
  if (args.has('path-file')) {
    source.path = parsePath(readJson(args.get('path-file')!));
    pathFrom = `path file ${args.get('path-file')}`;
  } else if (args.has('router-url')) {
    source.path = await fetchGraphHopperPath(args.get('router-url')!, source.stops);
    pathFrom = `GraphHopper ${args.get('router-url')}`;
  }
  return { source, pathFrom };
}

function scenarioFromArgs(base: DriveScenario): DriveScenario {
  const s: DriveScenario = { ...base };
  if (args.has('speed-factor')) s.speedFactor = numberArg(args, 'speed-factor', 1);
  if (args.has('delay-stop') || args.has('delay-sec'))
    s.delayAtStopSec = { stop: numberArg(args, 'delay-stop', s.delayAtStopSec?.stop ?? 1), sec: numberArg(args, 'delay-sec', s.delayAtStopSec?.sec ?? 900) };
  if (args.has('skip-stop')) s.skipStop = numberArg(args, 'skip-stop', 1);
  if (args.has('deviation')) {
    const [a, b, o, side] = fracList(args.get('deviation')!, 'deviation');
    s.deviation = { fromFrac: Number(a), toFrac: Number(b), offsetM: Number(o ?? 400), side: side === 'right' ? 'right' : 'left' };
  }
  if (args.has('unscheduled')) {
    const [a, sec] = fracList(args.get('unscheduled')!, 'unscheduled');
    s.unscheduledStop = { atFrac: Number(a), sec: Number(sec) };
  }
  return s;
}

const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function printDryRun(tl: DriveTimeline): void {
  const start = Math.floor(Date.now() / 1000) * 1000;
  const eventsAt = new Map<number, string[]>();
  for (const e of tl.events) eventsAt.set(e.fixIndex, [...(eventsAt.get(e.fixIndex) ?? []), `${e.type}${e.stop !== undefined ? `#${e.stop}` : ''}`]);
  const lines = ['t,time,lat,lng,speedKph,course,alongM,offsetM,events'];
  tl.fixes.forEach((f, i) =>
    lines.push([f.t, new Date(start + f.t * 1000).toISOString(), f.lat, f.lng, f.speedKph, f.course, f.alongM, f.offsetM, (eventsAt.get(i) ?? []).join(' ')].join(',')),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printSummary(tl: DriveTimeline, header: string): void {
  const err = (s: string) => process.stderr.write(`${s}\n`);
  err(header);
  err(`path ${(tl.pathLengthM / 1000).toFixed(2)} km, ${tl.fixes.length} fixes, drive ${mmss(tl.durationSec)} (mm:ss wall clock), speed factor ${tl.speedFactor}`);
  for (const line of arrivalTable(tl)) err(`  ${line}`);
  for (const e of tl.events) err(`  +${mmss(e.t)} ${e.type.padEnd(17)} ${e.detail}`);
}

class RouteDevice {
  private readonly link: Gt06Link;
  private startedAt = 0;
  private next = 0;
  sent = 0;
  missed = 0;
  done = false;

  constructor(
    readonly imei: string,
    private readonly tl: DriveTimeline,
    gateway: { host: string; port: number; protocol: Gt06Variant; tzMinutes: number },
  ) {
    this.link = new Gt06Link(imei, {
      ...gateway,
      onReady: () => {
        if (!this.startedAt) {
          this.startedAt = Date.now();
          this.log('logged in, drive started');
        } else this.log('reconnected');
      },
      onClose: () => this.log('connection dropped, reconnecting'),
    });
  }

  connect(): void {
    this.link.connect();
  }

  tick(now: number): void {
    if (this.done || !this.startedAt) return;
    const due = (i: number) => this.startedAt + this.tl.fixes[i].t * 1000;
    if (now < due(this.next)) return;
    const first = this.next;
    // Never burst: after a stall or a reconnect jump to the latest due fix.
    while (this.next + 1 < this.tl.fixes.length && now >= due(this.next + 1)) this.next++;
    this.missed += this.next - first;
    const fix = this.tl.fixes[this.next];
    const ok = this.link.sendFix({ time: new Date(Math.floor(now / 1000) * 1000), lat: fix.lat, lng: fix.lng, speedKph: fix.speedKph, course: fix.course });
    if (ok) this.sent++;
    else this.missed++;
    for (const e of this.tl.events) if (e.fixIndex >= first && e.fixIndex <= this.next) this.log(`${e.type} ${e.detail}`, e.t);
    this.next++;
    if (this.next >= this.tl.fixes.length) {
      this.done = true;
      this.log(`finished: sent ${this.sent}, missed ${this.missed}, reconnects ${this.link.reconnects}`);
      setTimeout(() => this.link.stop(), 1000);
    }
  }

  stop(): void {
    this.done = true;
    this.link.stop();
  }

  private log(msg: string, t?: number): void {
    const at = t ?? (this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0);
    console.log(`[${this.imei}] +${mmss(at)} ${msg}`);
  }
}

async function main(): Promise<void> {
  const scenarioArg = args.get('scenario');
  const scenarioFileName = scenarioArg ? scenarioPath(scenarioArg) : null;
  const scenarioFile = scenarioFileName ? (readJson(scenarioFileName) as ScenarioFile) : null;
  const { source, pathFrom } = await loadRoute(scenarioFile, scenarioFileName ? dirname(scenarioFileName) : process.cwd());
  const scenario = scenarioFromArgs(scenarioFile?.scenario ?? {});
  const tl = buildTimeline(source.path ?? [], source.stops, {
    cruiseKph: numberArg(args, 'cruise', scenarioFile?.cruiseKph ?? 30),
    intervalSec: numberArg(args, 'interval', 5),
    corridorM: numberArg(args, 'corridor', source.corridorM ?? 200),
    startDwellSec: numberArg(args, 'start-dwell', 60),
    scenario,
  });
  const header = `scenario ${scenarioFile?.name ?? '(none)'}: ${JSON.stringify(scenario)}; ${source.stops.length} stops; path from ${pathFrom}`;
  printSummary(tl, header);
  for (const s of tl.stops) if (s.snapM > s.radiusM) process.stderr.write(`  warning: ${s.name} is ${s.snapM} m from the path (radius ${s.radiusM} m)\n`);

  if (args.get('dry-run') === 'true') {
    printDryRun(tl);
    return;
  }

  const protocol = (args.get('protocol') ?? 'gt06') as Gt06Variant;
  if (protocol !== 'gt06' && protocol !== 'gt06-4g') throw new Error('--protocol must be gt06 or gt06-4g');
  const gateway = { host: args.get('host') ?? '127.0.0.1', port: numberArg(args, 'port', 5023), protocol, tzMinutes: numberArg(args, 'tz', 330) };
  let imeis = multiArg('imei');
  if (!imeis.length) imeis = Array.from({ length: numberArg(args, 'count', 1) }, (_, i) => imeiAt(numberArg(args, 'imei-start', DEFAULT_IMEI_START), i));
  const bad = imeis.find((i) => !/^\d{15,16}$/.test(i));
  if (bad) throw new Error(`Invalid IMEI ${bad}`);
  const staggerMs = numberArg(args, 'stagger', 0) * 1000;

  const devices = imeis.map((imei) => new RouteDevice(imei, tl, gateway));
  console.log(`Driving ${devices.length} ${protocol} device(s) → ${gateway.host}:${gateway.port}, a fix every ${numberArg(args, 'interval', 5)} s, stagger ${staggerMs / 1000} s`);
  const timers = devices.map((d, i) => setTimeout(() => d.connect(), i * staggerMs));
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const d of devices) d.tick(now);
    if (devices.every((d) => d.done)) finish(0);
  }, TICK_MS);
  let finished = false;
  function finish(code: number): void {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    timers.forEach(clearTimeout);
    devices.forEach((d) => d.stop());
    const sent = devices.reduce((n, d) => n + d.sent, 0);
    console.log(`[route-sim] done: ${sent} fixes sent by ${devices.length} device(s)`);
    setTimeout(() => process.exit(code), 1500);
  }
  process.once('SIGINT', () => finish(130));
  process.once('SIGTERM', () => finish(143));
}

main().catch((err: unknown) => {
  console.error(`route-sim: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
