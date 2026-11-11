/**
 * ETMS E3 test gate (12 §5 E3 exit criteria; WP 3.8 harness) on a real, freshly migrated PostgreSQL. It automates
 * what the independent QA run of 2026-11-11 did by hand: the 200-passenger recurring week (IST) and US DST weeks,
 * double submit, 8-way parallel capacity, the booking burst, passenger visibility, GPS-never-boards, tenant / branch
 * isolation and GraphHopper up / stopped / hanging (through a local stub, never an outside map host).
 *
 * Not part of the normal run (testRegex is *.spec.ts). Run it through the gate script, which creates and drops a
 * scratch `veetrax_e3h_*_test` database (apps/api/scripts/etms-e2e/README.md):
 *   npm run etms:gate -w @veetracer/api
 * or by hand against an already migrated scratch DB:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_e3h_x_test npx jest --testRegex 'etms-e3-gate\.db-test\.ts$' --runInBand
 *
 * Test names carry the exit criterion they prove (`[AC1]` … `[AC9]` = doc 12 §5 E3 exit criteria 1–9, `[ISO]` =
 * tenant / branch isolation; see the gate script's map). Tests named `[pending secfix Bn]` assert the behaviour after
 * the E3 security fixes (branch `etms/e3-secfix`, QA defects B1–B5); they are skipped unless `ETMS_E3_SECFIX=1` (gate:
 * `--secfix`). Tests named `[known defect Hn]` cover defects this harness found outside that scope (README); skipped
 * unless `ETMS_E3_KNOWN_DEFECTS=1` (gate: `--known-defects`). Synthetic tenants only (tag `e3h-…`); every company the
 * suite creates is purged again with the purge planner in afterAll.
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { DispatchChangeOp } from '@veetracer/shared';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { planPurge, rootCondition, stepSql, type Catalog, type FkEdge } from '../purge/purge-plan';
import { PURGE_EVIDENCE_WRITE } from '../purge/purge.service';
import { RoutingService } from '../routing/routing.service';
import { addDays, isoWeekday, localDayKey, zonedTimeToUtc } from '../summarizer/tz';
import { dbDescribe } from '../test/scratch-db';
import { BookingGeneratorService, SCHEDULE_ARCHIVED_REASON, SCHEDULE_CHANGED_REASON, SKIPPED_REASON } from './dispatch/booking-generator.service';
import { BookingsService } from './dispatch/bookings.service';
import { DispatchService } from './dispatch/dispatch.service';
import { MeTransportService } from './dispatch/me-transport.service';
import { SchedulesService } from './dispatch/schedules.service';
import { TripLiveService } from './dispatch/trip-live';
import { TripsService } from './dispatch/trips.service';
import { PeopleService } from './people/people.service';
import { planE3Synthetic, seedE3Synthetic, standardE3Plan, US_SHIFTS, type E3Company, type E3CompanySpec } from './testing/e3-synthetic';
import { GraphHopperStub } from './testing/graphhopper-stub';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
/** Tests that need the etms/e3-secfix fixes (QA B1–B5) run only when ETMS_E3_SECFIX=1. */
const secfix = process.env.ETMS_E3_SECFIX === '1' ? it : it.skip;
/**
 * Defects the harness found that are NOT in the etms/e3-secfix scope (see the gate README, "Known defects"): skipped
 * unless ETMS_E3_KNOWN_DEFECTS=1 (gate: --known-defects); turn on once fixed.
 */
const known = process.env.ETMS_E3_KNOWN_DEFECTS === '1' ? it : it.skip;

const H = 3_600_000;
const TAG = `e3h-${Date.now().toString(36)}`;

type Tx = Prisma.TransactionClient;
type Ctx = never;

/** Coded outcome of a service call: 'OK', the E3 error code, or the HTTP status for uncoded errors. */
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `unexpected: ${String(e)}`),
  );
const statusOf = (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e: unknown) => (e instanceof HttpException ? e.getStatus() : -1));
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

d(`ETMS E3 gate (WP 3.8) on ${dbName}`, () => {
  jest.setTimeout(600_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const companies: string[] = [];
  let partnerId = '';
  let ownPartner = false;
  const stub = new GraphHopperStub();

  // Valkey stand-in: no live fixes, no route cache; eval throws so the booking rate limiter uses its in-process window.
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey in the gate')), publish: async () => 1 } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const generator = new BookingGeneratorService(prisma as never, redis as never);
  const schedules = new SchedulesService(prisma as never, audit, generator);
  const bookings = new BookingsService(prisma as never, audit, redis as never);
  const people = new PeopleService(prisma as never, audit, redis as never, null as never, null as never);
  const me = new MeTransportService(prisma as never, people, redis as never);

  /** RoutingService as the API builds it: ROUTER_URL is read at construction (null = routing not configured). */
  function routingFor(url: string | null): RoutingService {
    const saved = { url: process.env.ROUTER_URL, engine: process.env.ROUTER_ENGINE };
    if (url) process.env.ROUTER_URL = url;
    else delete process.env.ROUTER_URL;
    process.env.ROUTER_ENGINE = 'graphhopper';
    try {
      return new RoutingService(redis as never);
    } finally {
      if (saved.url === undefined) delete process.env.ROUTER_URL;
      else process.env.ROUTER_URL = saved.url;
      if (saved.engine === undefined) delete process.env.ROUTER_ENGINE;
      else process.env.ROUTER_ENGINE = saved.engine;
    }
  }
  function services(routing: RoutingService) {
    const dispatch = new DispatchService(prisma as never, audit, routing, live, redis as never);
    const trips = new TripsService(prisma as never, audit, plannedTrips, dispatch, live);
    return { dispatch, trips };
  }
  const { dispatch, trips } = services(routingFor(null));

  const ctxOf = (c: Pick<E3Company, 'id' | 'features'>, o: { userId?: string; branchIds?: string[] } = {}): Ctx =>
    ({ userId: o.userId ?? randomUUID(), companyId: c.id, homeCompanyId: c.id, isSuperAdmin: false, permissions: {}, dataScope: o.branchIds ? 'ASSIGNED' : 'COMPANY', branchIds: o.branchIds ?? [], objectIds: [], features: c.features, agreements: [], ip: null }) as never;

  async function seed(plan: ReturnType<typeof planE3Synthetic>) {
    companies.push(...plan.companies.map((c) => c.id));
    await seedE3Synthetic(prisma, plan, partnerId);
    return plan.companies;
  }
  async function tenant(key: string, spec: Partial<E3CompanySpec> = {}): Promise<E3Company> {
    const [c] = await seed(planE3Synthetic({ tag: TAG, companies: [{ key, kind: 'CUSTOMER', timezone: 'Asia/Kolkata', passengers: 4, vehicles: [4], drivers: 1, ...spec }] }));
    return c;
  }
  /** An ad-hoc PENDING_ASSIGNMENT booking written directly (dispatch tests on fixed 2027 dates). */
  async function booking(c: E3Company, i: number, day: string, start: number, dir: 'IN' | 'OUT' = 'IN'): Promise<string> {
    const p = c.passengers[i];
    const id = randomUUID();
    const site = c.sites[0];
    await prisma.$executeRawUnsafe(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
      VALUES ('${id}', '${c.id}', '${p.id}', 'ADHOC', '${day}', '${dir}', '${c.timezone}', ${p.homeLat}, ${p.homeLng}, ${site.lat}, ${site.lng}, '${new Date(start).toISOString()}', '${new Date(start + 1.5 * H).toISOString()}', 'PENDING_ASSIGNMENT', now())`);
    return id;
  }
  const stopsFrom = (c: E3Company, from: number, extra: { lat: number; lng: number }[] = []) => [
    ...[{ lat: c.passengers[0].homeLat, lng: c.passengers[0].homeLng }, ...extra].map((p, i) => ({ seq: i, point: { ...p, label: `Pickup ${i + 1}` }, plannedArrival: new Date(from + i * 10 * 60_000).toISOString() })),
    { seq: extra.length + 1, point: { lat: c.sites[0].lat, lng: c.sites[0].lng, label: 'Office' }, plannedArrival: new Date(from + H).toISOString() },
  ];
  const createTrip = (c: E3Company, objectId: string, from: number, o: { driverId?: string | null; extra?: { lat: number; lng: number }[] } = {}): DispatchChangeOp => ({ op: 'CREATE_TRIP', tempId: 't', objectId, driverId: o.driverId ?? null, plannedStart: new Date(from).toISOString(), stops: stopsFrom(c, from, o.extra) });
  const addPax = (tripId: string, bookingId: string, dropSeq = 1): DispatchChangeOp => ({ op: 'ADD_PASSENGER', tripId, bookingId, pickupSeq: 0, dropSeq });
  const summary: Record<string, unknown> = {};

  beforeAll(async () => {
    const [existing] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
    if (existing) partnerId = existing.id;
    else {
      ownPartner = true;
      partnerId = (await prisma.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-e3-gate partner', 'etms-e3-gate-' || gen_random_uuid(), now()) RETURNING id`)[0].id;
    }
    await stub.start(0);
  });

  afterAll(async () => {
    await stub.stop();
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
    console.log(`E3-GATE-SUMMARY ${JSON.stringify({ tag: TAG, ...summary, companiesLeft: Number(left[0].n) })}`);
    await prisma.$disconnect();
    expect(Number(left[0].n)).toBe(0);
  });

  // ───────────────────────────── AC1: recurring weeks ─────────────────────────────

  it('[AC1] IST: 200 passengers × Mon–Fri × IN/OUT — preview 2,000, generated 2,000 (re-run 0), modify −50, archive −250, skip −10; all at 09:00 / 18:00 IST', async () => {
    const c = (await seed(planE3Synthetic({ tag: TAG, companies: [{ key: 'WEEK-IST', kind: 'CUSTOMER', timezone: 'Asia/Kolkata', passengers: 200, branches: ['North', 'South'], shifts: [{ key: 'day', name: 'Day 09:00-18:00', startMin: 540, endMin: 1080, days: [1, 2, 3, 4, 5] }] }] })))[0];
    const ctx = ctxOf(c);
    // The first Monday at least 7 days ahead (inside the 40-day resync horizon, outside the 72 h live horizon).
    let monday = addDays(localDayKey(Date.now(), 'Asia/Kolkata'), 7);
    while (isoWeekday(monday) !== 1) monday = addDays(monday, 1);
    const sunday = addDays(monday, 6);
    const weekStart = zonedTimeToUtc(monday, 0, 0, 'Asia/Kolkata');
    const weekEnd = weekStart + 7 * 24 * H;
    const created = await schedules.createSchedules(ctx, { profileIds: c.passengers.map((p) => p.id), shiftId: c.shifts[0].id, directions: ['IN', 'OUT'], pickupMode: 'HOME', validFrom: monday, validTo: sunday });
    const ids = created.created.map((s) => s.id);
    const scheduleOf = new Map(created.created.map((s) => [`${s.passenger.id}|${s.direction}`, s]));
    const preview = await schedules.preview(ctx, { from: new Date(weekStart).toISOString(), to: new Date(weekEnd).toISOString() });
    const t0 = Date.now();
    let made = 0;
    for (let i = 0; i < 7; i++) made += (await generator.generate(weekStart + i * 24 * H, ids)).created;
    const generateMs = Date.now() - t0;
    let again = 0;
    for (let i = 0; i < 7; i++) again += (await generator.generate(weekStart + i * 24 * H, ids)).created;
    const previewAfter = await schedules.preview(ctx, { from: new Date(weekStart).toISOString(), to: new Date(weekEnd).toISOString() });
    const count = (where: Prisma.TransportBookingWhereInput) => prisma.transportBooking.count({ where: { customerCompanyId: c.id, source: 'SCHEDULE', ...where } });
    const generated = await count({});

    // Modify: 50 passengers stop coming in on Fridays (days 1–4); the Friday IN booking is cancelled.
    for (const p of c.passengers.slice(0, 50)) {
      const s = scheduleOf.get(`${p.id}|IN`)!;
      await schedules.updateSchedule(ctx, s.id, { expectedVersion: s.version, days: [1, 2, 3, 4] });
    }
    const first = scheduleOf.get(`${c.passengers[0].id}|IN`)!;
    const stale = await outcome(schedules.updateSchedule(ctx, first.id, { expectedVersion: first.version, days: [1, 2, 3] }));
    const modified = await count({ status: 'CANCELLED', statusReason: SCHEDULE_CHANGED_REASON });
    // Cancel: 50 other passengers' OUT schedules archived (5 bookings each).
    for (const p of c.passengers.slice(50, 100)) await schedules.archiveSchedule(ctx, scheduleOf.get(`${p.id}|OUT`)!.id);
    const archived = await count({ status: 'CANCELLED', statusReason: SCHEDULE_ARCHIVED_REASON });
    // Exception: 10 passengers skip Wednesday's login.
    for (const p of c.passengers.slice(100, 110)) await schedules.createException(ctx, scheduleOf.get(`${p.id}|IN`)!.id, { date: addDays(monday, 2), kind: 'SKIP', reason: 'Leave' });
    const skipped = await count({ status: 'CANCELLED', statusReason: SKIPPED_REASON });
    const active = await count({ status: { not: 'CANCELLED' } });
    const fridayIn = await count({ status: { not: 'CANCELLED' }, direction: 'IN', serviceDate: new Date(`${addDays(monday, 4)}T00:00:00Z`) });
    const wrongTime = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "TransportBooking" WHERE "customerCompanyId" = ${c.id}::uuid AND to_char(CASE WHEN direction = 'IN' THEN "windowEnd" ELSE "windowStart" END AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') <> CASE WHEN direction = 'IN' THEN '09:00' ELSE '18:00' END`;
    const needsLocation = await count({ OR: [{ pickupLat: null }, { dropLat: null }] });
    const r = { week: `${monday}..${sunday}`, schedules: ids.length, previewWouldCreate: preview.wouldCreate, previewDays: preview.byDate.length, generated: made, rows: generated, secondRun: again, previewAfterWouldCreate: previewAfter.wouldCreate, previewAfterExisting: previewAfter.existing, modifiedFridayIn: modified, staleVersion: stale, archivedOut: archived, skippedWed: skipped, active, fridayIn, wrongLocalTime: Number(wrongTime[0].n), needsLocation, generateMs };
    summary.ac1Ist = r;
    console.log(JSON.stringify(r, null, 2));
    expect(r).toMatchObject({ schedules: 400, previewWouldCreate: 2000, previewDays: 10, generated: 2000, rows: 2000, secondRun: 0, previewAfterWouldCreate: 0, previewAfterExisting: 2000, modifiedFridayIn: 50, staleVersion: 'VERSION_CONFLICT', archivedOut: 250, skippedWed: 10, active: 2000 - 50 - 250 - 10, fridayIn: 150, wrongLocalTime: 0, needsLocation: 0 });
  });

  /** One US DST fortnight: 100 passengers on the day shift (Mon–Fri) and 100 on the every-night shift (22:00–06:00), IN + OUT. */
  async function usFortnight(key: string, first: string) {
    const c = (await seed(planE3Synthetic({ tag: TAG, companies: [{ key, kind: 'CUSTOMER', timezone: 'America/Chicago', passengers: 200, shifts: [US_SHIFTS[0], US_SHIFTS[2]] }] })))[0];
    const ctx = ctxOf(c);
    const last = addDays(first, 13);
    const day = await schedules.createSchedules(ctx, { profileIds: c.passengers.slice(0, 100).map((p) => p.id), shiftId: c.shifts[0].id, directions: ['IN', 'OUT'], pickupMode: 'HOME', validFrom: first, validTo: last });
    const night = await schedules.createSchedules(ctx, { profileIds: c.passengers.slice(100).map((p) => p.id), shiftId: c.shifts[1].id, directions: ['IN', 'OUT'], pickupMode: 'HOME', validFrom: first, validTo: last });
    const ids = [...day.created, ...night.created].map((s) => s.id);
    const from = zonedTimeToUtc(first, 0, 0, 'America/Chicago');
    let made = 0;
    for (let i = 0; i < 14; i++) made += (await generator.generate(from + i * 24 * H, ids)).created;
    // Anchor = login (IN windowEnd) / logout (OUT windowStart), read in UTC and in local time by PostgreSQL's own tz rules.
    const rows = await prisma.$queryRaw<{ shift: string; direction: string; utc: string; local: string; n: bigint }[]>`
      SELECT s.name AS shift, b.direction::text AS direction,
             to_char(CASE WHEN b.direction = 'IN' THEN b."windowEnd" ELSE b."windowStart" END AT TIME ZONE 'UTC', 'HH24:MI') AS utc,
             to_char(CASE WHEN b.direction = 'IN' THEN b."windowEnd" ELSE b."windowStart" END AT TIME ZONE 'America/Chicago', 'HH24:MI') AS local,
             count(*) AS n
      FROM "TransportBooking" b JOIN "TransportShift" s ON s.id = b."shiftId"
      WHERE b."customerCompanyId" = ${c.id}::uuid GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`;
    return { made, rows: rows.map((r) => `${r.shift.split(' ')[0]} ${r.direction} ${r.local} local = ${r.utc}Z × ${Number(r.n)}`) };
  }

  it('[AC1] US DST (America/Chicago): spring 2027 fortnight — 4,800 legs, local times fixed, UTC moves by 1 h on 14 Mar', async () => {
    const r = await usFortnight('DST-SPRING', '2027-03-08');
    summary.ac1UsSpring = r;
    console.log(JSON.stringify(r, null, 2));
    expect(r.made).toBe(100 * 2 * 10 + 100 * 2 * 14);
    expect(r.rows).toEqual([
      'Day IN 07:00 local = 12:00Z × 500', // 15–19 Mar CDT
      'Day IN 07:00 local = 13:00Z × 500', // 8–12 Mar CST
      'Day OUT 16:00 local = 21:00Z × 500',
      'Day OUT 16:00 local = 22:00Z × 500',
      'Night IN 22:00 local = 03:00Z × 800', // service dates 14–21 Mar (CDT)
      'Night IN 22:00 local = 04:00Z × 600', // 8–13 Mar (CST)
      'Night OUT 06:00 local = 11:00Z × 900', // logout 14–22 Mar (CDT), incl. the night of the change
      'Night OUT 06:00 local = 12:00Z × 500', // logout 9–13 Mar (CST)
    ]);
  });

  it('[AC1] US DST (America/Chicago): fall 2027 fortnight — 4,800 legs, local times fixed, UTC moves by 1 h on 7 Nov', async () => {
    const r = await usFortnight('DST-FALL', '2027-11-01');
    summary.ac1UsFall = r;
    console.log(JSON.stringify(r, null, 2));
    expect(r.made).toBe(100 * 2 * 10 + 100 * 2 * 14);
    expect(r.rows).toEqual([
      'Day IN 07:00 local = 12:00Z × 500', // 1–5 Nov CDT
      'Day IN 07:00 local = 13:00Z × 500', // 8–12 Nov CST
      'Day OUT 16:00 local = 21:00Z × 500',
      'Day OUT 16:00 local = 22:00Z × 500',
      'Night IN 22:00 local = 03:00Z × 600', // service dates 1–6 Nov (CDT)
      'Night IN 22:00 local = 04:00Z × 800', // 7–14 Nov (CST)
      'Night OUT 06:00 local = 11:00Z × 500', // logout 2–6 Nov (CDT)
      'Night OUT 06:00 local = 12:00Z × 900', // logout 7–15 Nov (CST), incl. the night of the change
    ]);
  });

  // ───────────────────────────── AC2: double submit ─────────────────────────────

  const bookingBody = (c: E3Company, i: number, day: string) => ({ passengerId: c.passengers[i].id, serviceDate: day, direction: 'IN' as const, windowStart: `${day}T02:00:00.000Z`, windowEnd: `${day}T03:30:00.000Z` });
  /** Response of a create: the booking id + REPLAY / NEW, or the error code. */
  const created = (p: Promise<{ value: { id: string }; replay: boolean }>) => p.then((x) => `${x.replay ? 'REPLAY' : 'NEW'} ${x.value.id}`, (e: unknown) => outcome(Promise.reject(e)));

  it('[AC2] double submit: 5 parallel + 50 retried creates with one key = exactly 1 booking; other body 422; no key 400; second key 409', async () => {
    const c = await tenant('DOUBLE');
    const ctx = ctxOf(c);
    const day = addDays(localDayKey(Date.now(), 'Asia/Kolkata'), 5);
    const body = bookingBody(c, 0, day);
    const key = randomUUID();
    const parallel = await Promise.all(Array.from({ length: 5 }, () => created(bookings.create(ctx, body, key))));
    const retries = await Promise.all(Array.from({ length: 50 }, () => created(bookings.create(ctx, body, key))));
    const reused = await outcome(bookings.create(ctx, { ...body, windowEnd: `${day}T03:45:00.000Z` }, key));
    const noKey = await outcome(bookings.create(ctx, body, undefined));
    const otherKey = await outcome(bookings.create(ctx, body, randomUUID()));
    const rows = await prisma.transportBooking.findMany({ where: { customerCompanyId: c.id }, select: { id: true } });
    const r = {
      rows: rows.length,
      parallelNew: parallel.filter((x) => x === `NEW ${rows[0]?.id}`).length,
      // Losers of the parallel race: a replay of the same booking (or, known defect H1, 409 BOOKING_DUPLICATE).
      parallelOther: parallel.every((x) => x === `NEW ${rows[0]?.id}` || x === `REPLAY ${rows[0]?.id}` || x === 'BOOKING_DUPLICATE'),
      retries: tally(retries),
      reused,
      noKey,
      otherKey,
    };
    summary.ac2Bookings = { ...r, parallel: tally(parallel.map((x) => x.split(' ')[0])) };
    expect(r).toEqual({ rows: 1, parallelNew: 1, parallelOther: true, retries: { [`REPLAY ${rows[0].id}`]: 50 }, reused: 'IDEMPOTENCY_KEY_REUSED', noKey: 'IDEMPOTENCY_KEY_REQUIRED', otherKey: 'BOOKING_DUPLICATE' });
  });

  known('[AC2][known defect H1] parallel double submit: every request with the key gets the same booking back (no 409 BOOKING_DUPLICATE for the loser)', async () => {
    const c = await tenant('DOUBLE-H1', { passengers: 10 });
    const ctx = ctxOf(c);
    const day = addDays(localDayKey(Date.now(), 'Asia/Kolkata'), 6);
    // Ten passengers, five parallel requests each: the race shows up on most runs.
    const res = await Promise.all(c.passengers.map((_, i) => Promise.all(Array.from({ length: 5 }, () => created(bookings.create(ctx, bookingBody(c, i, day), `h1-${c.passengers[i].id}`))))));
    expect(res.flat().filter((x) => !/^(NEW|REPLAY) /.test(x))).toEqual([]);
  });

  it('[AC2] change-set publish with one Idempotency-Key: sequential replay = same result; other body 422; no key 400', async () => {
    const c = await tenant('DOUBLE-CS');
    const ctx = ctxOf(c);
    const t0 = Date.parse('2027-02-08T02:00:00Z');
    const b = await booking(c, 0, '2027-02-08', t0);
    const input = { serviceDate: '2027-02-08', direction: 'IN' as const, changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', b)] };
    const key = randomUUID();
    const firstRun = await dispatch.submit(ctx, input, key);
    const replays = await Promise.all(Array.from({ length: 5 }, () => dispatch.submit(ctx, input, key)));
    const reused = await outcome(dispatch.submit(ctx, { ...input, reason: 'other' }, key));
    const noKey = await outcome(dispatch.submit(ctx, input, undefined));
    const r = {
      firstReplay: firstRun.replay,
      replays: replays.filter((x) => x.replay && x.value.changeSetId === firstRun.value.changeSetId).length,
      reused,
      noKey,
      plannedTrips: await prisma.plannedTrip.count({ where: { companyId: c.id } }),
      ledgerRows: await prisma.transportChangeSet.count({ where: { companyId: c.id } }),
    };
    summary.ac2ChangeSet = r;
    expect(r).toEqual({ firstReplay: false, replays: 5, reused: 'IDEMPOTENCY_KEY_REUSED', noKey: 'IDEMPOTENCY_KEY_REQUIRED', plannedTrips: 1, ledgerRows: 1 });
  });

  known('[AC2][known defect H2] change-set publish: parallel submits with one key — the losers get the winner\'s result back (not VEHICLE_BUSY)', async () => {
    const c = await tenant('DOUBLE-H2');
    const ctx = ctxOf(c);
    const t0 = Date.parse('2027-02-05T02:00:00Z');
    const b = await booking(c, 0, '2027-02-05', t0);
    const input = { serviceDate: '2027-02-05', direction: 'IN' as const, changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', b)] };
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => dispatch.submit(ctx, input, key).then((x) => (x.replay ? 'REPLAY' : 'PUBLISHED'), (e: unknown) => outcome(Promise.reject(e)))));
    expect(tally(res)).toEqual({ PUBLISHED: 1, REPLAY: 3 });
  });

  it('[AC2] change-set publish: 4 parallel submits with one key publish exactly once', async () => {
    const c = await tenant('DOUBLE-CS-PAR');
    const ctx = ctxOf(c);
    const t0 = Date.parse('2027-02-09T02:00:00Z');
    const b = await booking(c, 0, '2027-02-09', t0);
    const input = { serviceDate: '2027-02-09', direction: 'IN' as const, changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', b)] };
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => dispatch.submit(ctx, input, key).then((x) => (x.replay ? 'REPLAY' : 'PUBLISHED'), (e: unknown) => outcome(Promise.reject(e)))));
    const plannedTrips = await prisma.plannedTrip.count({ where: { companyId: c.id } });
    summary.ac2ChangeSetParallel = { results: tally(res), plannedTrips };
    // Whatever the losers saw, the database holds exactly one publish.
    expect(plannedTrips).toBe(1);
    expect(res.filter((x) => x === 'PUBLISHED')).toHaveLength(1);
  });

  // ───────────────────────────── AC3 / AC4: atomic publish, capacity ─────────────────────────────

  it('[AC3] publish is atomic: PlannedTrip (ETMS, no route) + header + passengers + events together; a refused change set leaves nothing', async () => {
    const c = await tenant('ATOMIC', { passengers: 6, vehicles: [3, 6] });
    const ctx = ctxOf(c);
    const day = '2027-02-10';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const bs = await Promise.all([0, 1, 2, 3, 4].map((i) => booking(c, i, day, t0)));
    const refused = await outcome(dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), ...bs.slice(0, 4).map((b) => addPax('t', b))] }, randomUUID()));
    const afterRefused = { plannedTrips: await prisma.plannedTrip.count({ where: { companyId: c.id } }), assigned: await prisma.transportBooking.count({ where: { customerCompanyId: c.id, status: 'ASSIGNED' } }), changeSets: await prisma.transportChangeSet.count({ where: { companyId: c.id } }) };
    const ok = await dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', bs[0]), addPax('t', bs[1])] }, randomUUID());
    const trip = await prisma.transportTrip.findUniqueOrThrow({ where: { id: ok.value.trips[0].id }, include: { plannedTrip: true, passengers: true, events: true } });
    // A booking already seated, given to a second trip in the same change set as a new trip: all of it rolls back.
    const twice = await outcome(dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[1].id, t0), addPax('t', bs[2]), addPax('t', bs[0])] }, randomUUID()));
    const r = {
      refused,
      afterRefused,
      trip: { origin: trip.plannedTrip?.origin, routeId: trip.plannedTrip?.routeId, ptStatus: trip.plannedTrip?.status, seatCapacity: trip.seatCapacity, occupied: trip.occupiedSeats, version: trip.version, published: !!trip.publishedAt, passengers: trip.passengers.length, events: tally(trip.events.map((e) => e.kind)) },
      twice,
      afterTwice: { plannedTrips: await prisma.plannedTrip.count({ where: { companyId: c.id } }), b2: (await prisma.transportBooking.findUniqueOrThrow({ where: { id: bs[2] } })).status },
    };
    summary.ac3 = r;
    expect(r).toEqual({
      refused: 'CAPACITY_EXCEEDED',
      afterRefused: { plannedTrips: 0, assigned: 0, changeSets: 0 },
      trip: { origin: 'ETMS', routeId: null, ptStatus: 'SCHEDULED', seatCapacity: 3, occupied: 2, version: 1, published: true, passengers: 2, events: { PUBLISHED: 1, PASSENGER_ADDED: 2 } },
      twice: 'INVALID_STATE',
      afterTwice: { plannedTrips: 1, b2: 'PENDING_ASSIGNMENT' },
    });
  });

  it('[AC4] capacity under 8-way parallel change sets: 1 OK / 7 VERSION_CONFLICT; retrying workers seat exactly the capacity', async () => {
    const c = await tenant('CAPACITY', { passengers: 9, vehicles: [3] });
    const ctx = ctxOf(c);
    const day = '2027-02-11';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const bs = await Promise.all(c.passengers.map((_, i) => booking(c, i, day, t0)));
    const r0 = await dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0)] }, randomUUID());
    const tripId = r0.value.trips[0].id;
    const round1 = await Promise.all(bs.slice(0, 8).map((b) => outcome(dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [addPax(tripId, b)], expectedVersions: { [tripId]: 1 } }, randomUUID()))));
    const round2 = await Promise.all(
      bs.slice(1, 9).map(async (b) => {
        for (let i = 0; i < 40; i++) {
          const t = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } });
          const res = await outcome(dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [addPax(tripId, b)], expectedVersions: { [tripId]: t.version } }, randomUUID()));
          if (res !== 'VERSION_CONFLICT') return res;
        }
        return 'GAVE_UP';
      }),
    );
    const trip = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } });
    const seats = await prisma.transportTripPassenger.aggregate({ where: { tripId, status: { not: 'CANCELLED' } }, _sum: { seats: true }, _count: true });
    const r = { round1: tally(round1), round2: tally(round2), occupiedSeats: trip.occupiedSeats, seatCapacity: trip.seatCapacity, activeRows: seats._count, sumSeats: seats._sum.seats };
    summary.ac4 = r;
    console.log(JSON.stringify(r));
    expect(r.round1).toEqual({ OK: 1, VERSION_CONFLICT: 7 });
    expect(r.round2.OK).toBe(2);
    expect((r.round2.CAPACITY_EXCEEDED ?? 0) + (r.round2.INVALID_STATE ?? 0)).toBe(6);
    expect([r.occupiedSeats, r.activeRows, r.sumSeats]).toEqual([3, 3, 3]);
  });

  it('[AC4] one vehicle / one driver, two parallel overlapping publishes: exactly one wins (VEHICLE_BUSY / DRIVER_BUSY)', async () => {
    const c = await tenant('OVERLAP', { vehicles: [4, 4], drivers: 1 });
    const ctx = ctxOf(c);
    const day = '2027-02-12';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const sameVehicle = await Promise.all([0, 15].map((m) => outcome(dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0 + m * 60_000)] }, randomUUID()))));
    const later = t0 + 6 * H;
    const sameDriver = await Promise.all(c.vehicles.map((v, i) => outcome(dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, v.id, later + i * 600_000, { driverId: c.drivers[0].id })] }, randomUUID()))));
    summary.ac4Overlap = { sameVehicle, sameDriver };
    expect(sameVehicle.sort()).toEqual(['OK', 'VEHICLE_BUSY']);
    expect(sameDriver.sort()).toEqual(['DRIVER_BUSY', 'OK']);
  });

  // ───────────────────────────── AC5 / AC6: passenger view, GPS never boards ─────────────────────────────

  it('[AC5] passenger sees only their own leg (co-riders as a count), another trip is 404, the vehicle only inside the window', async () => {
    const c = await tenant('ME', { passengers: 3, logins: 3, vehicles: [4, 4] });
    const ctx = ctxOf(c);
    const day = '2027-02-15';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const bs = await Promise.all([0, 1, 2].map((i) => booking(c, i, day, t0)));
    const t1 = await dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', bs[0]), addPax('t', bs[1])] }, randomUUID());
    const t2 = await dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[1].id, t0), addPax('t', bs[2])] }, randomUUID());
    const p0 = ctxOf(c, { userId: c.passengers[0].userId! });
    const mine = await me.trips(p0, { from: day, to: day });
    const text = JSON.stringify(mine);
    const r = {
      trips: mine.map((t) => t.id),
      coRiders: mine[0]?.coRiders,
      leaksName: text.includes(c.passengers[1].displayName) || text.includes(c.passengers[2].displayName),
      leaksHome: text.includes(String(c.passengers[1].homeLat)),
      otherTrip: await statusOf(me.trip(p0, t2.value.trips[0].id)),
      vehicleTomorrow: await me.vehicle(p0, t1.value.trips[0].id),
      dispatcherNotPassenger: await outcome(me.trips(ctx, { from: day, to: day })),
    };
    summary.ac5 = { ...r, trips: r.trips.length };
    expect(r).toEqual({ trips: [t1.value.trips[0].id], coRiders: 1, leaksName: false, leaksHome: false, otherTrip: 404, vehicleTomorrow: { visible: false, reason: 'OUTSIDE_WINDOW' }, dispatcherNotPassenger: 'NOT_A_PASSENGER' });
  });

  it('[AC6] a GPS stop arrival leaves every passenger PENDING; only a dispatcher (WEB) outcome boards; the DB refuses GPS/SYSTEM outcomes', async () => {
    const c = await tenant('GPS', { passengers: 2 });
    const ctx = ctxOf(c);
    const day = '2027-02-16';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const bs = await Promise.all([0, 1].map((i) => booking(c, i, day, t0)));
    const r0 = await dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), ...bs.map((b) => addPax('t', b))] }, randomUUID());
    const tripId = r0.value.trips[0].id;
    const ptId = r0.value.trips[0].plannedTripId!;
    await trips.start(ctx, tripId, {});
    // What the processor's tracker writes on GPS arrivals / departures (it touches no ETMS table).
    await prisma.plannedTripStop.updateMany({ where: { tripId: ptId }, data: { status: 'ARRIVED', actualArrival: new Date() } });
    const afterGps = await prisma.transportTripPassenger.findMany({ where: { tripId }, orderBy: { id: 'asc' } });
    const forged = await prisma.$executeRawUnsafe(`UPDATE "TransportTripPassenger" SET status = 'BOARDED', "boardedAt" = now(), "outcomeSource" = 'GPS' WHERE id = '${afterGps[0].id}'`).then(() => 'accepted', (e: unknown) => (/outcome_source_check/.test(String(e)) ? 'refused' : String(e)));
    const t = await trips.outcome(ctx, tripId, afterGps[0].id, { outcome: 'BOARDED' });
    const r = { afterGps: afterGps.map((p) => p.status), forged, boarded: t.passengers.find((p) => p.id === afterGps[0].id)?.outcomeSource, other: t.passengers.find((p) => p.id === afterGps[1].id)?.status };
    summary.ac6 = r;
    expect(r).toEqual({ afterGps: ['PENDING', 'PENDING'], forged: 'refused', boarded: 'WEB', other: 'PENDING' });
  });

  // ───────────────────────────── AC8: burst ─────────────────────────────

  it('[AC8] booking burst (indicative, T3): 200 parallel creates by 4 dispatchers, 0 errors; 50 key retries → 0 duplicates; the 61st create in a minute → 429', async () => {
    const [ist] = await seed(standardE3Plan(TAG, 200));
    const day = addDays(localDayKey(Date.now(), 'Asia/Kolkata'), 3);
    const dispatchers = [0, 1, 2, 3].map(() => ctxOf(ist));
    const bodies = ist.passengers.map((p) => ({ passengerId: p.id, serviceDate: day, direction: 'IN' as const, windowStart: `${day}T02:00:00.000Z`, windowEnd: `${day}T03:30:00.000Z` }));
    const keys = bodies.map(() => randomUUID());
    const lat: number[] = [];
    const wall0 = Date.now();
    const res = await Promise.all(
      bodies.map(async (b, i) => {
        const t = Date.now();
        const o = await outcome(bookings.create(dispatchers[i % 4], b, keys[i]));
        lat.push(Date.now() - t);
        return o;
      }),
    );
    const wallMs = Date.now() - wall0;
    const retries = await Promise.all(bodies.slice(0, 50).map((b, i) => bookings.create(dispatchers[i % 4], b, keys[i]).then((x) => (x.replay ? 'REPLAY' : 'NEW'), () => 'ERROR')));
    const rows = await prisma.transportBooking.count({ where: { customerCompanyId: ist.id } });
    // Rate limit (60 / min per user): a fresh user; start early in a minute so the window cannot roll over mid-loop.
    if (Date.now() % 60_000 > 40_000) await sleep(60_000 - (Date.now() % 60_000) + 200);
    const heavy = ctxOf(ist);
    const limited: string[] = [];
    for (let i = 0; i < 61; i++) limited.push(await outcome(bookings.create(heavy, bodies[i % 200], randomUUID())));
    const r = { creates: tally(res), wallMs, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), retries: tally(retries), rows, first60: tally(limited.slice(0, 60)), call61: limited[60] };
    summary.ac8 = r;
    console.log(JSON.stringify(r));
    expect(r.creates).toEqual({ OK: 200 });
    expect(r.retries).toEqual({ REPLAY: 50 });
    expect(r.rows).toBe(200);
    expect(r.first60).toEqual({ BOOKING_DUPLICATE: 60 });
    expect(r.call61).toBe('RATE_LIMITED');
  });

  // ───────────────────────────── AC9: GraphHopper up / stopped / hanging ─────────────────────────────

  describe('[AC9] routing through the GraphHopper stub', () => {
    let c: E3Company;
    let ctx: Ctx;
    const day = '2027-02-17';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    let bs: string[] = [];
    let tripId = '';
    const up = () => services(routingFor(stub.url));

    beforeAll(async () => {
      c = await tenant('ROUTING', { passengers: 6, vehicles: [6, 6, 6, 6] });
      ctx = ctxOf(c);
      bs = await Promise.all(c.passengers.map((_, i) => booking(c, i, day, t0)));
    });
    afterEach(async () => {
      stub.mode = 'up';
      if (!stub.running) await stub.start();
    });

    it('[AC9] GraphHopper up: publish stores the road path; candidates give a ROAD ETA from the trip stop', async () => {
      stub.reset();
      const r = await up().dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', bs[0])] }, randomUUID());
      tripId = r.value.trips[0].id;
      const pt = await prisma.plannedTrip.findUniqueOrThrow({ where: { id: r.value.trips[0].plannedTripId! } });
      const cand = await up().dispatch.candidates(ctx, { bookingIds: [bs[1]] });
      const trip = cand.candidates.find((x) => x.tripId === tripId)!;
      const board = await up().dispatch.board(ctx, { serviceDate: day });
      const res = { path: pt.path !== null, routingAvailable: cand.routingAvailable, degraded: cand.degraded, tripEta: { model: trip.eta.model, from: (trip.eta as { from?: string }).from, hasAt: trip.eta.at !== null, durationSec: (trip.eta as { durationSec?: number }).durationSec }, board: board.routingAvailable, hits: { ...stub.hits } };
      summary.ac9Up = res;
      expect(res).toMatchObject({ path: true, routingAvailable: true, degraded: null, tripEta: { model: 'ROAD', from: 'TRIP_STOP', hasAt: true }, board: true });
      expect(res.tripEta.durationSec).toBeGreaterThan(0);
    });

    it('[AC9] GraphHopper stopped (ROUTER_URL still set): every ETA is null — nothing invented; publish still works fast without a path', async () => {
      await stub.stop();
      const svc = up();
      const t = Date.now();
      const cand = await svc.dispatch.candidates(ctx, { bookingIds: [bs[1]] });
      const candMs = Date.now() - t;
      const t1 = Date.now();
      const pub = await svc.dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[1].id, t0), addPax('t', bs[2])] }, randomUUID());
      const publishMs = Date.now() - t1;
      const pt = await prisma.plannedTrip.findUniqueOrThrow({ where: { id: pub.value.trips[0].plannedTripId! } });
      const res = { invented: cand.candidates.filter((x) => x.eta.at !== null || (x.eta as { durationSec?: number }).durationSec !== undefined).length, reasons: tally(cand.candidates.map((x) => String((x.eta as { degraded?: string }).degraded ?? 'none'))), candMs, publishMs, path: pt.path };
      summary.ac9Stopped = res;
      console.log(JSON.stringify(res));
      expect(res.invented).toBe(0);
      expect(res.path).toBeNull();
      expect(res.publishMs).toBeLessThan(3_000);
    });

    secfix('[AC9][pending secfix B2] GraphHopper stopped: the board and candidates report routing unavailable (not "Routing OK" / NO_ROUTE)', async () => {
      await stub.stop();
      const svc = up();
      const board = await svc.dispatch.board(ctx, { serviceDate: day });
      const cand = await svc.dispatch.candidates(ctx, { bookingIds: [bs[1]] });
      expect({ board: board.routingAvailable, cand: cand.routingAvailable, degraded: cand.degraded }).toEqual({ board: false, cand: false, degraded: 'ROUTING_UNAVAILABLE' });
      expect(cand.candidates.every((x) => x.eta.at === null)).toBe(true);
    });

    it('[AC9] GraphHopper hanging: candidates and publish still answer, with no ETA / path invented (timings recorded)', async () => {
      stub.mode = 'hang';
      const svc = up();
      const t = Date.now();
      const cand = await svc.dispatch.candidates(ctx, { bookingIds: [bs[3]] });
      const candMs = Date.now() - t;
      const t1 = Date.now();
      const pub = await svc.dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[2].id, t0, { extra: [{ lat: c.passengers[3].homeLat, lng: c.passengers[3].homeLng }] }), addPax('t', bs[3], 2)] }, randomUUID());
      const publishMs = Date.now() - t1;
      const pt = await prisma.plannedTrip.findUniqueOrThrow({ where: { id: pub.value.trips[0].plannedTripId! } });
      const res = { invented: cand.candidates.filter((x) => x.eta.at !== null).length, candMs, publishMs, path: pt.path, status: pub.value.status };
      summary.ac9Hang = res;
      console.log(JSON.stringify(res));
      expect(res.invented).toBe(0);
      expect(res.path).toBeNull();
      expect(res.status).toBe('PUBLISHED');
    });

    secfix('[AC9][pending secfix B3] GraphHopper hanging: publishing does not wait for routing (< 3 s; 02 §5.4)', async () => {
      stub.mode = 'hang';
      const svc = up();
      const t1 = Date.now();
      await svc.dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[3].id, t0, { extra: [{ lat: c.passengers[4].homeLat, lng: c.passengers[4].homeLng }] }), addPax('t', bs[4], 2)] }, randomUUID());
      expect(Date.now() - t1).toBeLessThan(3_000);
    });

    it('[AC9] routing not configured (ROUTER_URL unset): degraded ROUTING_UNAVAILABLE, null ETAs', async () => {
      const cand = await dispatch.candidates(ctx, { bookingIds: [bs[5]] });
      const board = await dispatch.board(ctx, { serviceDate: day });
      expect({ board: board.routingAvailable, cand: cand.routingAvailable, degraded: cand.degraded, invented: cand.candidates.filter((x) => x.eta.at !== null).length }).toEqual({ board: false, cand: false, degraded: 'ROUTING_UNAVAILABLE', invented: 0 });
      expect(tripId).not.toBe('');
    });
  });

  // ───────────────────────────── isolation (doc 11 §3), progression ─────────────────────────────

  it('[ISO] tenant isolation: another company cannot see, rank or seat a booking (404, never a hint)', async () => {
    const [a, other] = await seed(
      planE3Synthetic({
        tag: TAG,
        companies: [
          { key: 'ISO-A', kind: 'CUSTOMER', timezone: 'Asia/Kolkata', passengers: 2, vehicles: [4] },
          { key: 'ISO-B', kind: 'CONTROL', timezone: 'Asia/Kolkata', passengers: 1, vehicles: [4] },
        ],
      }),
    );
    const day = '2027-02-18';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const b = await booking(a, 0, day, t0);
    const bCtx = ctxOf(other);
    const r = {
      get: await statusOf(bookings.get(bCtx, b)),
      candidates: await outcome(dispatch.candidates(bCtx, { bookingIds: [b] })),
      seat: await outcome(dispatch.submit(bCtx, { serviceDate: day, direction: 'IN', changes: [createTrip(other, other.vehicles[0].id, t0), addPax('t', b)] }, randomUUID())),
      boardQueue: (await dispatch.board(bCtx, { serviceDate: day })).queue.length,
      vehicleOfA: await outcome(dispatch.submit(bCtx, { serviceDate: day, direction: 'IN', changes: [createTrip(other, a.vehicles[0].id, t0)] }, randomUUID())),
      bookingAfter: (await prisma.transportBooking.findUniqueOrThrow({ where: { id: b } })).status,
    };
    summary.ac10Tenant = r;
    expect(r).toEqual({ get: 404, candidates: 'NOT_FOUND', seat: 'NOT_FOUND', boardQueue: 0, vehicleOfA: 'NOT_FOUND', bookingAfter: 'PENDING_ASSIGNMENT' });
  });

  describe('[ISO] branch scope (ASSIGNED dispatcher of branch North)', () => {
    let c: E3Company;
    const day = '2027-02-19';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    let north: Ctx;
    beforeAll(async () => {
      c = await tenant('BRANCH', { passengers: 6, branches: ['North', 'South'], vehicles: [4, 4, 4, 4] });
      north = ctxOf(c, { branchIds: [c.branches[0].id] });
    });
    // Passengers / vehicles alternate branches: even index = North, odd = South.

    it('[ISO] North dispatcher: seats a North passenger on a North van; South bookings are hidden from board / candidates / GET', async () => {
      const bn = await booking(c, 0, day, t0);
      const bsouth = await booking(c, 1, day, t0);
      const ok = await outcome(dispatch.submit(north, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', bn)] }, randomUUID()));
      const board = await dispatch.board(north, { serviceDate: day });
      const r = { ok, boardHasSouth: board.queue.some((q) => q.id === bsouth), get: await statusOf(bookings.get(north, bsouth)), candidates: await outcome(dispatch.candidates(north, { bookingIds: [bsouth] })), southVan: await outcome(dispatch.submit(north, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[1].id, t0 + 4 * H)] }, randomUUID())) };
      summary.ac10Branch = r;
      expect(r).toEqual({ ok: 'OK', boardHasSouth: false, get: 404, candidates: 'NOT_FOUND', southVan: 'NOT_FOUND' });
    });

    secfix('[ISO][pending secfix B1] North dispatcher cannot seat a South passenger through ADD_PASSENGER (QA SCOPE-3/5)', async () => {
      const bsouth = await booking(c, 3, day, t0 + 2 * H);
      const res = await outcome(dispatch.submit(north, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[2].id, t0 + 2 * H), addPax('t', bsouth)] }, randomUUID()));
      expect(res).not.toBe('OK');
      expect((await prisma.transportBooking.findUniqueOrThrow({ where: { id: bsouth } })).status).toBe('PENDING_ASSIGNMENT');
    });

    secfix('[ISO][pending secfix B1] North dispatcher cannot put a South passenger\'s pickup on a trip through ADD_STOP', async () => {
      const bn = await booking(c, 4, day, t0 + 6 * H);
      const bsouth = await booking(c, 5, day, t0 + 6 * H);
      const pub = await dispatch.submit(north, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[2].id, t0 + 6 * H), addPax('t', bn)] }, randomUUID());
      const tripId = pub.value.trips[0].id;
      const res = await outcome(dispatch.submit(north, { serviceDate: day, direction: 'IN', expectedVersions: { [tripId]: 1 }, changes: [{ op: 'ADD_STOP', tripId, bookingId: bsouth, end: 'PICKUP', afterSeq: 0 }] }, randomUUID()));
      expect(res).not.toBe('OK');
      const stops = await prisma.plannedTripStop.count({ where: { tripId: pub.value.trips[0].plannedTripId! } });
      expect(stops).toBe(2);
    });
  });

  secfix('[AC3][pending secfix B5] dispatcher start does not mark the first (pickup) stop DEPARTED before the van gets there', async () => {
    const c = await tenant('START', { passengers: 1 });
    const ctx = ctxOf(c);
    const day = '2027-02-22';
    const t0 = Date.parse(`${day}T02:00:00Z`);
    const b = await booking(c, 0, day, t0);
    const r0 = await dispatch.submit(ctx, { serviceDate: day, direction: 'IN', changes: [createTrip(c, c.vehicles[0].id, t0), addPax('t', b)] }, randomUUID());
    await trips.start(ctx, r0.value.trips[0].id, {});
    const first = await prisma.plannedTripStop.findFirstOrThrow({ where: { tripId: r0.value.trips[0].plannedTripId!, seq: 0 } });
    // Whatever status the fix chooses for the first stop, it is not "departed now" (GPS records the real times).
    expect(first.status).not.toBe('DEPARTED');
    expect(first.actualDeparture).toBeNull();
  });
});
