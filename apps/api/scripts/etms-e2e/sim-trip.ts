/**
 * `sim:route --trip <id>` for ETMS (12 WP 3.8; 16 §4.2 "Proposed: --trip <id>"): drives the vehicle of a published
 * ETMS trip along the trip's own stops through the v1.8 ingestion path. Each fix is a NormalizedPosition XADDed to
 * `vt:positions` exactly as the gateway writes it (fields data / remote / mid), so the real processor resolves the
 * device, updates the live cache and runs the planned-trip tracker; nothing is written to the database directly.
 *
 *   ETMS_SIM_DATABASE_URL=postgresql://…/veetrax_e3h_x_test ETMS_SIM_REDIS_URL=redis://127.0.0.1:6379/11 \
 *     npx tsx scripts/etms-e2e/sim-trip.ts --trip <transportTripId> [--step-m 20] [--speed 72] [--dwell 3]
 *
 * Geometry: starts `approach` metres before stop 0, straight legs between consecutive stops in `step` metre fixes, one
 * fix per `interval` ms of wall clock (fix time = now, so nothing is flagged FUTURE), `dwell` standing fixes inside
 * every stop. After each stop it waits until the processor's consumer group has acknowledged every fix sent so far,
 * then reports a snapshot (stop statuses, trip status / next stop / ETA / delay, passenger statuses) to `onStop`.
 * Refuses a database that is not `*_test` and Valkey database 0.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const POSITIONS = 'vt:positions';
const GROUP = 'processor';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}
const lerp = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, f: number) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });

export interface TripSnapshot {
  atStop: number;
  status: string;
  closedBy: string | null;
  nextStopSeq: number | null;
  etaNextStop: string | null;
  delaySec: number | null;
  stops: { seq: number; status: string; actualArrival: string | null }[];
  passengers: { id: string; bookingId: string; status: string; outcomeSource: string | null }[];
}

export interface DriveOptions {
  prisma: PrismaClient;
  redis: Redis;
  tripId: string;
  stepM?: number;
  speedKph?: number;
  intervalMs?: number;
  dwellFixes?: number;
  approachM?: number;
  /** Called after the dwell at each stop once the processor has consumed every fix (bots record outcomes here). */
  onStop?: (seq: number, snap: TripSnapshot) => Promise<void>;
  log?: (line: string) => void;
}

export async function snapshot(prisma: PrismaClient, tripId: string, atStop: number): Promise<TripSnapshot> {
  const t = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId }, include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } }, passengers: { orderBy: { pickupSeq: 'asc' } } } });
  const pt = t.plannedTrip!;
  return {
    atStop,
    status: pt.status,
    closedBy: pt.closedBy,
    nextStopSeq: pt.nextStopSeq,
    etaNextStop: pt.etaNextStop?.toISOString() ?? null,
    delaySec: pt.delaySec,
    stops: pt.stops.map((s) => ({ seq: s.seq, status: s.status, actualArrival: s.actualArrival?.toISOString() ?? null })),
    passengers: t.passengers.map((p) => ({ id: p.id, bookingId: p.bookingId, status: p.status, outcomeSource: p.outcomeSource })),
  };
}

const idLe = (a: string, b: string) => {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am < bm || (am === bm && as <= bs);
};

/** Waits until the processor group has delivered and acknowledged everything up to `lastId`. */
export async function drained(redis: Redis, lastId: string, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const groups = (await redis.xinfo('GROUPS', POSITIONS)) as unknown[][];
    const g = groups.map((row) => Object.fromEntries(Array.from({ length: row.length / 2 }, (_, i) => [String(row[2 * i]), row[2 * i + 1]]))).find((x) => x.name === GROUP);
    if (g && idLe(lastId, String(g['last-delivered-id'])) && Number(g.pending) === 0) return;
    await sleep(200);
  }
  throw new Error(`processor did not consume the simulated fixes within ${timeoutMs} ms`);
}

export async function driveTrip(o: DriveOptions): Promise<{ imei: string; fixes: number; snapshots: TripSnapshot[] }> {
  const step = o.stepM ?? 20;
  const speed = o.speedKph ?? 72;
  const interval = o.intervalMs ?? 1000;
  const dwell = o.dwellFixes ?? 3;
  const log = o.log ?? (() => undefined);
  const trip = await o.prisma.transportTrip.findUniqueOrThrow({ where: { id: o.tripId }, include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } } } });
  const pt = trip.plannedTrip;
  if (!pt || pt.stops.length < 2) throw new Error('the trip has no planned trip with stops');
  const assignment = await o.prisma.deviceAssignment.findFirst({ where: { objectId: pt.objectId, toTime: null }, include: { device: { select: { uniqueId: true } } } });
  if (!assignment) throw new Error('the trip vehicle has no device fitted');
  const imei = assignment.device.uniqueId;
  const stops = pt.stops.map((s) => ({ seq: s.seq, lat: s.lat, lng: s.lng }));
  let fixes = 0;
  let lastId = '0-0';
  const send = async (p: { lat: number; lng: number }, kph: number, course: number) => {
    const now = new Date().toISOString();
    const data = { protocol: 'gt06', uniqueId: imei, fixTime: now, receivedAt: now, lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6, speedKph: kph, course, altitude: null, satellites: 10, valid: true, ignition: true, attributes: { sim: 'e3h-sim-trip' } };
    lastId = String(await o.redis.xadd(POSITIONS, 'MAXLEN', '~', '100000', '*', 'data', JSON.stringify(data), 'remote', 'e3h-sim-trip', 'mid', randomUUID()));
    fixes++;
    await sleep(interval);
  };
  // Start `approach` m before stop 0, on the line away from stop 1.
  const away = distM(stops[0], stops[1]) || 1;
  let pos = lerp(stops[0], stops[1], -(o.approachM ?? 300) / away);
  const snaps: TripSnapshot[] = [];
  for (const s of stops) {
    const d = distM(pos, s);
    const n = Math.max(1, Math.ceil(d / step));
    const course = bearing(pos, s);
    for (let i = 1; i <= n; i++) await send(lerp(pos, s, i / n), i === n ? 5 : speed, course);
    for (let i = 0; i < dwell; i++) await send(s, 0, course);
    pos = { lat: s.lat, lng: s.lng };
    await drained(o.redis, lastId);
    const snap = await snapshot(o.prisma, o.tripId, s.seq);
    snaps.push(snap);
    log(`stop ${s.seq}: trip ${snap.status} next ${snap.nextStopSeq} eta ${snap.etaNextStop} stops ${snap.stops.map((x) => x.status).join(',')} pax ${snap.passengers.map((x) => x.status).join(',')}`);
    if (o.onStop) await o.onStop(s.seq, snap);
  }
  return { imei, fixes, snapshots: snaps };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tripId = opt('trip');
  const db = process.env.ETMS_SIM_DATABASE_URL ?? '';
  const rurl = process.env.ETMS_SIM_REDIS_URL ?? '';
  if (!tripId) throw new Error('--trip <transportTripId> is required');
  if (!/\/[a-z0-9_]+_test(\?|$)/.test(db)) throw new Error('ETMS_SIM_DATABASE_URL must name a *_test database');
  if (!Number(new URL(rurl || 'redis://x/0').pathname.replace('/', ''))) throw new Error('ETMS_SIM_REDIS_URL must name a Valkey database other than 0');
  const prisma = new PrismaClient({ datasourceUrl: db });
  const redis = new Redis(rurl);
  try {
    const r = await driveTrip({ prisma, redis, tripId, stepM: Number(opt('step-m') ?? 20), speedKph: Number(opt('speed') ?? 72), dwellFixes: Number(opt('dwell') ?? 3), log: (l) => console.log(l) });
    console.log(JSON.stringify({ imei: r.imei, fixes: r.fixes, final: r.snapshots.at(-1) }, null, 2));
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

if (require.main === module)
  main().catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
