/**
 * D1 / D1b on PostgreSQL (E5 WP 5.5, Lead decision 2026-11-12): the v1.8 tracker auto-completes an ETMS trip at the last
 * stop; for DRIVER_LIMITS.settleGraceHours afterwards the driver API still takes the driver's passenger settlements
 * (DROPPED, NO_SHOW, a BOARDED that happened while the trip ran), marked `afterClose` and audited, without reopening the
 * trip; later they get a definitive LATE TRIP_CLOSED. Real DriverApiService on a scratch `*_test` database (synthetic
 * tenants tagged `e5settle-…`, purged in afterAll). Skips without ETMS_DB_TEST_URL, like every DB test.
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { DriverTripEventInput, DriverTripEventResult } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { planPurge, rootCondition, stepSql, type Catalog, type FkEdge } from '../purge/purge-plan';
import { PURGE_EVIDENCE_WRITE } from '../purge/purge.service';
import { dbDescribe } from '../test/scratch-db';
import { BookingGeneratorService } from './dispatch/booking-generator.service';
import { DispatchService } from './dispatch/dispatch.service';
import { TripLiveService } from './dispatch/trip-live';
import { TripsService } from './dispatch/trips.service';
import { DriverApiService } from './driver/driver-api.service';
import { TransportNotificationsService } from './notifications/transport-notifications.service';

type Tx = Prisma.TransactionClient;
const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `e5settle-${Date.now()}`;
const MIN = 60_000;
const H = 60 * MIN;

async function loadCatalog(tx: Pick<Tx, '$queryRawUnsafe'>): Promise<Catalog> {
  const fks = await tx.$queryRawUnsafe<FkEdge[]>(`
    SELECT c.relname AS child, a.attname AS col, p.relname AS parent, pa.attname AS "refCol", con.confdeltype::text AS del
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class p ON p.oid = con.confrelid
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND n.nspname = 'public'`);
  const cols = await tx.$queryRawUnsafe<{ table: string; column: string }[]>(`
    SELECT c.table_name AS "table", c.column_name AS "column" FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'`);
  const columns = new Map<string, Set<string>>();
  for (const { table, column } of cols) (columns.get(table) ?? columns.set(table, new Set()).get(table)!).add(column);
  return { fks, columns };
}

d(`D1 / D1b driver settle grace on ${dbName}`, () => {
  jest.setTimeout(240_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const companies: string[] = [];
  let partnerId = '';
  let ownPartner = false;
  const redis = { client: { get: async () => null, set: async () => 'OK', publish: async () => 1, eval: async () => 1, xadd: async () => '1-0', incr: async () => 1, pexpire: async () => 1 } };
  const audit = new AuditService(prisma as never);
  const live = new TripLiveService(prisma as never, redis as never, new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never));
  const svc = new DriverApiService(prisma as never, audit, redis as never, live, new TransportNotificationsService(prisma as never, redis as never));
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const generator = new BookingGeneratorService(prisma as never, redis as never, audit);
  const trips = new TripsService(prisma as never, audit, plannedTrips, new DispatchService(prisma as never, audit, {} as never, live, redis as never), live);

  beforeAll(async () => {
    const [p] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
    if (p) partnerId = p.id;
    else {
      ownPartner = true;
      partnerId = (await prisma.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), ${`${TAG} partner`}, ${`${TAG}-partner`}, now()) RETURNING id`)[0].id;
    }
  });

  afterAll(async () => {
    const cat = await loadCatalog(prisma);
    for (const c of companies)
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(PURGE_EVIDENCE_WRITE);
          for (const s of planPurge(cat, 'Company', rootCondition(c))) await tx.$executeRawUnsafe(stepSql(s));
        },
        { timeout: 300_000, maxWait: 10_000 },
      );
    if (ownPartner) await prisma.$executeRawUnsafe(`DELETE FROM "Partner" WHERE id = '${partnerId}'`);
    const left = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "Company" WHERE name LIKE '${TAG} %'`);
    await prisma.$disconnect();
    expect(Number(left[0].n)).toBe(0);
  });

  /**
   * A company whose ETMS trip (pickup → office) the GPS auto-completed `closedAgoMs` ago. Seat statuses as given
   * (BOARDED seats were boarded by the driver app 40 min ago).
   */
  async function world(key: string, closedAgoMs: number, seats: ('PENDING' | 'BOARDED')[]) {
    const id = () => randomUUID();
    const now = Date.now();
    const w = { company: id(), office: id(), user: id(), driver: id(), object: id(), pt: id(), s0: id(), s1: id(), tt: id(), seats: [] as string[] };
    companies.push(w.company);
    const sql = (s: string) => prisma.$executeRawUnsafe(s);
    const ts = (ms: number) => `'${new Date(ms).toISOString()}'`;
    const start = now - closedAgoMs - 50 * MIN;
    const end = now - closedAgoMs;
    await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${w.company}', '${partnerId}', '${TAG} ${key}', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.office}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, email, "updatedAt") VALUES ('${w.user}', '${w.company}', '${TAG} ${key} driver', '${TAG}.${key}@example.test', now())`);
    await sql(`INSERT INTO "Driver" (id, "companyId", name, "userId", "isActive", "updatedAt") VALUES ('${w.driver}', '${w.company}', 'Driver ${key}', '${w.user}', true, now())`);
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${w.object}', '${w.company}', 'Van ${key}', now())`);
    await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${w.object}', '${w.company}', 4, now())`);
    await sql(`INSERT INTO "PlannedTrip" (id, "companyId", "routeId", origin, "objectId", "driverId", "routeName", "corridorM", "plannedStart", "plannedEnd", status, "actualStart", "actualEnd", "closedBy", "updatedAt")
               VALUES ('${w.pt}', '${w.company}', NULL, 'ETMS', '${w.object}', '${w.driver}', 'Login ${key}', 200, ${ts(start)}, ${ts(end)}, 'COMPLETED', ${ts(start)}, ${ts(end)}, 'AUTO', now())`);
    await sql(`INSERT INTO "PlannedTripStop" (id, "tripId", seq, name, lat, lng, "radiusM", "plannedArrival", "plannedDeparture", status, "actualArrival", "actualDeparture")
               VALUES ('${w.s0}', '${w.pt}', 0, 'Stop 1', 13.06, 80.24, 100, ${ts(start)}, ${ts(start)}, 'DEPARTED', ${ts(start + MIN)}, ${ts(start + 3 * MIN)}),
                      ('${w.s1}', '${w.pt}', 1, 'HQ', 13.05, 80.25, 100, ${ts(end)}, ${ts(end)}, 'ARRIVED', ${ts(end)}, NULL)`);
    await sql(`INSERT INTO "TransportTrip" (id, "plannedTripId", "providerCompanyId", "customerCompanyId", "serviceDate", direction, "sitePoiId", "seatCapacity", "occupiedSeats", "publishedAt", "acknowledgedAt", "updatedAt")
               VALUES ('${w.tt}', '${w.pt}', '${w.company}', '${w.company}', ${ts(start)}::date, 'IN', '${w.office}', 4, ${seats.length}, ${ts(start - H)}, ${ts(start - H)}, now())`);
    for (const [i, status] of seats.entries()) {
      const profile = id();
      const booking = id();
      const seat = id();
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "updatedAt") VALUES ('${profile}', '${w.company}', 'S${i}', 'Synthetic ${key} ${i}', now())`);
      await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "providerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "dropPoiId", "windowStart", "windowEnd", status, "updatedAt")
                 VALUES ('${booking}', '${w.company}', '${w.company}', '${profile}', 'ADHOC', ${ts(start)}::date, 'IN', 'Asia/Kolkata', 13.06, 80.24, 13.05, 80.25, '${w.office}', ${ts(start - 30 * MIN)}, ${ts(now + 2 * H)}, 'ASSIGNED', now())`);
      const boarded = status === 'BOARDED' ? `'DRIVER_APP', ${ts(start + 2 * MIN)}` : 'NULL, NULL';
      await sql(`INSERT INTO "TransportTripPassenger" (id, "tripId", "bookingId", "customerCompanyId", "providerCompanyId", "pickupStopId", "dropStopId", "pickupSeq", "dropSeq", status, "outcomeSource", "boardedAt", "updatedAt")
                 VALUES ('${seat}', '${w.tt}', '${booking}', '${w.company}', '${w.company}', '${w.s0}', '${w.s1}', 0, 1, '${status}', ${boarded}, now())`);
      w.seats.push(seat);
    }
    const ctx: AuthContext = { userId: w.user, homeCompanyId: w.company, companyId: w.company, isSuperAdmin: false, permissions: { etms_driver: ['view', 'edit'] }, dataScope: 'ASSIGNED', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null } as AuthContext;
    return { ...w, ctx, start, end };
  }

  const event = (seq: number, type: DriverTripEventInput['type'], at: number, extra: Partial<DriverTripEventInput> = {}): DriverTripEventInput => ({ clientEventId: randomUUID(), seq, type, occurredAt: new Date(at).toISOString(), clockOffsetMs: 0, ...extra });
  const seatStatus = async (ids: string[]) => (await prisma.transportTripPassenger.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((s) => s.status);

  it('[D1] inside the grace: DROPPED after GPS auto-complete is ACCEPTED (afterClose, audited); the trip stays COMPLETED; a new BOARDED is LATE', async () => {
    const w = await world('in', 10 * MIN, ['BOARDED', 'PENDING']);
    const drop = event(1, 'DROPPED', w.end + 30_000, { passengerTripId: w.seats[0], stopSeq: 1 });
    const board = event(2, 'BOARDED', Date.now(), { passengerTripId: w.seats[1] });
    const res = await svc.events(w.ctx, w.tt, { events: [drop, board] } as never);
    const by = (e: DriverTripEventInput) => res.results.find((r: DriverTripEventResult) => r.clientEventId === e.clientEventId)!;
    expect(by(drop)).toMatchObject({ outcome: 'ACCEPTED', afterClose: true });
    expect(by(board)).toMatchObject({ outcome: 'LATE', code: 'TRIP_CLOSED' });
    expect(await seatStatus(w.seats)).toEqual(['DROPPED', 'PENDING']);
    const pt = await prisma.plannedTrip.findUniqueOrThrow({ where: { id: w.pt }, select: { status: true, closedBy: true } });
    expect(pt).toEqual({ status: 'COMPLETED', closedBy: 'AUTO' });
    const row = await prisma.transportTripEvent.findFirstOrThrow({ where: { tripId: w.tt, clientEventId: drop.clientEventId } });
    expect(row).toMatchObject({ outcome: 'ACCEPTED', source: 'DRIVER_APP', kind: 'DROPPED' });
    expect(row.data).toMatchObject({ afterClose: true });
    const auditRow = await prisma.auditLog.findFirst({ where: { companyId: w.company, entityId: w.tt }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(auditRow?.changes)).toContain('"afterClose":["1:DROPPED"]');
  });

  it('[D1b] outside the grace: the same settlement gets a definitive LATE TRIP_CLOSED (stored; a resend is DUPLICATE of LATE); the seat is unchanged', async () => {
    const w = await world('out', 7 * H, ['BOARDED']);
    const drop = event(1, 'DROPPED', w.end + 30_000, { passengerTripId: w.seats[0], stopSeq: 1 });
    const first = await svc.events(w.ctx, w.tt, { events: [drop] } as never);
    expect(first.results[0]).toMatchObject({ outcome: 'LATE', code: 'TRIP_CLOSED' });
    expect(first.results[0].receivedAt).not.toBeNull();
    const again = await svc.events(w.ctx, w.tt, { events: [drop] } as never);
    expect(again.results[0]).toMatchObject({ outcome: 'DUPLICATE', original: 'LATE' });
    expect(await seatStatus(w.seats)).toEqual(['BOARDED']);
    expect(await prisma.transportTripEvent.count({ where: { tripId: w.tt, clientEventId: drop.clientEventId } })).toBe(1);
  });

  it('[D1b] an offline driver reconnecting after the auto-complete: shuffled + duplicated queue, 0 lost, each event stored once', async () => {
    const w = await world('offline', 20 * MIN, ['PENDING', 'PENDING']);
    // Taps made offline while the trip ran: board both at pickup 1, drop both at the office (just as GPS closed the trip).
    const q = [
      event(1, 'BOARDED', w.start + 2 * MIN, { passengerTripId: w.seats[0] }),
      event(2, 'BOARDED', w.start + 2 * MIN + 5_000, { passengerTripId: w.seats[1] }),
      event(3, 'DROPPED', w.end + 20_000, { passengerTripId: w.seats[0], stopSeq: 1 }),
      event(4, 'DROPPED', w.end + 25_000, { passengerTripId: w.seats[1], stopSeq: 1 }),
    ];
    const settled = new Map<string, DriverTripEventResult>();
    const send = async (batch: DriverTripEventInput[]) => {
      for (const r of (await svc.events(w.ctx, w.tt, { events: batch } as never)).results) if (r.outcome !== 'RETRY' && !settled.has(r.clientEventId)) settled.set(r.clientEventId, r);
    };
    await send([q[3], q[0]]); // drop #2 before its boarding: RETRY
    await send([q[2], q[1], q[0]]); // the boarding of #1 again (duplicate)
    await send([q[3]]); // the retried drop
    await send(q); // the whole queue once more: all DUPLICATE
    expect(q.map((e) => settled.get(e.clientEventId)?.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    expect(await seatStatus(w.seats)).toEqual(['DROPPED', 'DROPPED']);
    const rows = await prisma.transportTripEvent.groupBy({ by: ['clientEventId'], where: { tripId: w.tt, clientEventId: { in: q.map((e) => e.clientEventId) } }, _count: true });
    expect(rows.map((r) => r._count).sort()).toEqual([1, 1, 1, 1]);
    expect((await prisma.plannedTrip.findUniqueOrThrow({ where: { id: w.pt } })).status).toBe('COMPLETED');
  });

  // ───── v1.15.1 trip settle (I2 / E5 L4, demo B4): after the grace the sweep finalises what the driver never settled ─────
  const bookingStatus = async (seatIds: string[]) => {
    const rows = await prisma.transportTripPassenger.findMany({ where: { id: { in: seatIds } }, select: { id: true, booking: { select: { status: true, version: true } } } });
    return seatIds.map((id) => rows.find((r) => r.id === id)!.booking);
  };

  it('[I2] after the grace: a BOARDED seat is marked auto-settled (status kept: no invented outcome) and its booking CONFIRMED; a PENDING seat is flagged for review; idempotent, audited, shown on the trip detail', async () => {
    const w = await world('settle', 7 * H, ['BOARDED', 'PENDING', 'BOARDED']);
    // The driver dropped the third passenger in time: a recorded outcome; only its booking is finalised.
    await prisma.transportTripPassenger.update({ where: { id: w.seats[2] }, data: { status: 'DROPPED', droppedAt: new Date(w.end), outcomeSource: 'DRIVER_APP', outcomeAt: new Date(w.end) } });
    const [first] = await generator.settle(Date.now(), { where: { id: w.tt } });
    expect(first).toMatchObject({ tripId: w.tt, boardedSettled: [w.seats[0]], pendingFlagged: [w.seats[1]], closedBy: 'AUTO' });
    expect(first.bookingsConfirmed).toHaveLength(2);
    expect(await seatStatus(w.seats)).toEqual(['BOARDED', 'PENDING', 'DROPPED']);
    expect((await bookingStatus(w.seats)).map((b) => b.status)).toEqual(['CONFIRMED', 'ASSIGNED', 'CONFIRMED']);
    const evs = await prisma.transportTripEvent.findMany({ where: { tripId: w.tt, kind: 'PASSENGER_AUTO_SETTLED' }, orderBy: { reasonCode: 'asc' } });
    expect(evs).toHaveLength(2);
    expect(evs.map((e) => [e.passengerTripId, e.reasonCode, e.actorType, e.source, e.outcome, e.lat])).toEqual([
      [w.seats[0], 'DROP_NOT_RECORDED', 'SYSTEM', 'SYSTEM', 'ACCEPTED', null],
      [w.seats[1], 'NO_OUTCOME', 'SYSTEM', 'SYSTEM', 'ACCEPTED', null],
    ]);
    expect(evs[1].data).toMatchObject({ autoSettled: true, statusAtSettle: 'PENDING', needsReview: true });
    const auditRow = await prisma.auditLog.findFirst({ where: { companyId: w.company, entityId: w.tt }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(auditRow)).toContain('autoSettle');
    // Idempotent: a second sweep changes nothing.
    expect(await generator.settle(Date.now(), { where: { id: w.tt } })).toEqual([]);
    expect(await prisma.transportTripEvent.count({ where: { tripId: w.tt, kind: 'PASSENGER_AUTO_SETTLED' } })).toBe(2);
    expect((await bookingStatus(w.seats)).map((b) => b.version)).toEqual([2, 1, 2]);
    // Dispatcher trip detail: the flag, and the outcome can still be recorded on the completed trip.
    const dispatcher = { ...w.ctx, permissions: { etms_dispatch: ['view', 'edit'] }, dataScope: 'COMPANY' } as AuthContext;
    const detail = await trips.get(dispatcher, w.tt);
    const pax = (id: string) => detail.passengers.find((p) => p.id === id)!;
    expect([pax(w.seats[0]).autoSettled, pax(w.seats[1]).autoSettled, pax(w.seats[2]).autoSettled]).toEqual([true, true, false]);
    expect(pax(w.seats[0]).allowedOutcomes).toContain('DROPPED');
  });

  it('[I2] inside the grace the sweep leaves the trip alone; batches are limited', async () => {
    const inside = await world('settle-in', 2 * H, ['BOARDED']);
    expect(await generator.settle(Date.now(), { where: { id: inside.tt } })).toEqual([]);
    expect((await bookingStatus(inside.seats))[0].status).toBe('ASSIGNED');
    const a = await world('settle-a', 8 * H, ['BOARDED']);
    const b = await world('settle-b', 9 * H, ['BOARDED']);
    await prisma.transportTripPassenger.update({ where: { id: b.seats[0] }, data: { status: 'DROPPED', droppedAt: new Date(b.end), outcomeAt: new Date(b.end) } });
    const both = { id: { in: [a.tt, b.tt, inside.tt] } };
    expect(await generator.settle(Date.now(), { batch: 1, where: both })).toHaveLength(1);
    expect(await generator.settle(Date.now(), { batch: 1, where: both })).toHaveLength(1);
    expect(await generator.settle(Date.now(), { batch: 1, where: both })).toEqual([]);
    expect((await bookingStatus([...a.seats, ...b.seats])).map((x) => x.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });
});
