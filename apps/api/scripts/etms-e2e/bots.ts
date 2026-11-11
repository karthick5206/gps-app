/**
 * Thin dispatcher and passenger bots (12 WP 3.8; 16 §4.2: "for R1 (no driver app) the bot records dispatcher outcomes
 * through the dispatcher API at arrive events; GPS alone never sets BOARDED"). One full R1 cycle over HTTP against the
 * real API, with the vehicle driven by sim-trip through the real processor / v1.8 tracker:
 *
 *   dispatcher: 3 bookings → candidates → change set (CREATE_TRIP + 3 × ADD_PASSENGER) → publish → acknowledge → start
 *   vehicle:    sim-trip drives the trip's stops (pickup 1, 2, 3, office)
 *   dispatcher: at each pickup — after checking GPS left the passenger PENDING — BOARDED / BOARDED / NO_SHOW; at the
 *               office DROPPED × 2; complete
 *   passenger:  sees only the own trip (co-riders as a count), the vehicle while the trip runs, the own outcome
 *
 * Criteria: `BOT` for the cycle, `AC3b` for "the v1.8 tracker follows the trip under the simulator" (stop arrivals,
 * ETA, auto-complete) and GPS-never-boards on the real ingestion path.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { localDayKey } from '../../src/summarizer/tz';
import { Api, Recorder, sc } from './http-client';
import { HTTP_PASSWORD, type HttpAccounts } from './http-seed';
import { driveTrip, type TripSnapshot } from './sim-trip';

const MIN = 60_000;
const M_LAT = 1 / 111_320;

export async function runBotCycle(api: Api, acc: HttpAccounts, prisma: PrismaClient, redis: Redis, rec: Recorder): Promise<void> {
  const { ist } = acc;
  const disp = await api.login(acc.users.admin.email, HTTP_PASSWORD);
  const paxTok = await Promise.all(acc.users.passengers.slice(0, 3).map((u) => api.login(u.email, HTTP_PASSWORD)));
  const today = localDayKey(Date.now(), ist.timezone);
  const office = ist.sites[0];
  // Pickups 1.2 km, 0.8 km and 0.4 km north of the office: short, predictable legs for the simulator.
  const pickups = [1200, 800, 400].map((m) => ({ lat: Math.round((office.lat + m * M_LAT) * 1e6) / 1e6, lng: office.lng }));
  const start = Date.now() + 2 * MIN;

  // ── Dispatcher bot: bookings ──
  const bookingIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await api.call(disp, 'POST', '/transport/bookings', { passengerId: ist.passengers[i].id, serviceDate: today, direction: 'IN', windowStart: new Date(start - MIN).toISOString(), windowEnd: new Date(start + 60 * MIN).toISOString(), pickup: { ...pickups[i], label: `Bot pickup ${i + 1}` }, drop: { lat: office.lat, lng: office.lng, label: 'Office', poiId: office.id } }, { 'idempotency-key': randomUUID() });
    if (r.s >= 300) throw new Error(`booking ${i}: ${sc(r)} ${JSON.stringify(r.b).slice(0, 200)}`);
    bookingIds.push(r.b.id);
  }
  rec.check('BOT', 'dispatcher bot: 3 ad-hoc bookings for today (PENDING_ASSIGNMENT)', bookingIds.length === 3);
  const cand = await api.call(disp, 'POST', '/transport/dispatch/candidates', { bookingIds });
  const vehicle = ist.vehicles[0];
  rec.check('BOT', 'candidates over HTTP: the 6-seat van is a feasible candidate with a road ETA from the stub (or a degraded reason, never a guess)', cand.s === 200 && (cand.b.candidates as { objectId: string; feasible: boolean }[]).some((c) => c.objectId === vehicle.id && c.feasible), { s: cand.s, n: cand.b?.candidates?.length, routing: cand.b?.routingAvailable });

  // ── Publish ──
  const stops = [...pickups.map((p, i) => ({ seq: i, point: { ...p, label: `Bot pickup ${i + 1}` }, plannedArrival: new Date(start + i * 2 * MIN).toISOString() })), { seq: 3, point: { lat: office.lat, lng: office.lng, label: 'Office', poiId: office.id }, plannedArrival: new Date(start + 8 * MIN).toISOString() }];
  const pub = await api.call(disp, 'POST', '/transport/dispatch/change-sets', { serviceDate: today, direction: 'IN', changes: [{ op: 'CREATE_TRIP', tempId: 'bot', objectId: vehicle.id, driverId: ist.drivers[0].id, plannedStart: new Date(start).toISOString(), stops }, ...bookingIds.map((b, i) => ({ op: 'ADD_PASSENGER', tripId: 'bot', bookingId: b, pickupSeq: i, dropSeq: 3 }))] }, { 'idempotency-key': randomUUID() });
  if (pub.s !== 200) throw new Error(`publish: ${sc(pub)} ${JSON.stringify(pub.b).slice(0, 300)}`);
  const tripId = pub.b.trips[0].id as string;
  rec.check('BOT', 'publish over HTTP: 1 trip, 3 bookings ASSIGNED', pub.b.trips.length === 1 && (pub.b.bookings as { status: string }[]).filter((b) => b.status === 'ASSIGNED').length === 3, pub.b.bookings);

  // ── Passenger bot before the drive ──
  const mine = await api.call(paxTok[0], 'GET', `/me/transport/trips?from=${today}&to=${today}`);
  const text = JSON.stringify(mine.b);
  const t = (mine.b as { id: string; coRiders: number; liveVisible: boolean }[]).find((x) => x.id === tripId);
  rec.check('BOT', 'passenger bot: own trip listed, co-riders as a count (2), inside the vehicle window, no other passenger name', mine.s === 200 && !!t && t.coRiders === 2 && t.liveVisible === true && !text.includes(ist.passengers[1].displayName) && !text.includes(ist.passengers[2].displayName), { s: mine.s, t });

  // ── Dispatcher: acknowledge on behalf + start ──
  const ack = await api.call(disp, 'POST', `/transport/trips/${tripId}/acknowledge`, {});
  const st = await api.call(disp, 'POST', `/transport/trips/${tripId}/start`, { clientEventId: randomUUID() });
  rec.check('BOT', 'dispatcher acknowledges on the driver\'s behalf and starts the trip', ack.s === 200 && st.s === 200, { ack: sc(ack), start: sc(st) });
  const afterStart = await prisma.plannedTripStop.findFirstOrThrow({ where: { tripId: pub.b.trips[0].plannedTripId, seq: 0 } });

  // ── Vehicle: sim-trip through the processor; outcomes at the arrive events ──
  const paxOf = (snap: TripSnapshot, i: number) => snap.passengers.find((p) => p.bookingId === bookingIds[i])!;
  const outcome = async (snap: TripSnapshot, i: number, o: string) => api.call(disp, 'POST', `/transport/trips/${tripId}/passengers/${paxOf(snap, i).id}/outcome`, { outcome: o, clientEventId: randomUUID(), ...(o === 'NO_SHOW' ? { reasonCode: 'NOT_AT_PICKUP' } : {}) });
  let vehicleSeen: unknown = null;
  const gpsBoarded: string[] = [];
  const drive = await driveTrip({
    prisma,
    redis,
    tripId,
    log: (l) => console.log(`    sim ${l}`),
    onStop: async (seq, snap) => {
      // Whatever GPS did, a passenger without a dispatcher outcome is still PENDING here.
      const expected = ['PENDING', 'PENDING', 'PENDING'].map((s, i) => (i < seq && i < 2 ? 'BOARDED' : i < seq ? 'NO_SHOW' : s));
      const now = [0, 1, 2].map((i) => paxOf(snap, i).status);
      if (JSON.stringify(now) !== JSON.stringify(expected)) gpsBoarded.push(`stop ${seq}: ${now.join(',')} (expected ${expected.join(',')})`);
      if (seq === 0) {
        const v = await api.call(paxTok[0], 'GET', `/me/transport/trips/${tripId}/vehicle`);
        vehicleSeen = { s: v.s, visible: v.b?.visible, hasPosition: typeof v.b?.lat === 'number' };
      }
      const r = seq < 2 ? await outcome(snap, seq, 'BOARDED') : seq === 2 ? await outcome(snap, 2, 'NO_SHOW') : null;
      if (r && r.s !== 200) throw new Error(`outcome at stop ${seq}: ${sc(r)}`);
      if (seq === 3) for (const i of [0, 1]) if ((await outcome(snap, i, 'DROPPED')).s !== 200) throw new Error(`DROPPED ${i}`);
    },
  });
  const snaps = drive.snapshots;
  const last = snaps.at(-1)!;

  // ── AC3b: the v1.8 tracker followed the trip ──
  rec.check('AC3b', `sim-trip sent ${drive.fixes} fixes for IMEI ${drive.imei} through vt:positions; the processor stored them as Position rows (standing fixes may be thinned)`, (await prisma.position.count({ where: { objectId: vehicle.id } })) > drive.fixes / 2, { fixes: drive.fixes });
  rec.check('AC3b', 'the live cache shows the van (vt:live) and the passenger saw it while the trip ran', (await redis.exists(`vt:live:${vehicle.id}`)) === 1 && (vehicleSeen as { visible?: boolean } | null)?.visible === true, vehicleSeen);
  const arrived = (seq: number) => last.stops.find((s) => s.seq === seq);
  rec.check('AC3b', 'GPS stop arrivals: pickups 2 and 3 ARRIVED → DEPARTED with an arrival time, the office ARRIVED', [1, 2].every((q) => arrived(q)?.status === 'DEPARTED' && !!arrived(q)?.actualArrival) && arrived(3)?.status === 'ARRIVED', last.stops);
  rec.check('AC3b', 'the trip auto-completed at the office from GPS (COMPLETED, closedBy AUTO)', last.status === 'COMPLETED' && last.closedBy === 'AUTO', { status: last.status, closedBy: last.closedBy });
  const etas = snaps.filter((s) => s.etaNextStop).map((s) => [s.atStop, s.nextStopSeq, s.etaNextStop]);
  rec.check('AC3b', 'ETA updates: the tracker set the next stop and its ETA while driving (nextStopSeq advanced)', etas.length >= 2 && new Set(etas.map((e) => e[1])).size >= 2, { etas, next: snaps.map((s) => s.nextStopSeq) });
  rec.check('AC3b', 'GPS never sets BOARDED: at every stop, passengers without a dispatcher outcome were still PENDING', gpsBoarded.length === 0, gpsBoarded);
  const events = await prisma.transportTripEvent.findMany({ where: { tripId, kind: { in: ['BOARDED', 'NO_SHOW', 'DROPPED'] } }, select: { kind: true, source: true, actorType: true } });
  rec.check('AC3b', 'every passenger outcome event came from the dispatcher (source WEB), none from GPS / SYSTEM', events.length === 5 && events.every((e) => e.source === 'WEB'), events);
  rec.tagged('AC3b', 'secfix B5', 'after a dispatcher start, the first pickup stop is not DEPARTED until GPS sees the van leave it', () => afterStart.status !== 'DEPARTED', { status: afterStart.status, actualArrival: afterStart.actualArrival, actualDeparture: afterStart.actualDeparture });

  // ── Dispatcher: complete; passenger bot: own outcome ──
  const done = await api.call(disp, 'POST', `/transport/trips/${tripId}/complete`, { note: 'e3h bot' });
  rec.check('BOT', 'dispatcher complete after GPS auto-complete → 200, no change; outcomes DROPPED / DROPPED / NO_SHOW kept', done.s === 200 && JSON.stringify(bookingIds.map((b) => (done.b.passengers as { bookingId: string; status: string }[]).find((p) => p.bookingId === b)?.status)) === JSON.stringify(['DROPPED', 'DROPPED', 'NO_SHOW']), { s: sc(done), pax: done.b?.passengers?.map((p: { status: string }) => p.status) });
  const p0 = await api.call(paxTok[0], 'GET', `/me/transport/trips/${tripId}`);
  const p2v = await api.call(paxTok[2], 'GET', `/me/transport/trips/${tripId}/vehicle`);
  rec.check('BOT', 'passenger bots: P1 sees myStatus DROPPED; the no-show passenger no longer sees the vehicle', p0.s === 200 && p0.b.myStatus === 'DROPPED' && p2v.s === 200 && p2v.b.visible === false, { p0: [p0.s, p0.b?.myStatus], p2: [p2v.s, p2v.b] });
  const report = { tripId, fixes: drive.fixes, snapshots: snaps.map((s) => ({ at: s.atStop, status: s.status, next: s.nextStopSeq, eta: s.etaNextStop, delay: s.delaySec, stops: s.stops.map((x) => x.status).join(','), pax: s.passengers.map((x) => x.status).join(',') })) };
  rec.check('BOT', 'cycle report', true, report);
}
