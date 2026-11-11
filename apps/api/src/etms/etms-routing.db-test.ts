/**
 * ETMS E4 migrations routing_engine_v2 + etms_planning_links on a real PostgreSQL with all migrations applied (doc 15
 * §9.5 raw-SQL inventory / constraint behaviour, §9.6 tenant purge; doc 17 §2.5 / §2.6). Not part of the normal run
 * (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_e4a_schema_test \
 *     npx jest --testRegex 'etms-routing\.db-test\.ts$' --runInBand
 * Allowed databases: *_test (veetrax_assess outside CI); never veetracer. Every case runs inside ONE transaction that is
 * always rolled back: no row is left behind. Synthetic data only.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { planPurge, rootCondition, stepSql, type Catalog, type FkEdge } from '../purge/purge-plan';
import { PURGE_EVIDENCE_WRITE } from '../purge/purge.service';
import { eraseRoutingPlanPoints, withdrawRoutingPlanPoints } from './dispatch/routing-plan-privacy';
import { dbDescribe } from '../test/scratch-db';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
type Tx = Prisma.TransactionClient;
class Rollback extends Error {}

const E4_TABLES = ['RoutePlan', 'RouteAssignment', 'RoutePlanStop', 'RoutingJob', 'RoutingUsage', 'RoutePlanVersion'];

async function inRollback(prisma: PrismaClient, fn: (tx: Tx, partnerId: string) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(
      async (tx) => {
        const [partner] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-e4-db-test', 'etms-e4-db-test-' || gen_random_uuid(), now()) RETURNING id`;
        await fn(tx, partner.id);
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

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

/**
 * A corporate-managed company with an office, a passenger (consent), a vehicle, a driver, a shift, a booking, a
 * published ETMS trip, and a PLANNED routing plan: one assignment (vehicle + driver, geometry), a personal pickup stop
 * (profile + booking), a site drop stop (Poi), a version, a finished job and a usage row. The trip links plan + assignment.
 */
async function seedGraph(tx: Tx, partnerId: string, tag: string) {
  const id = () => randomUUID();
  const g = { company: id(), office: id(), profile: id(), object: id(), driver: id(), shift: id(), booking: id(), plannedTrip: id(), trip: id(), plan: id(), assignment: id(), pickup: id(), drop: id(), job: id() };
  const sql = (s: string) => tx.$executeRawUnsafe(s);
  await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${g.company}', '${partnerId}', 'etms-e4-db-test ${tag}', '{"features":["etms"]}', now())`);
  await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${g.office}', '${g.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
  await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "homeLat", "homeLng", "updatedAt") VALUES ('${g.profile}', '${g.company}', 'E1', 'Synthetic ${tag}', 13.061234, 80.241234, now())`);
  await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${g.company}', '${g.profile}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
  await sql(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${g.object}', '${g.company}', 'Van ${tag}', now())`);
  await sql(`INSERT INTO "Driver" (id, "companyId", name, "updatedAt") VALUES ('${g.driver}', '${g.company}', 'Driver ${tag}', now())`);
  await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${g.shift}', '${g.company}', '${g.office}', 'Day', 540, 1080, false, '{1,2,3,4,5}', 'Asia/Kolkata', now())`);
  await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "providerCompanyId", "profileId", "shiftId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropPoiId", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
       VALUES ('${g.booking}', '${g.company}', '${g.company}', '${g.profile}', '${g.shift}', 'ADHOC', '2026-12-01', 'IN', 'Asia/Kolkata', 13.061234, 80.241234, '${g.office}', 13.05, 80.25, '2026-12-01T02:00:00Z', '2026-12-01T03:30:00Z', 'ASSIGNED', now())`);
  await sql(`INSERT INTO "RoutePlan" (id, "companyId", name, "planDate", "planStartAt", status, direction, "shiftId", "sitePoiId", depot, "updatedAt") VALUES ('${g.plan}', '${g.company}', 'Login ${tag}', '2026-12-01', '2026-12-01T02:00:00Z', 'PLANNED', 'IN', '${g.shift}', '${g.office}', '{"lat":13.05,"lng":80.25}', now())`);
  await sql(`INSERT INTO "RouteAssignment" (id, "planId", "companyId", "objectId", "driverId", "vehicleLabel", capacity, "distanceM", "durationS", "startS", "endS", geometry, "updatedAt") VALUES ('${g.assignment}', '${g.plan}', '${g.company}', '${g.object}', '${g.driver}', 'Van ${tag}', 4, 5200, 900, 0, 900, '[[80.241234,13.061234],[80.25,13.05]]', now())`);
  await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, name, lat, lng, demand, sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "profileId", "snappedLat", "snappedLng", "snapDistanceM", "updatedAt")
       VALUES ('${g.pickup}', '${g.plan}', '${g.company}', '${g.assignment}', 'p1', 'Passenger pickup', 13.061234, 80.241234, 1, 0, 0, 'PICKUP', '${g.company}', '${g.booking}', '${g.profile}', 13.06125, 80.24125, 3, now())`);
  await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, name, lat, lng, sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "poiId", "updatedAt")
       VALUES ('${g.drop}', '${g.plan}', '${g.company}', '${g.assignment}', 'd1', 'HQ', 13.05, 80.25, 1, 900, 'DROP', '${g.company}', '${g.booking}', '${g.office}', now())`);
  await sql(`INSERT INTO "RoutePlanVersion" (id, "planId", "companyId", version, "changeType", snapshot) VALUES (gen_random_uuid(), '${g.plan}', '${g.company}', 1, 'OPTIMIZED', '{"status":"PLANNED","assignments":[],"stops":[]}')`);
  await sql(`INSERT INTO "RoutingJob" (id, "companyId", "planId", kind, status, phase, input, progress, "finishedAt") VALUES ('${g.job}', '${g.company}', '${g.plan}', 'optimize', 'SUCCEEDED', 'done', '{"kind":"optimize","planId":"${g.plan}","planVersion":1,"profile":"car","timeLimitS":10}', 100, now())`);
  await sql(`INSERT INTO "RoutingUsage" ("companyId", day, routes, "matrixCells", "optimizeJobs", "updatedAt") VALUES ('${g.company}', '2026-12-01', 3, 16, 1, now())`);
  await sql(`INSERT INTO "PlannedTrip" (id, "companyId", "routeId", origin, "objectId", "driverId", "routeName", "corridorM", "plannedStart", "plannedEnd", "updatedAt") VALUES ('${g.plannedTrip}', '${g.company}', NULL, 'ETMS', '${g.object}', '${g.driver}', 'Login ${tag}', 200, '2026-12-01T02:30:00Z', '2026-12-01T03:30:00Z', now())`);
  await sql(`INSERT INTO "TransportTrip" (id, "plannedTripId", "providerCompanyId", "customerCompanyId", "serviceDate", direction, "shiftId", "sitePoiId", "seatCapacity", "publishedAt", "routePlanId", "routeAssignmentId", "updatedAt") VALUES ('${g.trip}', '${g.plannedTrip}', '${g.company}', '${g.company}', '2026-12-01', 'IN', '${g.shift}', '${g.office}', 4, now(), '${g.plan}', '${g.assignment}', now())`);
  return g;
}

async function e4Counts(tx: Pick<Tx, '$queryRawUnsafe'>, company: string, g?: { trip: string; assignment: string }) {
  const [r] = await tx.$queryRawUnsafe<Record<string, bigint | string | null>[]>(`SELECT
    (SELECT count(*) FROM "RoutePlan" WHERE "companyId" = '${company}') AS plans,
    (SELECT count(*) FROM "RouteAssignment" WHERE "companyId" = '${company}') AS assignments,
    (SELECT count(*) FROM "RoutePlanStop" WHERE "companyId" = '${company}') AS stops,
    (SELECT count(*) FROM "RoutingJob" WHERE "companyId" = '${company}') AS jobs,
    (SELECT count(*) FROM "RoutingUsage" WHERE "companyId" = '${company}') AS usage,
    (SELECT count(*) FROM "RoutePlanVersion" WHERE "companyId" = '${company}') AS versions,
    (SELECT count(*) FROM "TransportTrip" WHERE "providerCompanyId" = '${company}') AS trips,
    (SELECT count(*) FROM "Company" WHERE id = '${company}') AS company
    ${g ? `, (SELECT "objectId"::text FROM "RouteAssignment" WHERE id = '${g.assignment}') AS "assignmentObjectId",
            (SELECT "driverId"::text FROM "RouteAssignment" WHERE id = '${g.assignment}') AS "assignmentDriverId",
            (SELECT "routePlanId"::text FROM "TransportTrip" WHERE id = '${g.trip}') AS "tripRoutePlanId",
            (SELECT "routeAssignmentId"::text FROM "TransportTrip" WHERE id = '${g.trip}') AS "tripRouteAssignmentId"` : ''}`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
}

d(`ETMS E4 routing_engine_v2 + etms_planning_links on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(240_000);
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
  });
  afterAll(async () => {
    const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Company" WHERE name LIKE 'etms-e4-db-test %'`;
    expect(Number(left[0].n)).toBe(0);
    await prisma.$disconnect();
  });

  it('inventory: six tables, two enums, the documented CHECKs and FK actions; no SetNull FK on a companyId column', async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${E4_TABLES})`;
    expect(tables.map((t) => t.tablename).sort()).toEqual([...E4_TABLES].sort());
    // The branch's RouteStop name stays the v1.8 master-route stop.
    const routeStopCols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'RouteStop' AND column_name IN ('routeId', 'planId') ORDER BY column_name`;
    expect(routeStopCols.map((c) => c.column_name)).toEqual(['routeId']);
    const enums = await prisma.$queryRaw<{ typname: string; labels: string }[]>`SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname IN ('RoutePlanStatus', 'RoutingJobStatus') GROUP BY t.typname ORDER BY t.typname`;
    expect(enums).toEqual([
      { typname: 'RoutePlanStatus', labels: 'DRAFT,OPTIMIZING,PLANNED,PUBLISHED,CANCELLED' },
      { typname: 'RoutingJobStatus', labels: 'QUEUED,RUNNING,SUCCEEDED,FAILED,CANCELLED' },
    ]);
    const checks = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN (SELECT oid FROM pg_class WHERE relname = ANY(${E4_TABLES})) ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual([
      'RouteAssignment_numbers_check',
      'RoutePlanStop_booking_kind_check',
      'RoutePlanStop_customer_check',
      'RoutePlanStop_kind_check',
      'RoutePlanStop_numbers_check',
      'RoutePlanStop_personal_check',
      'RoutePlanStop_point_check',
      'RoutePlanStop_snapped_check',
      'RoutePlanVersion_version_check',
      'RoutePlan_profile_check',
      'RoutePlan_published_check',
      'RoutePlan_version_check',
      'RoutingJob_counters_check',
      'RoutingJob_finished_check',
      'RoutingJob_kind_check',
      'RoutingJob_phase_check',
      'RoutingUsage_counters_check',
    ]);
    const fks = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`SELECT conname, confdeltype::text FROM pg_constraint WHERE contype = 'f' AND (conrelid IN (SELECT oid FROM pg_class WHERE relname = ANY(${E4_TABLES})) OR conname LIKE 'TransportTrip_route%') ORDER BY conname`;
    expect(Object.fromEntries(fks.map((f) => [f.conname, f.confdeltype]))).toEqual({
      RouteAssignment_driverId_fkey: 'n',
      RouteAssignment_objectId_fkey: 'n',
      RouteAssignment_planId_companyId_fkey: 'c',
      RoutePlanStop_assignmentId_fkey: 'n',
      RoutePlanStop_bookingId_fkey: 'n',
      RoutePlanStop_customerCompanyId_fkey: 'c',
      RoutePlanStop_planId_companyId_fkey: 'c',
      RoutePlanStop_poiId_fkey: 'n',
      RoutePlanStop_profileId_fkey: 'c',
      RoutePlanVersion_planId_companyId_fkey: 'c',
      RoutePlan_branchId_fkey: 'n',
      RoutePlan_companyId_fkey: 'r',
      RoutePlan_shiftId_fkey: 'n',
      RoutePlan_sitePoiId_fkey: 'n',
      RoutingJob_companyId_fkey: 'r',
      RoutingJob_planId_fkey: 'n',
      RoutingUsage_companyId_fkey: 'r',
      TransportTrip_routeAssignmentId_fkey: 'n',
      TransportTrip_routePlanId_fkey: 'n',
    });
    // Doc 15 §1.2: no SetNull FK on a column named companyId (the row would survive a company purge).
    const cat = await loadCatalog(prisma);
    expect(cat.fks.filter((f) => E4_TABLES.includes(f.child) && f.col === 'companyId' && f.del === 'n')).toEqual([]);
    // No FK from v1.8 PlannedTrip to a plan table (the link lives on TransportTrip).
    expect(cat.fks.filter((f) => f.child === 'PlannedTrip' && E4_TABLES.includes(f.parent))).toEqual([]);
    const uniq = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname IN ('TransportTrip_routeAssignmentId_key', 'RoutePlanStop_planId_bookingId_stopKind_key', 'RoutePlanStop_planId_ref_key', 'RoutingJob_companyId_idempotencyKey_key', 'RoutingJob_planId_idx', 'RoutingJob_finishedAt_idx') ORDER BY indexname`;
    expect(uniq).toHaveLength(6);
  });

  it('constraints: CHECKs, composite same-company FKs, unique booking stop and one trip per assignment', async () => {
    const out: Record<string, string> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const a = await seedGraph(tx, partnerId, 'CA');
      const b = await seedGraph(tx, partnerId, 'CB');
      const attempt = async (name: string, sql: string) => {
        await tx.$executeRawUnsafe('SAVEPOINT s');
        try {
          await tx.$executeRawUnsafe(sql);
          out[name] = 'accepted';
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
        } catch (e) {
          out[name] = `rejected ${/(Route|Routing)[A-Za-z]*_[A-Za-z_]+_(check|key|fkey)/.exec(String(e))?.[0] ?? /Code: `(\w+)`/.exec(String(e))?.[1] ?? String(e).slice(0, 160)}`;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
        }
      };
      const stop = (ref: string, cols: string, vals: string, planId = a.plan, company = a.company) =>
        `INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, lat, lng, "updatedAt"${cols}) VALUES (gen_random_uuid(), '${planId}', '${company}', '${ref}', 13.0, 80.2, now()${vals})`;
      await attempt('generic stop', stop('g1', '', ''));
      await attempt('stop in another company plan', stop('x1', '', '', b.plan, a.company));
      await attempt('duplicate ref', stop('g1', '', ''));
      await attempt('personal and site at once', stop('ps', ', "customerCompanyId", "profileId", "poiId"', `, '${a.company}', '${a.profile}', '${a.office}'`));
      await attempt('passenger stop without customer', stop('nc', ', "profileId"', `, '${a.profile}'`));
      await attempt('booking stop without kind', stop('nk', ', "customerCompanyId", "bookingId"', `, '${a.company}', '${a.booking}'`));
      await attempt('second pickup for the booking', stop('p2', ', "customerCompanyId", "bookingId", "stopKind"', `, '${a.company}', '${a.booking}', 'PICKUP'`));
      await attempt('unknown stop kind', stop('uk', ', "stopKind"', `, 'VIA'`));
      await attempt('half snapped point', stop('hs', ', "snappedLat"', ', 13.0'));
      await attempt('latitude out of range', `INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, lat, lng, "updatedAt") VALUES (gen_random_uuid(), '${a.plan}', '${a.company}', 'll', 95, 80.2, now())`);
      await attempt('assignment in another company plan', `INSERT INTO "RouteAssignment" (id, "planId", "companyId", "vehicleLabel", "updatedAt") VALUES (gen_random_uuid(), '${b.plan}', '${a.company}', 'X', now())`);
      await attempt('assignment start after end', `INSERT INTO "RouteAssignment" (id, "planId", "companyId", "vehicleLabel", "startS", "endS", "updatedAt") VALUES (gen_random_uuid(), '${a.plan}', '${a.company}', 'X', 10, 5, now())`);
      await attempt('unknown profile', `UPDATE "RoutePlan" SET profile = 'auto' WHERE id = '${a.plan}'`);
      await attempt('published without publishedAt', `UPDATE "RoutePlan" SET status = 'PUBLISHED' WHERE id = '${a.plan}'`);
      await attempt('published with publishedAt', `UPDATE "RoutePlan" SET status = 'PUBLISHED', "publishedAt" = now() WHERE id = '${a.plan}'`);
      await attempt('version 0', `UPDATE "RoutePlan" SET version = 0 WHERE id = '${a.plan}'`);
      const job = (vals: string) => `INSERT INTO "RoutingJob" (id, "companyId", kind, status, progress, "finishedAt", "idempotencyKey") VALUES (gen_random_uuid(), '${a.company}', ${vals})`;
      await attempt('queued job', job(`'optimize', 'QUEUED', 0, NULL, 'k1'`));
      await attempt('idempotency key reused', job(`'optimize', 'QUEUED', 0, NULL, 'k1'`));
      await attempt('unknown job kind', job(`'isochrone', 'QUEUED', 0, NULL, NULL`));
      await attempt('progress over 100', job(`'matrix', 'RUNNING', 101, NULL, NULL`));
      await attempt('failed without finishedAt', job(`'matrix', 'FAILED', 10, NULL, NULL`));
      await attempt('second trip for one assignment', `UPDATE "TransportTrip" SET "routeAssignmentId" = '${a.assignment}' WHERE id = '${b.trip}'`);
      await attempt('negative usage', `UPDATE "RoutingUsage" SET routes = -1 WHERE "companyId" = '${a.company}'`);
      await attempt('duplicate plan version', `INSERT INTO "RoutePlanVersion" (id, "planId", "companyId", version, "changeType", snapshot) VALUES (gen_random_uuid(), '${a.plan}', '${a.company}', 1, 'EDITED', '{}')`);
    });
    expect(out).toEqual({
      'generic stop': 'accepted',
      'stop in another company plan': 'rejected RoutePlanStop_planId_companyId_fkey',
      'duplicate ref': 'rejected 23505', // unique violation of RoutePlanStop_planId_ref_key
      'personal and site at once': 'rejected RoutePlanStop_personal_check',
      'passenger stop without customer': 'rejected RoutePlanStop_customer_check',
      'booking stop without kind': 'rejected RoutePlanStop_booking_kind_check',
      'second pickup for the booking': 'rejected 23505', // unique violation of RoutePlanStop_planId_bookingId_stopKind_key
      'unknown stop kind': 'rejected RoutePlanStop_kind_check',
      'half snapped point': 'rejected RoutePlanStop_snapped_check',
      'latitude out of range': 'rejected RoutePlanStop_point_check',
      'assignment in another company plan': 'rejected RouteAssignment_planId_companyId_fkey',
      'assignment start after end': 'rejected RouteAssignment_numbers_check',
      'unknown profile': 'rejected RoutePlan_profile_check',
      'published without publishedAt': 'rejected RoutePlan_published_check',
      'published with publishedAt': 'accepted',
      'version 0': 'rejected RoutePlan_version_check',
      'queued job': 'accepted',
      'idempotency key reused': 'rejected 23505', // unique violation of RoutingJob_companyId_idempotencyKey_key
      'unknown job kind': 'rejected RoutingJob_kind_check',
      'progress over 100': 'rejected RoutingJob_counters_check',
      'failed without finishedAt': 'rejected RoutingJob_finished_check',
      'second trip for one assignment': 'rejected 23505', // unique violation of TransportTrip_routeAssignmentId_key
      'negative usage': 'rejected RoutingUsage_counters_check',
      'duplicate plan version': 'rejected 23505', // unique violation of RoutePlanVersion_planId_version_key
    });
  });

  it('purge: company → every E4 row gone, other company untouched; vehicle / driver → assignment kept with NULL; plan delete → trip header kept (doc 15 §6, §9.6; R2 Q-c)', async () => {
    const results: Record<string, unknown> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const cat = await loadCatalog(tx);
      // Reachability lint (§9.6 item 2): every E4 table is reached (deleted, not nulled) by a company purge.
      const plan = planPurge(cat, 'Company', rootCondition(randomUUID()));
      for (const t of E4_TABLES) expect([t, plan.some((s) => s.table === t && !s.nullCol)]).toEqual([t, true]);
      // The FK on objectId stops the TrackedObject logical-key walk: a vehicle purge never deletes plan rows.
      const vehiclePlan = planPurge(cat, 'TrackedObject', rootCondition(randomUUID()));
      for (const t of E4_TABLES) expect([t, vehiclePlan.some((s) => s.table === t && !s.nullCol)]).toEqual([t, false]);
      // Composite FKs are seen by their row-id column (§9.6 item 1).
      expect(cat.fks).toEqual(expect.arrayContaining([expect.objectContaining({ child: 'RoutePlanStop', col: 'planId', parent: 'RoutePlan', refCol: 'id', del: 'c' })]));

      const a = await seedGraph(tx, partnerId, 'PA');
      const b = await seedGraph(tx, partnerId, 'PB');
      // Vehicle purge of B (the planner, as PurgeService runs it), then a driver delete.
      for (const s of planPurge(cat, 'TrackedObject', rootCondition(b.object))) await tx.$executeRawUnsafe(stepSql(s));
      await tx.$executeRawUnsafe(`DELETE FROM "Driver" WHERE id = '${b.driver}'`);
      results.vehicleDriverB = await e4Counts(tx, b.company, b);
      // Application delete of B's plan: the published trip header stays, its plan links go NULL.
      await tx.$executeRawUnsafe(`DELETE FROM "RoutePlan" WHERE id = '${b.plan}'`);
      results.planDeleteB = await e4Counts(tx, b.company, b);
      // Company purge of A (with the evidence declaration, as PurgeService).
      await tx.$executeRawUnsafe(PURGE_EVIDENCE_WRITE);
      for (const s of planPurge(cat, 'Company', rootCondition(a.company))) await tx.$executeRawUnsafe(stepSql(s));
      results.companyA = await e4Counts(tx, a.company);
      results.companyB = await e4Counts(tx, b.company);
    });
    expect(results.vehicleDriverB).toEqual({ plans: 1, assignments: 1, stops: 2, jobs: 1, usage: 1, versions: 1, trips: 1, company: 1, assignmentObjectId: null, assignmentDriverId: null, tripRoutePlanId: expect.any(String), tripRouteAssignmentId: expect.any(String) });
    expect(results.planDeleteB).toEqual({ plans: 0, assignments: 0, stops: 0, jobs: 1, usage: 1, versions: 0, trips: 1, company: 1, assignmentObjectId: null, assignmentDriverId: null, tripRoutePlanId: null, tripRouteAssignmentId: null });
    expect(results.companyA).toEqual({ plans: 0, assignments: 0, stops: 0, jobs: 0, usage: 0, versions: 0, trips: 0, company: 0 });
    expect(results.companyB).toEqual({ plans: 0, assignments: 0, stops: 0, jobs: 1, usage: 1, versions: 0, trips: 1, company: 1 });
  });

  it('provider-managed: a customer purge removes its passengers from the operator plan, the plan and its site stops stay (R2 Q-a)', async () => {
    const out: Record<string, unknown> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const op = await seedGraph(tx, partnerId, 'OP');
      const cust = await seedGraph(tx, partnerId, 'CU');
      // A customer passenger stop in the operator's plan (customerCompanyId = the customer; booking of the customer).
      await tx.$executeRawUnsafe(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, lat, lng, "stopKind", "customerCompanyId", "bookingId", "profileId", "updatedAt") VALUES (gen_random_uuid(), '${op.plan}', '${op.company}', 'cu1', 13.07, 80.23, 'PICKUP', '${cust.company}', '${cust.booking}', '${cust.profile}', now())`);
      const cat = await loadCatalog(tx);
      await tx.$executeRawUnsafe(PURGE_EVIDENCE_WRITE);
      for (const s of planPurge(cat, 'Company', rootCondition(cust.company))) await tx.$executeRawUnsafe(stepSql(s));
      out.operator = await e4Counts(tx, op.company);
      out.customerStopsLeft = Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "RoutePlanStop" WHERE "customerCompanyId" = '${cust.company}'`))[0].n);
    });
    expect(out).toEqual({ operator: { plans: 1, assignments: 1, stops: 2, jobs: 1, usage: 1, versions: 1, trips: 1, company: 1 }, customerStopsLeft: 0 });
  });

  it('privacy: erasure coarsens personal plan stops and clears geometry; consent withdrawal removes them from open plans (bumping the version) and coarsens published ones', async () => {
    const out: Record<string, unknown> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const e = await seedGraph(tx, partnerId, 'ER');
      out.erased = await eraseRoutingPlanPoints(tx, e.company, e.profile, [e.booking]);
      out.erasedStops = await tx.$queryRawUnsafe(`SELECT ref, name, lat, lng, "snappedLat", "profileId" IS NOT NULL AS personal FROM "RoutePlanStop" WHERE "planId" = '${e.plan}' ORDER BY ref`);
      out.erasedGeometry = (await tx.$queryRawUnsafe<{ geometry: unknown }[]>(`SELECT geometry FROM "RouteAssignment" WHERE id = '${e.assignment}'`))[0].geometry;

      const w = await seedGraph(tx, partnerId, 'WD');
      const pub = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO "RoutePlan" (id, "companyId", name, "planDate", status, "publishedAt", "updatedAt") VALUES ('${pub}', '${w.company}', 'Published', '2026-11-30', 'PUBLISHED', now(), now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, name, lat, lng, "stopKind", "customerCompanyId", "bookingId", "profileId", "updatedAt") VALUES (gen_random_uuid(), '${pub}', '${w.company}', 'p1', 'Passenger pickup', 13.061234, 80.241234, 'PICKUP', '${w.company}', '${w.booking}', '${w.profile}', now())`);
      out.withdrawn = await withdrawRoutingPlanPoints(tx, w.company, w.profile);
      out.openPlan = (await tx.$queryRawUnsafe<{ version: number; stops: bigint }[]>(`SELECT version, (SELECT count(*) FROM "RoutePlanStop" WHERE "planId" = '${w.plan}') AS stops FROM "RoutePlan" WHERE id = '${w.plan}'`)).map((r) => ({ version: r.version, stops: Number(r.stops) }))[0];
      out.publishedStop = (await tx.$queryRawUnsafe(`SELECT name, lat, lng FROM "RoutePlanStop" WHERE "planId" = '${pub}'`) as unknown[])[0];
    });
    expect(out.erased).toBe(1);
    expect(out.erasedStops).toEqual([
      { ref: 'd1', name: 'HQ', lat: 13.05, lng: 80.25, snappedLat: null, personal: false },
      { ref: 'p1', name: null, lat: 13.06, lng: 80.24, snappedLat: null, personal: true },
    ]);
    expect(out.erasedGeometry).toBeNull();
    expect(out.withdrawn).toEqual({ removed: 1, anonymised: 1, planIds: [expect.any(String)] });
    expect(out.openPlan).toEqual({ version: 2, stops: 1 });
    expect(out.publishedStop).toEqual({ name: null, lat: 13.06, lng: 80.24 });
  });
});
