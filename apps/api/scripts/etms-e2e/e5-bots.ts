/**
 * E5 WP 5.5: one ETMS scenario (src/simulator/scenarios/etms-*.json) end to end over HTTP against the real API,
 * processor and notifier (fake push provider). The dispatcher bot books and publishes; the driver bot uses the real
 * driver API exactly as the app does (duty start, ACKNOWLEDGE, online start, per-stop events with stable
 * clientEventIds and a per-trip seq, an offline queue replayed shuffled and duplicated — R6); sim-trip drives the van
 * through vt:positions; the passenger bots register (synthetic) push tokens and read their own trip and inbox.
 *
 * Criterion of every check = the scenario name; `NOTIFY` for the notification / push checks; `R6` for the replay.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { ETMS_DRIVER_ROLE_NAME } from '@veetracer/shared';
import { existsSync, readFileSync } from 'node:fs';
import { localDayKey } from '../../src/summarizer/tz';
import { assertNoOpenBookings } from '../../src/etms/dispatch/erasure';
import { convergenceKey, offlineAt, plannedEventsAt, replayBatches, type EtmsScenario, type PlannedEvent } from '../../src/etms/testing/e5-scenario';
import { Api, Recorder, sc } from './http-client';
import { HTTP_PASSWORD, type HttpAccounts } from './http-seed';
import { driveTrip, snapshot } from './sim-trip';

const MIN = 60_000;
const M_LAT = 1 / 111_320;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScenarioSlot {
  /** Index of the first of the scenario's passengers in acc.ist.passengers (they all have logins). */
  paxFrom: number;
  vehicle: number;
  driver: number;
}

export interface ScenarioOutcome {
  name: string;
  tripId: string | null;
  key: string | null;
  passengerIndexOf: Record<string, number>;
}

interface WireEvent {
  clientEventId: string;
  seq: number;
  type: string;
  occurredAt: string;
  stopSeq?: number;
  passengerTripId?: string;
  reasonCode?: string;
  etaMin?: number;
  clockOffsetMs?: number;
}
interface EventResult {
  clientEventId: string;
  seq: number;
  outcome: 'ACCEPTED' | 'DUPLICATE' | 'LATE' | 'REJECTED' | 'RETRY';
  code: string | null;
  original?: string;
}

/** Driver logins: a User with the real "Transport driver" template role linked as Driver.userId (what POST /drivers/:id/login does; the Transport admin template has no `drivers` edit, so it is seeded) + the API sign-in; once per run. */
export async function driverLogins(api: Api, acc: HttpAccounts, prisma: PrismaClient): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({ where: { companyId_name: { companyId: acc.ist.id, name: ETMS_DRIVER_ROLE_NAME } } });
  const pw = await hash(HTTP_PASSWORD, 4);
  const out: string[] = [];
  for (const [i, d] of acc.ist.drivers.entries()) {
    const email = `${acc.tag}.driver${i + 1}@example.test`;
    const u = await prisma.user.create({ data: { companyId: acc.ist.id, name: d.name, email, passwordHash: pw, roles: { create: [{ roleId: role.id }] } } });
    await prisma.driver.update({ where: { id: d.id }, data: { userId: u.id } });
    out.push(await api.login(email, HTTP_PASSWORD));
  }
  return out;
}

const pushToken = (key: string) => `ExponentPushToken[e5s${key.replace(/[^A-Za-z0-9]/g, '').slice(-24).padStart(12, '0')}]`;

export async function runScenario(
  s: EtmsScenario,
  slot: ScenarioSlot,
  ctx: { api: Api; acc: HttpAccounts; prisma: PrismaClient; redis: Redis; rec: Recorder; adminTok: string; driverTok: string; pushLog: string; baseline?: ScenarioOutcome },
): Promise<ScenarioOutcome> {
  const { api, acc, prisma, redis, rec, adminTok: disp, driverTok: drv } = ctx;
  const C = s.name;
  const { ist } = acc;
  const n = s.pickupsM.length;
  const paxRows = ist.passengers.slice(slot.paxFrom, slot.paxFrom + n);
  const paxUsers = acc.users.passengers.slice(slot.paxFrom, slot.paxFrom + n);
  if (paxUsers.length < n) throw new Error('not enough passenger logins for the scenario');
  const paxTok = await Promise.all(paxUsers.map((u) => api.login(u.email, HTTP_PASSWORD)));
  const driver = ist.drivers[slot.driver];
  const vehicle = ist.vehicles[slot.vehicle];
  const office = ist.sites[0];
  const today = localDayKey(Date.now(), ist.timezone);
  const pickups = s.pickupsM.map((m) => ({ lat: Math.round((office.lat + m * M_LAT) * 1e6) / 1e6, lng: office.lng }));
  const start = Date.now() + 2 * MIN;
  const outcome: ScenarioOutcome = { name: C, tripId: null, key: null, passengerIndexOf: {} };

  // ── Push tokens: driver + passengers, as the apps register them after sign-in ──
  const tokens = [drv, ...paxTok];
  const regs = await Promise.all(tokens.map((t, i) => api.call(t, 'POST', '/auth/push-token', { token: pushToken(`${C}${i}`), platform: 'android', deviceName: 'e5s emulator' })));
  rec.check(C, 'driver and passenger apps register a push token (synthetic ExponentPushToken)', regs.every((r) => r.s === 200), regs.map(sc));

  // ── Dispatcher bot: bookings + publish with the driver ──
  const bookingIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await api.call(disp, 'POST', '/transport/bookings', { passengerId: paxRows[i].id, serviceDate: today, direction: 'IN', windowStart: new Date(start - MIN).toISOString(), windowEnd: new Date(start + 60 * MIN).toISOString(), pickup: { ...pickups[i], label: `Sim pickup ${i + 1}` }, drop: { lat: office.lat, lng: office.lng, label: 'Office', poiId: office.id } }, { 'idempotency-key': randomUUID() });
    if (r.s >= 300) throw new Error(`booking ${i}: ${sc(r)} ${JSON.stringify(r.b).slice(0, 200)}`);
    bookingIds.push(r.b.id);
  }
  const stops = [...pickups.map((p, i) => ({ seq: i, point: { ...p, label: `Sim pickup ${i + 1}` }, plannedArrival: new Date(start + i * 2 * MIN).toISOString() })), { seq: n, point: { lat: office.lat, lng: office.lng, label: 'Office', poiId: office.id }, plannedArrival: new Date(start + 2 * n * MIN + 2 * MIN).toISOString() }];
  const pub = await api.call(disp, 'POST', '/transport/dispatch/change-sets', { serviceDate: today, direction: 'IN', changes: [{ op: 'CREATE_TRIP', tempId: 'sim', objectId: vehicle.id, driverId: driver.id, plannedStart: new Date(start).toISOString(), stops }, ...bookingIds.map((b, i) => ({ op: 'ADD_PASSENGER', tripId: 'sim', bookingId: b, pickupSeq: i, dropSeq: n }))] }, { 'idempotency-key': randomUUID() });
  if (pub.s !== 200) throw new Error(`publish: ${sc(pub)} ${JSON.stringify(pub.b).slice(0, 300)}`);
  const tripId = pub.b.trips[0].id as string;
  outcome.tripId = tripId;
  rec.check(C, `dispatcher publishes 1 trip with ${n} passengers and the driver (bookings ASSIGNED)`, (pub.b.bookings as { status: string }[]).filter((b) => b.status === 'ASSIGNED').length === n);
  const snap0 = await snapshot(prisma, tripId, -1);
  const paxId = (i: number) => snap0.passengers.find((p) => p.bookingId === bookingIds[i])!.id;
  for (let i = 0; i < n; i++) outcome.passengerIndexOf[paxId(i)] = i;

  // ── Before the start: the relay (every 30 s) sends TRIP_ASSIGNED and, while the trip is still SCHEDULED, the
  //    passengers' TRIP_STARTING_SOON (by design none once the trip is under way). Wait for one relay pass. ──
  const relayBy = Date.now() + 75_000;
  let preStart: string[] = [];
  while (Date.now() < relayBy) {
    preStart = (await prisma.transportNotification.findMany({ where: { tripId }, select: { kind: true } })).map((r) => r.kind);
    if (preStart.includes('TRIP_ASSIGNED') && preStart.filter((k) => k === 'TRIP_STARTING_SOON').length === n) break;
    await sleep(2_000);
  }
  rec.check(C, `relay pass before the start: TRIP_ASSIGNED + ${n} × TRIP_STARTING_SOON written while the trip is SCHEDULED`, preStart.includes('TRIP_ASSIGNED') && preStart.filter((k) => k === 'TRIP_STARTING_SOON').length === n, preStart);

  // ── Driver bot: me, duty, trip list, detail ──
  const me = await api.call(drv, 'GET', '/driver/v1/me');
  const duty = await api.call(drv, 'POST', '/driver/v1/duty/start', { clientEventId: randomUUID(), occurredAt: new Date().toISOString(), objectId: vehicle.id });
  const list = await api.call(drv, 'GET', '/driver/v1/trips');
  const det = await api.call(drv, 'GET', `/driver/v1/trips/${tripId}`);
  rec.check(C, 'driver app: /me 200, duty start 200, the trip is in /trips, detail shows the manifest (names, no contact)', me.s === 200 && duty.s === 200 && list.s === 200 && (list.b as { id: string }[]).some((t) => t.id === tripId) && det.s === 200 && det.b.passengers?.length === n && det.b.passengers.every((p: { contact: unknown }) => p.contact === null), { me: sc(me), duty: sc(duty), list: sc(list), det: sc(det) });

  // ── Driver events: seq per trip, stable ids; online = sent now, offline = queued ──
  let seq = 0;
  const results = new Map<string, EventResult[]>();
  const sentIds: string[] = [];
  const queue: WireEvent[] = [];
  const wire = (e: PlannedEvent): WireEvent => ({
    clientEventId: randomUUID(),
    seq: ++seq,
    type: e.type,
    occurredAt: new Date().toISOString(),
    ...(e.stopSeq !== undefined ? { stopSeq: e.stopSeq } : {}),
    ...(e.passenger !== undefined ? { passengerTripId: paxId(e.passenger) } : {}),
    ...(e.reasonCode ? { reasonCode: e.reasonCode } : {}),
    ...(e.etaMin !== undefined ? { etaMin: e.etaMin } : {}),
    clockOffsetMs: 0,
  });
  const post = async (events: WireEvent[]): Promise<EventResult[]> => {
    for (let i = 0; i < 8; i++) {
      const r = await api.call(drv, 'POST', `/driver/v1/trips/${tripId}/events`, { events });
      if (r.s === 429) {
        await sleep(Math.max(2, Number(r.b?.retryAfterSec ?? 5)) * 1000);
        continue;
      }
      if (r.s !== 200) throw new Error(`events: ${sc(r)} ${JSON.stringify(r.b).slice(0, 300)}`);
      const out = r.b.results as EventResult[];
      for (const x of out) (results.get(x.clientEventId) ?? results.set(x.clientEventId, []).get(x.clientEventId)!).push(x);
      for (const e of events) if (!sentIds.includes(e.clientEventId)) sentIds.push(e.clientEventId);
      return out;
    }
    throw new Error('events: rate-limited 8 times');
  };
  const final = (id: string) => results.get(id)?.filter((x) => x.outcome !== 'RETRY').at(0) ?? results.get(id)?.at(-1);

  // ACKNOWLEDGE (queueable) + START (online only)
  const ack = wire({ type: 'ACKNOWLEDGE' });
  const [ackRes] = await post([ack]);
  const startRes = await api.call(drv, 'POST', `/driver/v1/trips/${tripId}/start`, { clientEventId: randomUUID(), occurredAt: new Date().toISOString() });
  const stale = await api.call(drv, 'POST', `/driver/v1/trips/${tripId}/start`, { clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 10 * MIN).toISOString() });
  rec.check(C, 'driver ACKNOWLEDGE accepted; online start → STARTED; a replayed start 10 min old → 409 STALE_COMMAND (never executed from a queue)', ackRes?.outcome === 'ACCEPTED' && startRes.s === 200 && startRes.b.outcome === 'STARTED' && stale.s === 409 && stale.b?.code === 'STALE_COMMAND', { ack: ackRes, start: [sc(startRes), startRes.b?.outcome, startRes.b?.warnings], stale: sc(stale) });

  // ── Replay (R6) ──
  const replay = async (): Promise<void> => {
    const q = [...queue];
    queue.length = 0;
    const batches = replayBatches(q, s.replay);
    rec.check('R6', `${C}: offline queue of ${q.length} events replayed shuffled + duplicated in ${batches.length} batches (${batches.flat().length} sends)`, batches.flat().length > q.length, batches.map((b) => b.map((e) => `${e.seq}:${e.type}`)));
    let pending = batches;
    for (let round = 1; round <= 6 && pending.length; round++) {
      const retry: WireEvent[] = [];
      for (const b of pending) {
        const out = await post(b);
        for (const x of out) if (x.outcome === 'RETRY' && !retry.some((y) => y.clientEventId === x.clientEventId)) retry.push(b.find((e) => e.clientEventId === x.clientEventId)!);
        await sleep(300);
      }
      // A RETRY may have been settled by a later batch of the same round: resend only what is still unsettled.
      pending = replayBatches(retry.filter((e) => final(e.clientEventId)?.outcome === 'RETRY'), { ...s.replay, duplicateEvery: 1_000_000 });
    }
    const unsettled = q.filter((e) => final(e.clientEventId)?.outcome === 'RETRY');
    rec.check('R6', `${C}: every queued event settles (no RETRY left after the replay rounds)`, unsettled.length === 0, unsettled.map((e) => `${e.seq}:${e.type}`));
    const bad = q.filter((e) => !['ACCEPTED', 'DUPLICATE'].includes(final(e.clientEventId)?.outcome ?? ''));
    rec.check('R6', `${C}: no queued event is REJECTED / LATE (each one ACCEPTED, or DUPLICATE of a fact already recorded)`, bad.length === 0, bad.map((e) => ({ seq: e.seq, type: e.type, r: final(e.clientEventId) })));
    const dups = q.filter((e) => (results.get(e.clientEventId) ?? []).filter((x) => x.outcome !== 'RETRY').length > 1);
    const dupOk = dups.every((e) => results.get(e.clientEventId)!.filter((x) => x.outcome !== 'RETRY').slice(1).every((x) => x.outcome === 'DUPLICATE' && !!x.original));
    rec.check('R6', `${C}: a second send of the same clientEventId answers DUPLICATE with the original outcome (${dups.length} events sent twice)`, dups.length > 0 && dupOk, dups.map((e) => results.get(e.clientEventId)));
    // The whole queue once more, in order, as an app that lost its confirmations would.
    const again = await post(q.slice(0, 50));
    rec.check('R6', `${C}: replaying the whole queue again changes nothing (all DUPLICATE)`, again.every((x) => x.outcome === 'DUPLICATE'), again.map((x) => `${x.seq}:${x.outcome}:${x.code ?? ''}`));
  };

  // ── Drive ──
  const gpsBoarded: string[] = [];
  const expectRejected = new Set<string>();
  let earlyNoShow: EventResult | undefined;
  let vehicleSeen: unknown = null;
  const drive = await driveTrip({
    prisma,
    redis,
    tripId,
    log: (l) => console.log(`    [${C}] sim ${l}`),
    onStop: async (stopSeq, snap) => {
      // GPS alone never sets an outcome: a passenger whose pickup is here or later is still PENDING.
      for (let i = 0; i < n; i++) if (i >= stopSeq && stopSeq < n && snap.passengers.find((p) => p.id === paxId(i))!.status !== 'PENDING') gpsBoarded.push(`stop ${stopSeq}: passenger ${i} ${snap.passengers.find((p) => p.id === paxId(i))!.status}`);
      if (stopSeq === 0) {
        const v = await api.call(paxTok[0], 'GET', `/me/transport/trips/${tripId}/vehicle`);
        vehicleSeen = { s: v.s, visible: v.b?.visible };
      }
      const offline = offlineAt(s, stopSeq);
      if (!offline && queue.length) await replay();
      for (const e of plannedEventsAt(s, stopSeq)) {
        if (e.afterNoShowWait && !offline) {
          // The driver taps NO_SHOW too early first (refused), then after the P5 wait from the GPS arrival.
          const early = wire(e);
          [earlyNoShow] = await post([early]);
          expectRejected.add(early.clientEventId);
          const arrived = (await snapshot(prisma, tripId, stopSeq)).stops.find((x) => x.seq === stopSeq)?.actualArrival;
          const waitUntil = (arrived ? Date.parse(arrived) : Date.now()) + 5 * MIN + 5_000;
          console.log(`    [${C}] waiting ${Math.round((waitUntil - Date.now()) / 1000)} s for the no-show wait`);
          await sleep(Math.max(0, waitUntil - Date.now()));
        }
        const w = wire(e);
        if (offline) queue.push(w);
        else await post([w]);
      }
    },
  });
  const last = drive.snapshots.at(-1)!;

  // ── Checks: online event outcomes ──
  rec.check(C, 'GPS never sets an outcome: at every stop, passengers not yet handled by the driver were PENDING', gpsBoarded.length === 0, gpsBoarded);
  rec.check(C, 'passenger sees the vehicle while the trip runs', (vehicleSeen as { visible?: boolean } | null)?.visible === true, vehicleSeen);
  if (earlyNoShow) rec.check(C, 'an early NO_SHOW (before the 5 min wait) is REJECTED WAIT_NOT_ELAPSED', earlyNoShow.outcome === 'REJECTED' && earlyNoShow.code === 'WAIT_NOT_ELAPSED', earlyNoShow);
  const officeIds = new Set<string>();
  const evRows = await prisma.transportTripEvent.findMany({ where: { tripId, clientEventId: { in: sentIds } }, select: { clientEventId: true, kind: true, source: true, outcome: true, stopSeq: true } });
  for (const r of evRows) if (r.stopSeq === n || r.kind === 'COMPLETED') officeIds.add(r.clientEventId!);
  const pickupBad = sentIds.filter((id) => !expectRejected.has(id) && !officeIds.has(id)).map((id) => ({ id, r: final(id) })).filter((x) => !['ACCEPTED', 'DUPLICATE'].includes(x.r?.outcome ?? ''));
  rec.check(C, 'every pickup-stop driver event is ACCEPTED (or DUPLICATE of a fact GPS / an earlier send recorded)', pickupBad.length === 0, pickupBad);
  const perId = new Map<string, number>();
  for (const r of evRows) perId.set(r.clientEventId!, (perId.get(r.clientEventId!) ?? 0) + 1);
  rec.check(C, `each clientEventId is stored once (${perId.size} stored for ${sentIds.length} distinct events sent, ${[...results.values()].flat().length} sends)`, [...perId.values()].every((c) => c === 1) && perId.size === sentIds.filter((id) => final(id)?.outcome !== 'RETRY').length, Object.fromEntries(perId));
  rec.check(C, 'driver events are stored with source DRIVER_APP', evRows.length > 0 && evRows.every((r) => r.source === 'DRIVER_APP'), [...new Set(evRows.map((r) => r.source))]);

  // ── Final state ──
  const pickupStatus = s.expect.passengers.map((x) => (x === 'DROPPED' ? 'BOARDED' : x));
  const nowPax = Array.from({ length: n }, (_, i) => last.passengers.find((p) => p.id === paxId(i))!);
  const settledAfter = await snapshot(prisma, tripId, n + 1);
  const finalPax = Array.from({ length: n }, (_, i) => settledAfter.passengers.find((p) => p.id === paxId(i))!);
  rec.check(C, `pickup outcomes recorded by the driver app: ${pickupStatus.join(' / ')} (DRIVER_APP)`, finalPax.every((p, i) => (pickupStatus[i] === 'BOARDED' ? ['BOARDED', 'DROPPED'].includes(p.status) : p.status === pickupStatus[i]) && p.outcomeSource === 'DRIVER_APP'), finalPax);
  rec.check(C, 'the trip is COMPLETED (GPS auto-complete at the office or the driver COMPLETE_TRIP)', settledAfter.status === 'COMPLETED', { status: settledAfter.status, closedBy: settledAfter.closedBy });
  const officeEv = [...officeIds].map((id) => ({ type: evRows.find((r) => r.clientEventId === id)?.kind, r: final(id) }));
  const drops = officeEv.filter((x) => x.type === 'DROPPED');
  rec.tagged(C, 'fixed D1', `office taps are applied after the GPS auto-complete: DROPPED × ${s.board.flatMap((b) => b.passengers).length} ACCEPTED with afterClose (settle grace) and final seats ${s.expect.passengers.join(' / ')}; the trip stays COMPLETED`, () => finalPax.every((p, i) => p.status === s.expect.passengers[i]) && drops.length === s.board.flatMap((b) => b.passengers).length && drops.every((x) => x.r?.outcome === 'ACCEPTED' && (x.r as { afterClose?: boolean }).afterClose === (settledAfter.closedBy === 'AUTO')) && settledAfter.status === 'COMPLETED', { officeEv, finalPax: finalPax.map((p) => p.status), closedBy: settledAfter.closedBy });
  rec.check(C, 'D1 evidence (observation, always passes): outcome of the driver taps at the office', true, { officeEv, seatsBeforeOfficeTaps: nowPax.map((p) => p.status), closedBy: settledAfter.closedBy });
  outcome.key = convergenceKey({ status: settledAfter.status, stops: settledAfter.stops, passengers: finalPax.map((p, i) => ({ index: i, status: p.status })) });
  if (ctx.baseline?.key) rec.check('R6', `${C}: the final state converges to ${ctx.baseline.name}'s (same trip, stop and seat states)`, outcome.key === ctx.baseline.key, { mine: outcome.key, baseline: ctx.baseline.key });

  // ── Sync converges (a reinstalled app gets every stored outcome) ──
  const sync = await api.call(drv, 'GET', '/driver/v1/sync');
  const synced = new Map((sync.b?.events ?? []).filter((e: { tripId: string }) => e.tripId === tripId).map((e: { clientEventId: string; outcome: string }) => [e.clientEventId, e.outcome]));
  const missing = sentIds.filter((id) => final(id)?.outcome !== 'RETRY' && synced.get(id) !== (results.get(id)!.find((x) => x.outcome !== 'RETRY')?.outcome));
  rec.check(C, 'GET /driver/v1/sync returns every stored event with its original outcome', sync.s === 200 && missing.length === 0, { s: sc(sync), missing: missing.length, synced: synced.size });

  // ── Passenger bots ──
  const views = await Promise.all(paxTok.map((t) => api.call(t, 'GET', `/me/transport/trips/${tripId}`)));
  rec.check(C, 'passenger bots: each sees its own outcome (myStatus) and the co-riders only as a count', views.every((v, i) => v.s === 200 && v.b.myStatus === finalPax[i].status && v.b.coRiders === n - 1 && !JSON.stringify(v.b).includes(paxRows[(i + 1) % n].displayName)), views.map((v) => [v.s, v.b?.myStatus, v.b?.coRiders]));

  // ── I2 on real run data: the finished trip no longer blocks erasure of passenger 0 ──
  const i2 = await assertNoOpenBookings(prisma, ist.id, paxRows[0].id).then(() => 'allowed', (e: { response?: { code?: string } }) => e.response?.code ?? 'error');
  rec.check(C, 'I2: after the trip, passenger 1\'s ASSIGNED booking no longer blocks erasure (assertNoOpenBookings allowed inside the window)', i2 === 'allowed', i2);
  return outcome;
}

/** Notification / push checks of one scenario after the relay and notifier had time to run. */
export async function notificationChecks(s: EtmsScenario, slot: ScenarioSlot, tripId: string, ctx: { api: Api; acc: HttpAccounts; prisma: PrismaClient; rec: Recorder; driverTok: string; pushLog: string }): Promise<void> {
  const { api, acc, prisma, rec } = ctx;
  const C = `NOTIFY`;
  const n = s.pickupsM.length;
  const paxUsers = acc.users.passengers.slice(slot.paxFrom, slot.paxFrom + n);
  const paxRows = acc.ist.passengers.slice(slot.paxFrom, slot.paxFrom + n);
  const driverUser = (await prisma.driver.findUniqueOrThrow({ where: { id: acc.ist.drivers[slot.driver].id }, select: { userId: true } })).userId!;
  const deadline = Date.now() + 75_000;
  let rows: { id: string; userId: string; kind: string; audience: string; pushQueued: boolean }[] = [];
  let logs: { refId: string | null; status: string; provider: string | null; channel: string }[] = [];
  const want = () => rows.some((r) => r.userId === driverUser && r.kind === 'TRIP_ASSIGNED') && rows.some((r) => r.kind === 'TRIP_STARTING_SOON') && rows.every((r) => !r.pushQueued || logs.some((l) => l.refId === r.id && l.status !== 'QUEUED'));
  while (Date.now() < deadline) {
    rows = await prisma.transportNotification.findMany({ where: { tripId }, select: { id: true, userId: true, kind: true, audience: true, pushQueued: true } });
    logs = rows.length ? await prisma.notificationLog.findMany({ where: { refType: 'TRANSPORT_NOTIFICATION', refId: { in: rows.map((r) => r.id) } }, select: { refId: true, status: true, provider: true, channel: true } }) : [];
    if (want()) break;
    await sleep(3_000);
  }
  const kinds = rows.map((r) => `${r.audience}:${r.kind}`);
  rec.check(C, `${s.name}: driver gets TRIP_ASSIGNED; passengers get TRIP_STARTING_SOON (relay from committed rows)`, rows.some((r) => r.userId === driverUser && r.kind === 'TRIP_ASSIGNED') && rows.filter((r) => r.kind === 'TRIP_STARTING_SOON').length === n, kinds);
  if (s.reportDelay) {
    const delayed = rows.filter((r) => r.kind === 'TRIP_DELAYED').map((r) => paxUsers.findIndex((u) => u.id === r.userId));
    rec.check(C, `${s.name}: the driver's REPORT_DELAY notifies only passengers still waiting for pickup (TRIP_DELAYED → passenger ${s.reportDelay.stop + 1})`, JSON.stringify(delayed) === JSON.stringify([s.reportDelay.stop]), { delayed, kinds });
  }
  const perKey = new Map<string, number>();
  for (const r of rows) perKey.set(`${r.userId}:${r.kind}`, (perKey.get(`${r.userId}:${r.kind}`) ?? 0) + 1);
  rec.check(C, `${s.name}: no duplicate notification (one per recipient and kind for the trip)`, [...perKey.values()].every((c) => c === 1), Object.fromEntries(perKey));
  const pushRows = rows.filter((r) => r.pushQueued);
  rec.check(C, `${s.name}: every notification of a signed-in app queued a PUSH and the notifier sent it through the fake provider (SENT, provider fake)`, pushRows.length === rows.length && rows.length > 0 && pushRows.every((r) => logs.some((l) => l.refId === r.id && l.channel === 'PUSH' && l.status === 'SENT' && l.provider === 'fake')), { rows: rows.length, pushQueued: pushRows.length, logs: logs.map((l) => `${l.channel}:${l.status}:${l.provider}`) });
  // The push payload itself (fake provider log): exactly { kind, tripId, notificationId }, generic text, channel trip.
  const lines = existsSync(ctx.pushLog) ? readFileSync(ctx.pushLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { data: Record<string, unknown>; title: string; body: string; channelId: string }) : [];
  const mine = lines.filter((l) => l.data?.tripId === tripId);
  const names = [...paxRows.map((p) => p.displayName), acc.ist.drivers[slot.driver].name, acc.ist.vehicles[slot.vehicle].name];
  const leak = mine.filter((l) => names.some((nm) => JSON.stringify(l).includes(nm)));
  rec.check(C, `${s.name}: push payloads carry only { kind, tripId, notificationId }, channel "trip", no names / plates (${mine.length} pushes)`, mine.length === pushRows.length && mine.every((l) => JSON.stringify(Object.keys(l.data).sort()) === JSON.stringify(['kind', 'notificationId', 'tripId']) && l.channelId === 'trip') && leak.length === 0, { pushes: mine.length, keys: [...new Set(mine.map((l) => Object.keys(l.data).sort().join(',')))], leak: leak.length });
  // Apps read the inbox through the API.
  const dIn = await api.call(ctx.driverTok, 'GET', '/driver/v1/notifications');
  const pTok = await api.login(paxUsers[0].email, HTTP_PASSWORD);
  const pIn = await api.call(pTok, 'GET', '/me/transport/notifications');
  rec.check(C, `${s.name}: driver and passenger inboxes list them (GET /driver/v1/notifications, /me/transport/notifications)`, dIn.s === 200 && (dIn.b as { tripId: string; kind: string }[]).some((x) => x.tripId === tripId && x.kind === 'TRIP_ASSIGNED') && pIn.s === 200 && (pIn.b as { tripId: string }[]).some((x) => x.tripId === tripId), { d: sc(dIn), p: sc(pIn) });
  const sms = await prisma.notificationLog.count({ where: { companyId: acc.ist.id, channel: 'SMS' } });
  rec.check(C, `${s.name}: no SMS is produced by the E5 driver / passenger flow (SMS_PROVIDER=console; SOS is WP 5.4, not on main)`, sms === 0, { sms });
}
