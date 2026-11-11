/**
 * ETMS E3 migrations etms_bookings_trips + planned_trip_origin on a real PostgreSQL with all migrations applied
 * (doc 15 §9.5 "Raw-SQL object inventory", "Constraint behaviour", "Concurrency", §9.6 tenant purge; 12 §5 E3 exit
 * criteria). Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_e3be_test \
 *     npx jest --testRegex 'etms-bookings-trips\.db-test\.ts$' --runInBand
 * Allowed databases: veetrax_assess or any *_test database; never veetracer. The inventory / constraint / purge cases
 * run inside ONE transaction that is always rolled back. The service cases (publish transaction, concurrency,
 * generator) commit in their own transactions on scratch companies, which the suite purges again (purge planner) in
 * afterAll — no row is left behind.
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { DispatchChangeOp } from '@veetracer/shared';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { planPurge, rootCondition, stepSql, type Catalog, type FkEdge } from '../purge/purge-plan';
import { BookingGeneratorService } from './dispatch/booking-generator.service';
import { BookingsService } from './dispatch/bookings.service';
import { DispatchService } from './dispatch/dispatch.service';
import { SchedulesService } from './dispatch/schedules.service';
import { TripLiveService } from './dispatch/trip-live';
import { TripsService } from './dispatch/trips.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const dbName = /\/([a-z0-9_]+)(\?|$)/i.exec(URL_)?.[1] ?? '';
const allowed = dbName === 'veetrax_assess' || /_test$/i.test(dbName);
const d = URL_ && allowed ? describe : describe.skip;

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;
const H = 3_600_000;

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

async function scratchPartner(db: Pick<Tx, '$queryRaw'>): Promise<string> {
  const [p] = await db.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-e3-db-test partner', 'etms-e3-db-test-' || gen_random_uuid(), now()) RETURNING id`;
  return p.id;
}

async function inRollback(prisma: PrismaClient, fn: (tx: Tx, partnerId: string) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(
      async (tx) => {
        const [partner] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
        await fn(tx, partner?.id ?? (await scratchPartner(tx)));
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

type Exec = Pick<Tx, '$executeRawUnsafe'>;
const q = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`);

/** A company with an office, a passenger (consent granted), a vehicle (4 seats), a driver, shift, schedule, two bookings, a published ETMS trip with one passenger, an event and a change set. */
async function seedGraph(tx: Exec, partnerId: string, tag: string) {
  const id = () => randomUUID();
  const g = { company: id(), office: id(), profile: id(), object: id(), driver: id(), shift: id(), schedule: id(), booking: id(), seated: id(), plannedTrip: id(), stop0: id(), stop1: id(), trip: id(), passenger: id(), changeSet: id() };
  const sql = (s: string) => tx.$executeRawUnsafe(s);
  await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${g.company}', '${partnerId}', 'etms-e3-db-test ${tag}', '{"features":["etms"]}', now())`);
  await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${g.office}', '${g.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
  await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "homeLat", "homeLng", "updatedAt") VALUES ('${g.profile}', '${g.company}', 'E1', 'Asha ${tag}', 13.06, 80.24, now())`);
  await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${g.company}', '${g.profile}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
  await sql(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${g.object}', '${g.company}', 'Van ${tag}', now())`);
  await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${g.object}', '${g.company}', 4, now())`);
  await sql(`INSERT INTO "Driver" (id, "companyId", name, "updatedAt") VALUES ('${g.driver}', '${g.company}', 'Driver ${tag}', now())`);
  await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${g.shift}', '${g.company}', '${g.office}', 'Day', 540, 1080, false, '{1,2,3,4,5}', 'Asia/Kolkata', now())`);
  await sql(`INSERT INTO "TransportSchedule" (id, "companyId", "profileId", "shiftId", direction, days, "pickupMode", "validFrom", "updatedAt") VALUES ('${g.schedule}', '${g.company}', '${g.profile}', '${g.shift}', 'IN', '{1,2,3}', 'HOME', '2026-12-01', now())`);
  await sql(`INSERT INTO "TransportScheduleException" (id, "companyId", "scheduleId", date, kind) VALUES (gen_random_uuid(), '${g.company}', '${g.schedule}', '2026-12-02', 'SKIP')`);
  const booking = (bid: string, dir: string, status: string, provider: string | null) =>
    sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "providerCompanyId", "profileId", "scheduleId", "shiftId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
         VALUES ('${bid}', '${g.company}', ${q(provider)}, '${g.profile}', '${g.schedule}', '${g.shift}', 'SCHEDULE', '2026-12-01', '${dir}', 'Asia/Kolkata', 13.06, 80.24, 13.05, 80.25, '2026-12-01T02:00:00Z', '2026-12-01T03:30:00Z', '${status}', now())`);
  await booking(g.seated, 'IN', 'ASSIGNED', g.company);
  await booking(g.booking, 'OUT', 'PENDING_ASSIGNMENT', null);
  await sql(`INSERT INTO "PlannedTrip" (id, "companyId", "routeId", origin, "objectId", "driverId", "routeName", "corridorM", "plannedStart", "plannedEnd", "updatedAt") VALUES ('${g.plannedTrip}', '${g.company}', NULL, 'ETMS', '${g.object}', '${g.driver}', 'Login ${tag}', 200, '2026-12-01T02:30:00Z', '2026-12-01T03:30:00Z', now())`);
  await sql(`INSERT INTO "PlannedTripStop" (id, "tripId", seq, name, lat, lng, "radiusM", "plannedArrival", "plannedDeparture") VALUES ('${g.stop0}', '${g.plannedTrip}', 0, 'Home', 13.06, 80.24, 100, '2026-12-01T02:30:00Z', '2026-12-01T02:30:00Z'), ('${g.stop1}', '${g.plannedTrip}', 1, 'HQ', 13.05, 80.25, 100, '2026-12-01T03:30:00Z', '2026-12-01T03:30:00Z')`);
  await sql(`INSERT INTO "TransportTrip" (id, "plannedTripId", "providerCompanyId", "customerCompanyId", "serviceDate", direction, "shiftId", "sitePoiId", "seatCapacity", "occupiedSeats", "publishedAt", "updatedAt") VALUES ('${g.trip}', '${g.plannedTrip}', '${g.company}', '${g.company}', '2026-12-01', 'IN', '${g.shift}', '${g.office}', 4, 1, now(), now())`);
  await sql(`INSERT INTO "TransportTripPassenger" (id, "tripId", "bookingId", "customerCompanyId", "providerCompanyId", "pickupStopId", "dropStopId", "pickupSeq", "dropSeq", "updatedAt") VALUES ('${g.passenger}', '${g.trip}', '${g.seated}', '${g.company}', '${g.company}', '${g.stop0}', '${g.stop1}', 0, 1, now())`);
  await sql(`INSERT INTO "TransportTripEvent" (id, "tripId", "providerCompanyId", "customerCompanyId", "passengerTripId", kind, "actorType", source, "occurredAt") VALUES (gen_random_uuid(), '${g.trip}', '${g.company}', '${g.company}', NULL, 'PUBLISHED', 'DISPATCHER', 'WEB', now()), (gen_random_uuid(), '${g.trip}', '${g.company}', '${g.company}', '${g.passenger}', 'PASSENGER_ADDED', 'DISPATCHER', 'WEB', now())`);
  await sql(`INSERT INTO "TransportChangeSet" (id, "companyId", "idempotencyKey", "requestHash", status, "serviceDate", direction, "publishedAt") VALUES ('${g.changeSet}', '${g.company}', 'key-${g.changeSet}', 'h', 'PUBLISHED', '2026-12-01', 'IN', now())`);
  return g;
}

const E3_TABLES = ['TransportShift', 'TransportSchedule', 'TransportScheduleException', 'TransportBooking', 'TransportTrip', 'TransportTripPassenger', 'TransportTripEvent', 'TransportChangeSet'];

async function e3Counts(tx: Pick<Tx, '$queryRawUnsafe'>, company: string, g?: { plannedTrip: string; trip: string }) {
  const [r] = await tx.$queryRawUnsafe<Record<string, bigint | string | null>[]>(`SELECT
    (SELECT count(*) FROM "TransportShift" WHERE "companyId" = '${company}') AS shifts,
    (SELECT count(*) FROM "TransportSchedule" WHERE "companyId" = '${company}') AS schedules,
    (SELECT count(*) FROM "TransportScheduleException" WHERE "companyId" = '${company}') AS exceptions,
    (SELECT count(*) FROM "TransportBooking" WHERE "customerCompanyId" = '${company}') AS bookings,
    (SELECT count(*) FROM "TransportTrip" WHERE "providerCompanyId" = '${company}') AS trips,
    (SELECT count(*) FROM "TransportTripPassenger" WHERE "customerCompanyId" = '${company}') AS passengers,
    (SELECT count(*) FROM "TransportTripEvent" WHERE "providerCompanyId" = '${company}') AS events,
    (SELECT count(*) FROM "TransportChangeSet" WHERE "companyId" = '${company}') AS "changeSets",
    (SELECT count(*) FROM "PlannedTrip" WHERE "companyId" = '${company}') AS "plannedTrips",
    (SELECT count(*) FROM "Company" WHERE id = '${company}') AS company
    ${g ? `, (SELECT "plannedTripId"::text FROM "TransportTrip" WHERE id = '${g.trip}') AS "headerPlannedTripId", (SELECT count(*) FROM "TransportTripPassenger" WHERE "tripId" = '${g.trip}' AND "pickupStopId" IS NULL AND "pickupSeq" = 0) AS "passengersWithSeqOnly"` : ''}`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
}

d(`etms_bookings_trips + planned_trip_origin on ${dbName}`, () => {
  jest.setTimeout(240_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(async () => {
    const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Company" WHERE name LIKE 'etms-e3-db-test %'`;
    expect(Number(left[0].n)).toBe(0);
    await prisma.$disconnect();
  });

  it('creates the documented tables, partial unique indexes, CHECKs, EXCLUDE constraints and FK actions (doc 15 §5, §7.1, §8.2)', async () => {
    const ext = await prisma.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(ext).toHaveLength(1);
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${E3_TABLES})`;
    expect(tables.map((t) => t.tablename).sort()).toEqual([...E3_TABLES].sort());
    const partial = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('TransportBooking_active_passenger_day_key', 'TransportTripPassenger_active_booking_key', 'PlannedTrip_driverId_plannedStart_idx')`;
    expect(partial.map((p) => p.indexname).sort()).toEqual(['PlannedTrip_driverId_plannedStart_idx', 'TransportBooking_active_passenger_day_key', 'TransportTripPassenger_active_booking_key']);
    expect(partial.find((p) => p.indexname === 'TransportBooking_active_passenger_day_key')!.indexdef).toMatch(/UNIQUE .* WHERE .*CANCELLED.*REJECTED.*EXPIRED.*FAILED/);
    const cons = await prisma.$queryRaw<{ conname: string; contype: string; confdeltype: string; cols: string[] }[]>`
      SELECT con.conname, con.contype, con.confdeltype,
             ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid WHERE c.relname = ANY(${[...E3_TABLES, 'PlannedTrip']})`;
    const by = Object.fromEntries(cons.map((c) => [c.conname, c]));
    const checks = [
      'TransportShift_minutes_check', 'TransportShift_overnight_check', 'TransportShift_days_check',
      'TransportSchedule_validity_check', 'TransportSchedule_days_check', 'TransportSchedule_version_check',
      'TransportScheduleException_override_check',
      'TransportBooking_window_check', 'TransportBooking_passenger_count_check', 'TransportBooking_version_check', 'TransportBooking_point_pairs_check', 'TransportBooking_assigned_points_check', 'TransportBooking_source_check',
      'TransportTrip_seat_capacity_check', 'TransportTrip_occupied_seats_check', 'TransportTrip_version_check', 'TransportTrip_acknowledged_check',
      'TransportTripPassenger_seats_check', 'TransportTripPassenger_seq_check', 'TransportTripPassenger_boarded_check', 'TransportTripPassenger_dropped_check', 'TransportTripPassenger_no_show_check', 'TransportTripPassenger_outcome_source_check',
      'TransportTripEvent_source_check', 'TransportTripEvent_outcome_check', 'TransportTripEvent_actor_check', 'TransportTripEvent_point_check',
      'TransportChangeSet_published_check',
      'PlannedTrip_origin_check', 'PlannedTrip_route_origin_check',
    ];
    for (const n of checks) expect([n, by[n]?.contype]).toEqual([n, 'c']);
    expect(by.PlannedTrip_etms_vehicle_overlap_excl?.contype).toBe('x');
    expect(by.PlannedTrip_etms_driver_overlap_excl?.contype).toBe('x');
    const fk = (n: string) => [n, by[n]?.confdeltype, by[n]?.cols];
    // Composite FKs: row id first (doc 15 §1.2); actions per doc 15 §5.
    expect(fk('TransportSchedule_profileId_companyId_fkey')).toEqual(['TransportSchedule_profileId_companyId_fkey', 'c', ['profileId', 'companyId']]);
    expect(fk('TransportSchedule_shiftId_companyId_fkey')).toEqual(['TransportSchedule_shiftId_companyId_fkey', 'r', ['shiftId', 'companyId']]);
    expect(fk('TransportScheduleException_scheduleId_companyId_fkey')).toEqual(['TransportScheduleException_scheduleId_companyId_fkey', 'c', ['scheduleId', 'companyId']]);
    expect(fk('TransportBooking_profileId_customerCompanyId_fkey')).toEqual(['TransportBooking_profileId_customerCompanyId_fkey', 'r', ['profileId', 'customerCompanyId']]);
    expect(fk('TransportTripPassenger_tripId_providerCompanyId_fkey')).toEqual(['TransportTripPassenger_tripId_providerCompanyId_fkey', 'c', ['tripId', 'providerCompanyId']]);
    expect(fk('TransportTripPassenger_bookingId_customerCompanyId_fkey')).toEqual(['TransportTripPassenger_bookingId_customerCompanyId_fkey', 'r', ['bookingId', 'customerCompanyId']]);
    expect(fk('TransportTripEvent_tripId_providerCompanyId_fkey')).toEqual(['TransportTripEvent_tripId_providerCompanyId_fkey', 'c', ['tripId', 'providerCompanyId']]);
    for (const [n, del] of [
      ['TransportShift_companyId_fkey', 'r'], ['TransportBooking_customerCompanyId_fkey', 'r'], ['TransportBooking_providerCompanyId_fkey', 'n'], ['TransportBooking_agreementId_fkey', 'n'], ['TransportBooking_scheduleId_fkey', 'n'],
      ['TransportTrip_plannedTripId_fkey', 'n'], ['TransportTrip_providerCompanyId_fkey', 'r'], ['TransportTrip_customerCompanyId_fkey', 'n'], ['TransportTripPassenger_pickupStopId_fkey', 'n'],
      ['TransportTripEvent_customerCompanyId_fkey', 'n'], ['TransportTripEvent_passengerTripId_fkey', 'c'], ['TransportChangeSet_companyId_fkey', 'r'],
    ] as const) expect([n, by[n]?.confdeltype]).toEqual([n, del]);
    // Logical-key rule (doc 15 §1.2): no SetNull FK on a column named companyId; TransportTrip has no objectId column.
    expect(cons.filter((c) => c.contype === 'f' && c.cols[0] === 'companyId' && c.confdeltype === 'n')).toEqual([]);
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'TransportTrip'`;
    expect(cols.map((c) => c.column_name)).not.toContain('objectId');
  });

  it('constraints reject bad rows (savepoints; whole transaction rolled back)', async () => {
    const outcomes: Record<string, string> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const a = await seedGraph(tx, partnerId, 'A');
      const b = await seedGraph(tx, partnerId, 'B');
      const attempt = async (name: string, sql: string) => {
        await tx.$executeRawUnsafe('SAVEPOINT s');
        try {
          await tx.$executeRawUnsafe(sql);
          outcomes[name] = 'accepted';
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
        } catch (e) {
          const text = String(e);
          const named = /(Transport|PlannedTrip)[A-Za-z]*_[A-Za-z_]+_(?:check|key|fkey|excl)/.exec(text)?.[0] ?? /Code: `\w+`/.exec(text)?.[0];
          outcomes[name] = `rejected ${named ?? text.slice(0, 160)}`;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
        }
      };
      const shift = (start: number, end: number, overnight: boolean, days = '{1}') => `INSERT INTO "TransportShift" (id, "companyId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES (gen_random_uuid(), '${a.company}', '${randomUUID()}', ${start}, ${end}, ${overnight}, '${days}', 'Asia/Kolkata', now())`;
      await attempt('shift overnight flag wrong', shift(1320, 360, false));
      await attempt('shift overnight ok', shift(1320, 360, true));
      await attempt('shift start = end', shift(540, 540, false));
      await attempt('shift day 7', shift(540, 1080, false, '{1,7}'));
      await attempt('shift no days', shift(540, 1080, false, '{}'));
      await attempt('schedule on another company passenger', `INSERT INTO "TransportSchedule" (id, "companyId", "profileId", "shiftId", direction, days, "pickupMode", "validFrom", "updatedAt") VALUES (gen_random_uuid(), '${a.company}', '${b.profile}', '${a.shift}', 'IN', '{1}', 'HOME', '2026-12-01', now())`);
      await attempt('schedule validTo before validFrom', `INSERT INTO "TransportSchedule" (id, "companyId", "profileId", "shiftId", direction, days, "pickupMode", "validFrom", "validTo", "updatedAt") VALUES (gen_random_uuid(), '${a.company}', '${a.profile}', '${a.shift}', 'IN', '{1}', 'HOME', '2026-12-05', '2026-12-01', now())`);
      await attempt('exception OVERRIDE without override', `INSERT INTO "TransportScheduleException" (id, "companyId", "scheduleId", date, kind) VALUES (gen_random_uuid(), '${a.company}', '${a.schedule}', '2026-12-09', 'OVERRIDE')`);
      const booking = (o: { status?: string; profile?: string; company?: string; dir?: string; date?: string; scheduleId?: string | null; source?: string; pickup?: string; window?: [string, string] } = {}) =>
        `INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", "scheduleId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
         VALUES (gen_random_uuid(), '${o.company ?? a.company}', '${o.profile ?? a.profile}', ${q(o.scheduleId ?? null)}, '${o.source ?? 'ADHOC'}', '${o.date ?? '2026-12-03'}', '${o.dir ?? 'IN'}', 'Asia/Kolkata', ${o.pickup ?? '13.06, 80.24'}, 13.05, 80.25, '${(o.window ?? ['2026-12-03T02:00:00Z', '2026-12-03T03:30:00Z'])[0]}', '${(o.window ?? ['2026-12-03T02:00:00Z', '2026-12-03T03:30:00Z'])[1]}', '${o.status ?? 'PENDING_ASSIGNMENT'}', now())`;
      await attempt('booking first of the day', booking());
      await attempt('second active booking same passenger / day / direction', booking({ status: 'REQUESTED' }));
      await attempt('second booking other direction', booking({ dir: 'OUT' }));
      await attempt('cancelled duplicate is fine', booking({ status: 'CANCELLED' }));
      await attempt('booking window reversed', booking({ date: '2026-12-04', window: ['2026-12-04T03:00:00Z', '2026-12-04T02:00:00Z'] }));
      await attempt('ASSIGNED booking without pickup', booking({ date: '2026-12-05', status: 'ASSIGNED', pickup: 'NULL, NULL' }));
      await attempt('lone pickup latitude', booking({ date: '2026-12-06', pickup: '13.06, NULL' }));
      await attempt('ADHOC booking with a schedule', booking({ date: '2026-12-07', scheduleId: a.schedule }));
      await attempt('booking for another company passenger', booking({ date: '2026-12-08', profile: b.profile }));
      await attempt('generator duplicate (schedule, date, direction)', booking({ date: '2026-12-01', source: 'SCHEDULE', scheduleId: a.schedule, status: 'CANCELLED' }));
      await attempt('occupied seats above capacity', `UPDATE "TransportTrip" SET "occupiedSeats" = 5 WHERE id = '${a.trip}'`);
      await attempt('seat capacity 0', `UPDATE "TransportTrip" SET "seatCapacity" = 0, "occupiedSeats" = 0 WHERE id = '${a.trip}'`);
      await attempt('acknowledged but not published', `UPDATE "TransportTrip" SET "publishedAt" = NULL, "acknowledgedAt" = now() WHERE id = '${a.trip}'`);
      const outcome = (status: string, source: string | null, ts = 'now()') => `UPDATE "TransportTripPassenger" SET status = '${status}', "boardedAt" = ${ts}, "noShowAt" = ${ts}, "droppedAt" = ${ts}, "outcomeSource" = ${q(source)} WHERE id = '${a.passenger}'`;
      await attempt('BOARDED from GPS', outcome('BOARDED', 'GPS'));
      await attempt('BOARDED from SYSTEM', outcome('BOARDED', 'SYSTEM'));
      await attempt('BOARDED without a source', outcome('BOARDED', null));
      await attempt('NO_SHOW from the processor', outcome('NO_SHOW', 'PROCESSOR'));
      await attempt('BOARDED without boardedAt', outcome('BOARDED', 'WEB', 'NULL'));
      await attempt('BOARDED by the dispatcher (WEB)', outcome('BOARDED', 'WEB'));
      const pax = (booking: string, pick: number, drop: number, company = a.company) => `INSERT INTO "TransportTripPassenger" (id, "tripId", "bookingId", "customerCompanyId", "providerCompanyId", "pickupSeq", "dropSeq", "updatedAt") VALUES (gen_random_uuid(), '${a.trip}', '${booking}', '${company}', '${a.company}', ${pick}, ${drop}, now())`;
      await attempt('second active seat for one booking', pax(a.seated, 0, 1));
      await attempt('drop before pickup', pax(a.booking, 1, 1));
      await attempt('seat for another company booking', pax(b.booking, 0, 1));
      await attempt('event from GPS source', `INSERT INTO "TransportTripEvent" (id, "tripId", "providerCompanyId", kind, "actorType", source, "occurredAt") VALUES (gen_random_uuid(), '${a.trip}', '${a.company}', 'BOARDED', 'SYSTEM', 'GPS', now())`);
      await attempt('event on another company trip', `INSERT INTO "TransportTripEvent" (id, "tripId", "providerCompanyId", kind, "actorType", source, "occurredAt") VALUES (gen_random_uuid(), '${b.trip}', '${a.company}', 'BOARDED', 'DISPATCHER', 'WEB', now())`);
      await attempt('published change set without key', `INSERT INTO "TransportChangeSet" (id, "companyId", status, "serviceDate", direction, "publishedAt") VALUES (gen_random_uuid(), '${a.company}', 'PUBLISHED', '2026-12-01', 'IN', now())`);
      await attempt('change set key reused', `INSERT INTO "TransportChangeSet" (id, "companyId", "idempotencyKey", status, "serviceDate", direction) VALUES (gen_random_uuid(), '${a.company}', 'key-${a.changeSet}', 'DRAFT', '2026-12-01', 'IN')`);
      const pt = (origin: string, routeId: string | null, object: string, driver: string | null, start: string, end: string, status = 'SCHEDULED') =>
        `INSERT INTO "PlannedTrip" (id, "companyId", "routeId", origin, "objectId", "driverId", "routeName", "corridorM", "plannedStart", "plannedEnd", status, "updatedAt") VALUES (gen_random_uuid(), '${a.company}', ${q(routeId)}, '${origin}', '${object}', ${q(driver)}, 'X', 200, '${start}', '${end}', '${status}', now())`;
      await attempt('ROUTE trip without route', pt('ROUTE', null, a.object, null, '2026-12-01T10:00:00Z', '2026-12-01T11:00:00Z'));
      await attempt('unknown origin', pt('OTHER', randomUUID(), a.object, null, '2026-12-01T10:00:00Z', '2026-12-01T11:00:00Z'));
      await attempt('ETMS vehicle overlap', pt('ETMS', null, a.object, null, '2026-12-01T03:00:00Z', '2026-12-01T04:00:00Z'));
      const spare = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${spare}', '${a.company}', 'Spare', now())`);
      await attempt('ETMS driver overlap (other vehicle)', pt('ETMS', null, spare, a.driver, '2026-12-01T03:00:00Z', '2026-12-01T04:00:00Z'));
      await attempt('shift days NULL', `INSERT INTO "TransportShift" (id, "companyId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES (gen_random_uuid(), '${a.company}', 'nulldays', 540, 1080, false, NULL, 'Asia/Kolkata', now())`);
      await attempt('ETMS back-to-back', pt('ETMS', null, a.object, a.driver, '2026-12-01T03:30:00Z', '2026-12-01T04:30:00Z'));
      await attempt('ETMS overlap with a cancelled ETMS trip', pt('ETMS', null, b.object, null, '2026-12-01T02:30:00Z', '2026-12-01T03:30:00Z', 'CANCELLED'));
      await attempt('ROUTE overlap (left to the publish transaction)', pt('ROUTE', randomUUID(), a.object, a.driver, '2026-12-01T02:45:00Z', '2026-12-01T03:15:00Z'));
      await attempt('app delete of a seated booking', `DELETE FROM "TransportBooking" WHERE id = '${a.seated}'`);
      await attempt('app delete of a shift with schedules', `DELETE FROM "TransportShift" WHERE id = '${a.shift}'`);
    });
    console.log(JSON.stringify(outcomes, null, 2));
    const rejected = (n: string, c: RegExp) => expect([n, outcomes[n]]).toEqual([n, expect.stringMatching(c)]);
    const accepted = (n: string) => expect([n, outcomes[n]]).toEqual([n, 'accepted']);
    rejected('shift overnight flag wrong', /TransportShift_overnight_check/);
    accepted('shift overnight ok');
    rejected('shift start = end', /TransportShift_minutes_check/);
    rejected('shift day 7', /TransportShift_days_check/);
    rejected('shift no days', /TransportShift_days_check/);
    rejected('schedule on another company passenger', /TransportSchedule_profileId_companyId_fkey|23503/);
    rejected('schedule validTo before validFrom', /TransportSchedule_validity_check/);
    rejected('exception OVERRIDE without override', /TransportScheduleException_override_check/);
    accepted('booking first of the day');
    rejected('second active booking same passenger / day / direction', /TransportBooking_active_passenger_day_key|23505/);
    accepted('second booking other direction');
    accepted('cancelled duplicate is fine');
    rejected('booking window reversed', /TransportBooking_window_check/);
    rejected('ASSIGNED booking without pickup', /TransportBooking_assigned_points_check/);
    rejected('lone pickup latitude', /TransportBooking_point_pairs_check/);
    rejected('ADHOC booking with a schedule', /TransportBooking_source_check/);
    rejected('booking for another company passenger', /TransportBooking_profileId_customerCompanyId_fkey|23503/);
    rejected('generator duplicate (schedule, date, direction)', /TransportBooking_scheduleId_serviceDate_direction_key|23505/);
    rejected('occupied seats above capacity', /TransportTrip_occupied_seats_check/);
    rejected('seat capacity 0', /TransportTrip_seat_capacity_check/);
    rejected('acknowledged but not published', /TransportTrip_acknowledged_check/);
    rejected('BOARDED from GPS', /TransportTripPassenger_outcome_source_check/);
    rejected('BOARDED from SYSTEM', /TransportTripPassenger_outcome_source_check/);
    rejected('BOARDED without a source', /TransportTripPassenger_outcome_source_check/);
    rejected('NO_SHOW from the processor', /TransportTripPassenger_outcome_source_check/);
    rejected('BOARDED without boardedAt', /TransportTripPassenger_boarded_check/);
    accepted('BOARDED by the dispatcher (WEB)');
    rejected('second active seat for one booking', /TransportTripPassenger_active_booking_key|23505/);
    rejected('drop before pickup', /TransportTripPassenger_seq_check/);
    rejected('seat for another company booking', /TransportTripPassenger_bookingId_customerCompanyId_fkey|23503/);
    rejected('event from GPS source', /TransportTripEvent_source_check/);
    rejected('event on another company trip', /TransportTripEvent_tripId_providerCompanyId_fkey|23503/);
    rejected('published change set without key', /TransportChangeSet_published_check/);
    rejected('change set key reused', /TransportChangeSet_companyId_idempotencyKey_key|23505/);
    rejected('ROUTE trip without route', /PlannedTrip_route_origin_check/);
    rejected('unknown origin', /PlannedTrip_origin_check/);
    rejected('ETMS vehicle overlap', /PlannedTrip_etms_vehicle_overlap_excl/);
    rejected('ETMS driver overlap (other vehicle)', /PlannedTrip_etms_driver_overlap_excl/);
    rejected('shift days NULL', /TransportShift_days_check/);
    accepted('ETMS back-to-back');
    accepted('ETMS overlap with a cancelled ETMS trip');
    accepted('ROUTE overlap (left to the publish transaction)');
    expect(outcomes['app delete of a seated booking']).toMatch(/rejected/);
    expect(outcomes['app delete of a shift with schedules']).toMatch(/rejected/);
  });

  it('purge: company → every E3 row gone, other company untouched; vehicle → header and passengers kept, stop FKs NULL (doc 15 §6, §9.6)', async () => {
    const results: Record<string, unknown> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const cat = await loadCatalog(tx);
      // §9.6 item 1: composite FKs are seen by their row-id column; item 2: every E3 table is reached from a company purge.
      expect(cat.fks).toEqual(expect.arrayContaining([expect.objectContaining({ child: 'TransportTripPassenger', col: 'tripId', parent: 'TransportTrip', refCol: 'id', del: 'c' })]));
      const plan = planPurge(cat, 'Company', rootCondition(randomUUID()));
      for (const t of E3_TABLES) expect([t, plan.some((s) => s.table === t && !s.nullCol)]).toEqual([t, true]);
      // TransportTrip is not reached from TrackedObject (no objectId column): a vehicle purge only nulls plannedTripId.
      const vehiclePlan = planPurge(cat, 'TrackedObject', rootCondition(randomUUID()));
      expect(vehiclePlan.some((s) => s.table === 'TransportTrip' && !s.nullCol)).toBe(false);
      const a = await seedGraph(tx, partnerId, 'PA');
      const b = await seedGraph(tx, partnerId, 'PB');
      for (const s of planPurge(cat, 'TrackedObject', rootCondition(b.object))) await tx.$executeRawUnsafe(stepSql(s));
      results.vehiclePurgeB = await e3Counts(tx, b.company, b);
      for (const s of planPurge(cat, 'Company', rootCondition(a.company))) await tx.$executeRawUnsafe(stepSql(s));
      results.companyA = await e3Counts(tx, a.company);
      results.companyB = await e3Counts(tx, b.company);
    });
    console.log(JSON.stringify(results, null, 2));
    expect(results.vehiclePurgeB).toEqual({ shifts: 1, schedules: 1, exceptions: 1, bookings: 2, trips: 1, passengers: 1, events: 2, changeSets: 1, plannedTrips: 0, company: 1, headerPlannedTripId: null, passengersWithSeqOnly: 1 });
    expect(results.companyA).toEqual({ shifts: 0, schedules: 0, exceptions: 0, bookings: 0, trips: 0, passengers: 0, events: 0, changeSets: 0, plannedTrips: 0, company: 0 });
    expect(results.companyB).toEqual({ shifts: 1, schedules: 1, exceptions: 1, bookings: 2, trips: 1, passengers: 1, events: 2, changeSets: 1, plannedTrips: 0, company: 1 });
  });
});

// ───────────────────────────── Services on the real database ─────────────────────────────

const httpCode = (e: unknown): string => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? 'NO_CODE') : `unexpected: ${String(e)}`);

/**
 * The publish transaction, the concurrency rules and the booking generator against PostgreSQL (12 §5 exit criteria).
 * Scratch companies, purged in afterAll.
 */
d(`ETMS E3 services on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const companies: string[] = [];
  let ownPartnerId: string | null = null;
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => 1, publish: async () => 1 } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const trips = new TripsService(prisma as never, audit, plannedTrips, dispatch, live);
  const bookings = new BookingsService(prisma as never, audit, redis as never);
  const generator = new BookingGeneratorService(prisma as never, redis as never);
  const schedules = new SchedulesService(prisma as never, audit, generator);

  afterAll(async () => {
    const cat = await loadCatalog(prisma);
    for (const c of companies) for (const s of planPurge(cat, 'Company', rootCondition(c))) await prisma.$executeRawUnsafe(stepSql(s));
    if (ownPartnerId) await prisma.$executeRawUnsafe(`DELETE FROM "Partner" WHERE id = '${ownPartnerId}'`);
    await prisma.$disconnect();
  });

  async function company(tag: string, timezone = 'Asia/Kolkata') {
    const [existing] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
    const partnerId = existing?.id ?? (ownPartnerId ??= await scratchPartner(prisma));
    const id = randomUUID();
    companies.push(id);
    await prisma.$executeRawUnsafe(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${id}', '${partnerId}', 'etms-e3-db-test ${tag}', '${timezone}', '{"features":["etms"]}', now())`);
    const office = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${office}', '${id}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
    const ctx = { userId: randomUUID(), companyId: id, homeCompanyId: id, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null } as never;
    return { id, office, ctx };
  }
  async function passengers(companyId: string, n: number) {
    const ids = Array.from({ length: n }, () => randomUUID());
    const values = ids.map((p, i) => `('${p}', '${companyId}', 'S${String(i).padStart(4, '0')}', 'Synthetic ${i}', ${(12.9 + (i % 50) / 1000).toFixed(4)}, ${(80.2 + (i % 40) / 1000).toFixed(4)}, now())`);
    await prisma.$executeRawUnsafe(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "homeLat", "homeLng", "updatedAt") VALUES ${values.join(',')}`);
    await prisma.$executeRawUnsafe(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") SELECT gen_random_uuid(), '${companyId}', id, 'TRANSPORT_PROFILE', 'v1', true, 'ADMIN_ON_BEHALF', now() - interval '1 day' FROM "EmployeeTransportProfile" WHERE id = ANY('{${ids.join(',')}}'::uuid[])`);
    return ids;
  }
  async function vehicle(companyId: string, seats: number) {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "isActive", "updatedAt") VALUES ('${id}', '${companyId}', 'Van ${id.slice(0, 4)}', true, now())`);
    await prisma.$executeRawUnsafe(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${id}', '${companyId}', ${seats}, now())`);
    return id;
  }
  async function driver(companyId: string) {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "Driver" (id, "companyId", name, "isActive", "updatedAt") VALUES ('${id}', '${companyId}', 'Driver ${id.slice(0, 4)}', true, now())`);
    return id;
  }
  async function booking(companyId: string, profileId: string, day: string, start: number) {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
      VALUES ('${id}', '${companyId}', '${profileId}', 'ADHOC', '${day}', 'IN', 'Asia/Kolkata', 13.06, 80.24, 13.05, 80.25, '${new Date(start).toISOString()}', '${new Date(start + 1.5 * H).toISOString()}', 'PENDING_ASSIGNMENT', now())`);
    return id;
  }
  const stops = (from: number) => [
    { seq: 0, point: { lat: 13.06, lng: 80.24, label: 'Pickup' }, plannedArrival: new Date(from).toISOString() },
    { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'HQ' }, plannedArrival: new Date(from + H).toISOString() },
  ];
  const create = (objectId: string, from: number, driverId: string | null = null): DispatchChangeOp => ({ op: 'CREATE_TRIP', tempId: 't', objectId, driverId, plannedStart: new Date(from).toISOString(), stops: stops(from) });

  it('publish is atomic; capacity is never exceeded under concurrent change sets (409 VERSION_CONFLICT / CAPACITY_EXCEEDED)', async () => {
    const c = await company('capacity');
    const day = '2027-02-01';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const v = await vehicle(c.id, 3);
    const ps = await passengers(c.id, 9);
    const bs = await Promise.all(ps.map((p) => booking(c.id, p, day, t0)));
    // A refused change set leaves nothing behind (atomic publish).
    const refused = await dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [create(v, t0), ...bs.slice(0, 4).map((b): DispatchChangeOp => ({ op: 'ADD_PASSENGER', tripId: 't', bookingId: b, pickupSeq: 0, dropSeq: 1 }))] }, randomUUID()).catch(httpCode);
    expect(refused).toBe('CAPACITY_EXCEEDED');
    expect(await prisma.plannedTrip.count({ where: { companyId: c.id } })).toBe(0);
    expect(await prisma.transportBooking.count({ where: { customerCompanyId: c.id, status: 'ASSIGNED' } })).toBe(0);

    const r = await dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [create(v, t0)] }, randomUUID());
    const tripId = r.value.trips[0].id;
    // 8 parallel change sets on version 1: exactly one wins, the others get VERSION_CONFLICT.
    const burst = await Promise.all(bs.slice(0, 8).map((b) => dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [{ op: 'ADD_PASSENGER', tripId, bookingId: b, pickupSeq: 0, dropSeq: 1 }], expectedVersions: { [tripId]: 1 } }, randomUUID()).then(() => 'OK', httpCode)));
    expect(burst.filter((x) => x === 'OK')).toHaveLength(1);
    expect(burst.filter((x) => x === 'VERSION_CONFLICT')).toHaveLength(7);
    // Every dispatcher retries with the fresh version until seated or full.
    const results = await Promise.all(
      bs.slice(1, 9).map(async (b) => {
        for (let i = 0; i < 40; i++) {
          const t = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } });
          const res = await dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [{ op: 'ADD_PASSENGER', tripId, bookingId: b, pickupSeq: 0, dropSeq: 1 }], expectedVersions: { [tripId]: t.version } }, randomUUID()).then(() => 'OK', httpCode);
          if (res !== 'VERSION_CONFLICT') return res;
        }
        return 'GAVE_UP';
      }),
    );
    const trip = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } });
    const seated = await prisma.transportTripPassenger.aggregate({ where: { tripId, status: { not: 'CANCELLED' } }, _sum: { seats: true }, _count: true });
    console.log(JSON.stringify({ burst: burst.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}), retries: results.reduce<Record<string, number>>((m, x) => ({ ...m, [x as string]: (m[x as string] ?? 0) + 1 }), {}), occupiedSeats: trip.occupiedSeats, seatCapacity: trip.seatCapacity, sumSeats: seated._sum.seats }));
    expect(trip.occupiedSeats).toBe(3);
    expect(seated._sum.seats).toBe(trip.occupiedSeats); // invariant occupiedSeats = SUM(active seats) (15 §8.3)
    // One seat went to the burst winner; two more are taken; everyone else is refused (full, or already seated).
    expect(results.filter((x) => x === 'OK')).toHaveLength(2);
    expect(results.filter((x) => x === 'CAPACITY_EXCEEDED').length + results.filter((x) => x === 'INVALID_STATE').length).toBe(6);
  });

  it('two dispatchers, one vehicle / driver, overlapping windows: exactly one publish succeeds (VEHICLE_BUSY / DRIVER_BUSY)', async () => {
    const c = await company('overlap');
    const day = '2027-02-02';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const [v1, v2] = [await vehicle(c.id, 4), await vehicle(c.id, 4)];
    const dr = await driver(c.id);
    const sameVehicle = await Promise.all([0, 15].map((m) => dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [create(v1, t0 + m * 60_000)] }, randomUUID()).then(() => 'OK', httpCode)));
    expect(sameVehicle.sort()).toEqual(['OK', 'VEHICLE_BUSY']);
    const later = t0 + 6 * H;
    const sameDriver = await Promise.all([v1, v2].map((v, i) => dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [create(v, later + i * 600_000, dr)] }, randomUUID()).then(() => 'OK', httpCode)));
    expect(sameDriver.sort()).toEqual(['DRIVER_BUSY', 'OK']);
  });

  it('double submit of a booking = one booking; a second key for the same passenger / day = 409 BOOKING_DUPLICATE', async () => {
    const c = await company('bookings');
    const [p] = await passengers(c.id, 1);
    const day = new Date(Date.now() + 5 * 24 * H).toISOString().slice(0, 10);
    const body = { passengerId: p, serviceDate: day, direction: 'IN' as const, windowStart: `${day}T02:00:00.000Z`, windowEnd: `${day}T03:30:00.000Z`, pickup: { lat: 13.06, lng: 80.24 }, drop: { lat: 13.05, lng: 80.25 } };
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 5 }, () => bookings.create(c.ctx, body, key)));
    expect(new Set(same.map((r) => r.value.id)).size).toBe(1);
    expect(same.filter((r) => !r.replay)).toHaveLength(1);
    const other = await Promise.all([randomUUID(), randomUUID()].map((k) => bookings.create(c.ctx, body, k).then(() => 'OK', httpCode)));
    expect(other).toEqual(['BOOKING_DUPLICATE', 'BOOKING_DUPLICATE']);
    expect(await prisma.transportBooking.count({ where: { customerCompanyId: c.id } })).toBe(1);
  });

  it('a GPS stop arrival never boards a passenger; only the dispatcher (WEB) records outcomes', async () => {
    const c = await company('gps');
    const day = '2027-02-03';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const v = await vehicle(c.id, 4);
    const ps = await passengers(c.id, 2);
    const bs = await Promise.all(ps.map((p) => booking(c.id, p, day, t0)));
    const r = await dispatch.submit(c.ctx, { serviceDate: day, direction: 'IN', changes: [create(v, t0), ...bs.map((b): DispatchChangeOp => ({ op: 'ADD_PASSENGER', tripId: 't', bookingId: b, pickupSeq: 0, dropSeq: 1 }))] }, randomUUID());
    const tripId = r.value.trips[0].id;
    const pt = await prisma.plannedTrip.findUniqueOrThrow({ where: { id: r.value.trips[0].plannedTripId! }, include: { stops: true } });
    expect(pt).toMatchObject({ origin: 'ETMS', routeId: null });
    await trips.start(c.ctx, tripId, {});
    // What the processor tracker writes on a GPS arrival / departure (no other table is touched by it).
    await prisma.plannedTripStop.updateMany({ where: { tripId: pt.id }, data: { status: 'ARRIVED', actualArrival: new Date() } });
    const after = await prisma.transportTripPassenger.findMany({ where: { tripId } });
    expect(after.map((p) => [p.status, p.outcomeSource, p.boardedAt])).toEqual([
      ['PENDING', null, null],
      ['PENDING', null, null],
    ]);
    // Even a direct write that claims a GPS / system source is refused by the database.
    const forged = await prisma.$executeRawUnsafe(`UPDATE "TransportTripPassenger" SET status = 'BOARDED', "boardedAt" = now(), "outcomeSource" = 'SYSTEM' WHERE id = '${after[0].id}'`).then(() => 'accepted', (e: unknown) => /outcome_source_check/.exec(String(e))?.[0] ?? String(e));
    expect(forged).toBe('outcome_source_check');
    const t = await trips.outcome(c.ctx, tripId, after[0].id, { outcome: 'BOARDED' });
    expect(t.passengers.find((p) => p.id === after[0].id)).toMatchObject({ status: 'BOARDED', outcomeSource: 'WEB' });
    expect(t.passengers.find((p) => p.id === after[1].id)).toMatchObject({ status: 'PENDING', outcomeMissing: true });
  });

  it('recurring week for 200 passengers (IST) generated, re-run idempotent, modified and cancelled with correct counts; US DST week at 09:00 local', async () => {
    const c = await company('generator IST');
    const ps = await passengers(c.id, 200);
    const shift = await schedules.createShift(c.ctx, { name: 'Day', sitePoiId: c.office, startMin: 9 * 60, endMin: 18 * 60, days: [1, 2, 3, 4, 5] });
    // Created with validFrom in the future: nothing in the 72 h horizon of "now".
    const created = await schedules.createSchedules(c.ctx, { profileIds: ps, shiftId: shift.id, directions: ['IN', 'OUT'], pickupMode: 'HOME', validFrom: '2027-03-01', validTo: '2027-03-07' });
    expect(created.created).toHaveLength(400);
    const ids = created.created.map((s) => s.id);
    // Walk the generator through the week (Mon 1 – Sun 7 Mar 2027, IST), 72 h horizon per run.
    const monday = Date.parse('2027-02-28T18:30:00Z'); // 00:00 IST Monday
    let made = 0;
    const t0 = Date.now();
    for (let dDay = 0; dDay < 7; dDay++) made += (await generator.generate(monday + dDay * 24 * H, ids)).created;
    const genMs = Date.now() - t0;
    let again = 0;
    for (let dDay = 0; dDay < 7; dDay++) again += (await generator.generate(monday + dDay * 24 * H, ids)).created;
    const count = (where: Prisma.TransportBookingWhereInput) => prisma.transportBooking.count({ where: { customerCompanyId: c.id, ...where } });
    const total = await count({});
    const needsLocation = await count({ OR: [{ pickupLat: null }, { dropLat: null }] });
    // Modify: Wednesday's login skipped for 10 passengers; cancel: 5 passengers' OUT schedules archived.
    const scheduleOf = new Map(created.created.map((s) => [`${s.passenger.id}|${s.direction}`, s.id]));
    for (const p of ps.slice(0, 10)) await schedules.createException(c.ctx, scheduleOf.get(`${p}|IN`)!, { date: '2027-03-03', kind: 'SKIP', reason: 'Leave' });
    const skipped = await count({ status: 'CANCELLED', statusReason: 'Skipped (schedule exception)' });
    // Archive needs window starts after "now"; these are in March 2027.
    for (const p of ps.slice(10, 15)) await schedules.archiveSchedule(c.ctx, scheduleOf.get(`${p}|OUT`)!);
    const archived = await count({ status: 'CANCELLED', statusReason: 'Schedule archived' });
    const wrongTime = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "TransportBooking" WHERE "customerCompanyId" = ${c.id}::uuid AND to_char(CASE WHEN direction = 'IN' THEN "windowEnd" ELSE "windowStart" END AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') NOT IN ('09:00', '18:00')`;

    const us = await company('generator US', 'America/New_York');
    const ups = await passengers(us.id, 20);
    const usShift = await schedules.createShift(us.ctx, { name: 'NY day', sitePoiId: us.office, startMin: 9 * 60, endMin: 17 * 60, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'America/New_York' });
    const usCreated = await schedules.createSchedules(us.ctx, { profileIds: ups, shiftId: usShift.id, directions: ['IN'], pickupMode: 'HOME', validFrom: '2027-10-29', validTo: '2027-11-11' });
    const usFrom = Date.parse('2027-10-29T04:00:00Z'); // 00:00 EDT Fri 29 Oct 2027; DST ends Sun 7 Nov 2027
    let usMade = 0;
    for (let dDay = 0; dDay < 14; dDay++) usMade += (await generator.generate(usFrom + dDay * 24 * H, usCreated.created.map((s) => s.id))).created;
    const usLocal = await prisma.$queryRaw<{ local: string; n: bigint }[]>`SELECT to_char("windowEnd" AT TIME ZONE 'America/New_York', 'HH24:MI') AS local, count(*) AS n FROM "TransportBooking" WHERE "customerCompanyId" = ${us.id}::uuid GROUP BY 1`;
    const usUtc = await prisma.$queryRaw<{ utc: string; n: bigint }[]>`SELECT to_char("windowEnd" AT TIME ZONE 'UTC', 'HH24:MI') AS utc, count(*) AS n FROM "TransportBooking" WHERE "customerCompanyId" = ${us.id}::uuid GROUP BY 1 ORDER BY 1`;

    const summary = { ist: { schedules: 400, generated: made, secondRun: again, total, needsLocation, skippedForException: skipped, cancelledByArchive: archived, wrongLocalTime: Number(wrongTime[0].n), generateMs: genMs }, us: { generated: usMade, local: usLocal.map((r) => [r.local, Number(r.n)]), utc: usUtc.map((r) => [r.utc, Number(r.n)]) } };
    console.log(JSON.stringify(summary, null, 2));
    expect(made).toBe(200 * 2 * 5); // Mon–Fri, IN + OUT
    expect(again).toBe(0);
    expect(total).toBe(2000);
    expect(needsLocation).toBe(0);
    expect(skipped).toBe(10);
    expect(archived).toBe(5 * 5);
    expect(Number(wrongTime[0].n)).toBe(0);
    expect(usMade).toBe(20 * 14);
    expect(summary.us.local).toEqual([['09:00', 280]]);
    expect(summary.us.utc).toEqual([['13:00', 180], ['14:00', 100]]); // 9 EDT days, 5 EST days
  });
});
