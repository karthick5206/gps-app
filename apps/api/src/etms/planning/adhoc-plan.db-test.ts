/**
 * WP 3.9.5 (E4 draft integration of ad-hoc bookings) on a real, freshly migrated PostgreSQL:
 * - plan create plans shift-less COMMUTE bookings at the plan's site (no plan shift, or a window overlapping the plan
 *   shift's leg window) and reports every other open booking of the date / direction with a ROUTE_PLAN_SKIP_REASONS
 *   reason (other_site, other_shift, outside_shift_window, point_to_point, needs_approval, out_of_scope); bookings of a
 *   branch the caller cannot see are neither listed nor counted (security delta D1);
 * - publish refuses a booking edited after the plan was built (PLAN_NOT_PUBLISHABLE, route issue BOOKING_CHANGED); a
 *   version bump without a content change does not block;
 * - cross-path duplicates: a booking of a draft that is seated by a manual change set makes the plan publish refuse
 *   (INVALID_STATE, no second seat); publishing twice with one key is a replay (one set of trips).
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `*_test` database with every migration applied:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_adhocplan_test \
 *     npx jest --testRegex 'adhoc-plan\.db-test\.ts$' --runInBand
 * Synthetic data only (tag ap-…).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { DispatchChangeOp } from '@veetracer/shared';
import { AuditService } from '../../audit/audit.service';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { dbDescribe } from '../../test/scratch-db';
import { BookingsService } from '../dispatch/bookings.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { TripLiveService } from '../dispatch/trip-live';
import { RoutePlanCreateService } from './plan-create';
import { RoutePlansService } from './plans.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `ap-${Date.now().toString(36)}`;
const DAY = '2026-12-10'; // skip reasons
const DAY2 = '2026-12-11'; // BOOKING_CHANGED + replay
const DAY3 = '2026-12-12'; // cross-path
// Shift A logs in 09:00 IST = 03:30Z: IN leg [02:00Z, 03:30Z].
const WIN = (day: string) => [`${day}T02:30:00Z`, `${day}T03:30:00Z`] as const;

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: 'OK', body: {} as Record<string, unknown> }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { status: 0, code: `unexpected: ${String(e)}`, body: {} as Record<string, unknown> };
      const body = e.getResponse() as Record<string, unknown>;
      return { status: e.getStatus(), code: (body.code as string | undefined) ?? `HTTP_${e.getStatus()}`, body };
    },
  );

d(`WP 3.9.5 ad-hoc bookings in E4 plans on ${dbName}`, () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0', zrangebyscore: async () => [], exists: async () => 0 } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null, routeStatus: async () => 'UNAVAILABLE' };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const provider = { routeVia: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }) };
  const plans = new RoutePlansService(prisma as never, audit, dispatch, provider as never);
  const creator = new RoutePlanCreateService(prisma as never, audit, plans);
  const bookings = new BookingsService(prisma as never, audit, redis as never);

  const id = () => randomUUID();
  const w = {
    partner: id(),
    company: id(),
    north: id(),
    south: id(),
    site: id(),
    annex: id(),
    shiftA: id(),
    shiftB: id(),
    shiftC: id(),
    users: { north: id(), admin: id() },
    vehicles: [id(), id(), id()],
  };
  const perms = { etms_planning: ['view', 'create', 'edit', 'delete', 'command'], etms_dispatch: ['view', 'create', 'edit', 'command'], objects: ['view'], drivers: ['view'] };
  const ctxOf = (userId: string, dataScope: 'COMPANY' | 'ASSIGNED', branchIds: string[]) =>
    ({ userId, companyId: w.company, homeCompanyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions: perms, dataScope, branchIds, objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  const north = ctxOf(w.users.north, 'ASSIGNED', [w.north]);
  const admin = ctxOf(w.users.admin, 'COMPANY', []);
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  let pn = 0;

  /** A consented passenger (own profile: one active COMMUTE booking per passenger / date / direction) and one booking. */
  async function booking(day: string, o: { branch?: string; shift?: string | null; drop?: string | null; status?: string; journey?: string; win?: readonly [string, string]; direction?: 'IN' | 'OUT' } = {}): Promise<{ id: string; profile: string; lat: number }> {
    const p = id();
    const b = id();
    pn++;
    const lat = 13.06 + pn * 0.001;
    const [ws, we] = o.win ?? WIN(day);
    const drop = o.drop === undefined ? w.site : o.drop;
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${o.branch ?? w.north}', 'AP${pn}', 'Synthetic ${pn}', now())`);
    await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", "shiftId", source, journey, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "updatedAt")
      VALUES ('${b}', '${w.company}', '${p}', ${o.shift === undefined ? `'${w.shiftA}'` : o.shift === null ? 'NULL' : `'${o.shift}'`}, 'ADHOC', '${o.journey ?? 'COMMUTE'}', '${day}', '${o.direction ?? 'IN'}', 'Asia/Kolkata', ${lat}, 80.24, 'Pickup', ${drop ? `'${drop}'` : 'NULL'}, ${drop === w.annex ? 13.1 : drop ? 13.05 : 13.2}, ${drop === w.annex ? 80.3 : drop ? 80.25 : 80.2}, 'Drop', '${ws}', '${we}', '${o.status ?? 'PENDING_ASSIGNMENT'}', now())`);
    return { id: b, profile: p, lat };
  }

  const s: Record<string, string> = {};

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${w.company}', '${w.partner}', '${TAG} corp', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    for (const [b, n] of [[w.north, 'North'], [w.south, 'South']]) await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${b}', '${w.company}', '${n}', now())`);
    for (const u of Object.values(w.users)) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${w.company}', 'User ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.annex}', '${w.company}', 'Annex', 'OFFICE', 13.1, 80.3, now())`);
    for (const [sh, n, start, end] of [[w.shiftA, 'A', 540, 1080], [w.shiftB, 'B', 600, 1140], [w.shiftC, 'C', 1200, 1380]] as const)
      await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${sh}', '${w.company}', '${w.site}', '${n} ${TAG}', ${start}, ${end}, false, '{0,1,2,3,4,5,6}', 'Asia/Kolkata', now())`);
    for (const [i, v] of w.vehicles.entries()) {
      await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${v}', '${w.company}', '${w.north}', 'Van ${i + 1}', true, now())`);
      await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${v}', '${w.company}', 4, now())`);
    }
    // DAY: one booking per case.
    s.shiftA = (await booking(DAY)).id;
    s.adhoc = (await booking(DAY, { shift: null })).id; // shift-less, window overlaps shift A's leg
    s.late = (await booking(DAY, { shift: null, win: [`${DAY}T06:00:00Z`, `${DAY}T07:00:00Z`] })).id;
    s.shiftB = (await booking(DAY, { shift: w.shiftB })).id;
    s.annex = (await booking(DAY, { shift: null, drop: w.annex })).id;
    s.mapPoint = (await booking(DAY, { shift: null, drop: null })).id;
    s.p2p = (await booking(DAY, { shift: null, drop: null, journey: 'POINT_TO_POINT' })).id;
    s.requested = (await booking(DAY, { shift: null, status: 'REQUESTED' })).id;
    s.waitlisted = (await booking(DAY, { status: 'WAITLISTED' })).id;
    s.south = (await booking(DAY, { branch: w.south })).id;
    s.cancelled = (await booking(DAY, { status: 'CANCELLED' })).id;
    s.outward = (await booking(DAY, { direction: 'OUT', drop: null })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const body = (day: string, extra: Record<string, unknown> = {}) => ({ name: `Plan ${TAG}`, planDate: day, planStartAt: `${day}T01:30:00Z`, direction: 'IN' as const, sitePoiId: w.site, shiftId: w.shiftA, objectIds: [w.vehicles[0], w.vehicles[1]], ...extra });
  const reasons = (r: { skippedBookings: { bookingId: string; reason: string }[] }) => Object.fromEntries(r.skippedBookings.map((x) => [x.bookingId, x.reason]));
  const planned = (r: { stops: { bookingId: string | null }[] }) => [...new Set(r.stops.map((x) => x.bookingId).filter(Boolean))].sort();

  it('a plan with a shift takes its shift’s bookings and overlapping shift-less ad-hoc ones; every other visible open booking is reported with its reason', async () => {
    const r = (await creator.create(north, body(DAY), `${TAG}-scope-north`)).value;
    expect(r.branchId).toBe(w.north);
    expect(planned(r)).toEqual([s.shiftA, s.adhoc].sort());
    // The ad-hoc booking gets a site stop with its own window, like a shift booking.
    const site = r.stops.find((x) => x.bookingId === s.adhoc && x.stopKind === 'DROP');
    expect(site?.poiId).toBe(w.site);
    expect(reasons(r)).toEqual({
      [s.late]: 'outside_shift_window',
      [s.shiftB]: 'other_shift',
      [s.annex]: 'other_site',
      [s.mapPoint]: 'other_site',
      [s.p2p]: 'point_to_point',
      [s.requested]: 'needs_approval',
      [s.waitlisted]: 'needs_approval',
    });
    // D1: the South booking is invisible to a North dispatcher (neither listed nor counted); cancelled and OUT bookings
    // are not candidates at all.
    expect(JSON.stringify(r.skippedBookings)).not.toContain(s.south);
    expect(r.bookingCounts).toEqual({ found: 9, planned: 2, skipped: 7 });
    expect(r.emptyReason).toBeNull();
  });

  it('a whole-company dispatcher planning one branch sees the other branch’s booking as out_of_scope (counted)', async () => {
    const r = (await creator.create(admin, body(DAY, { branchId: w.north }), `${TAG}-scope-admin`)).value;
    expect(planned(r)).toEqual([s.shiftA, s.adhoc].sort());
    expect(reasons(r)[s.south]).toBe('out_of_scope');
    expect(r.bookingCounts).toEqual({ found: 10, planned: 2, skipped: 8 });
    // Company-wide: the South booking is planned.
    const all = (await creator.create(admin, body(DAY), `${TAG}-scope-company`)).value;
    expect(planned(all)).toEqual([s.shiftA, s.adhoc, s.south].sort());
  });

  it('a plan without a shift takes every COMMUTE booking at its site waiting for a seat, whatever its shift or window', async () => {
    const r = (await creator.create(north, body(DAY, { shiftId: null }), `${TAG}-noshift`)).value;
    expect(planned(r)).toEqual([s.shiftA, s.adhoc, s.late, s.shiftB].sort());
    expect(reasons(r)).toEqual({ [s.annex]: 'other_site', [s.mapPoint]: 'other_site', [s.p2p]: 'point_to_point', [s.requested]: 'needs_approval', [s.waitlisted]: 'needs_approval' });
  });

  it('a shift without bookings: ALL_SKIPPED with the reasons (documented change from NO_BOOKINGS_FOR_SHIFT when other bookings exist)', async () => {
    const r = (await creator.create(north, body(DAY, { shiftId: w.shiftC }), `${TAG}-shiftc`)).value;
    expect(r.stops).toEqual([]);
    expect(r.emptyReason).toBe('ALL_SKIPPED');
    expect(reasons(r)[s.adhoc]).toBe('outside_shift_window');
    expect(reasons(r)[s.shiftA]).toBe('other_shift');
    // No candidate at all on that date: still NO_BOOKINGS_FOR_SHIFT.
    const none = (await creator.create(north, body('2026-12-20', { shiftId: w.shiftC }), `${TAG}-none`)).value;
    expect(none).toMatchObject({ emptyReason: 'NO_BOOKINGS_FOR_SHIFT', bookingCounts: { found: 0, planned: 0, skipped: 0 } });
  });

  /** Put every stop of the plan on its first route, timed: pickups 3000 s / 3300 s…, site drops 4000 s (window 3600–7200). */
  async function timeOnFirstRoute(planId: string) {
    const route = await prisma.routeAssignment.findFirstOrThrow({ where: { planId, seq: 0 } });
    const stops = await prisma.routePlanStop.findMany({ where: { planId }, orderBy: { ref: 'asc' } });
    const pickups = stops.filter((x) => x.stopKind === 'PICKUP');
    const drops = stops.filter((x) => x.stopKind === 'DROP');
    for (const [i, x] of pickups.entries()) await prisma.routePlanStop.update({ where: { id: x.id }, data: { assignmentId: route.id, sequence: i, etaS: 3000 + i * 300 } });
    for (const [i, x] of drops.entries()) await prisma.routePlanStop.update({ where: { id: x.id }, data: { assignmentId: route.id, sequence: pickups.length + i, etaS: 4000 } });
    await prisma.routeAssignment.update({ where: { id: route.id }, data: { startS: 2900, endS: 4000 } });
    return route.id;
  }

  async function publish(ctx: never, planId: string, key: string) {
    const plan = await plans.get(ctx, planId);
    const fp = plan.publishCheck?.fingerprint ?? undefined;
    return plans.publish(ctx, planId, { expectedVersion: plan.version, ...(fp ? { acknowledgedWarnings: fp } : {}) } as never, key);
  }

  it('BOOKING_CHANGED: a booking edited while in the plan blocks publish (nothing written); the same content again (new version) publishes; a second publish replays', async () => {
    const a = await booking(DAY2);
    const b = await booking(DAY2, { shift: null }); // ad-hoc
    const r = (await creator.create(admin, body(DAY2), `${TAG}-chg`)).value;
    expect(planned(r)).toEqual([a.id, b.id].sort());
    await timeOnFirstRoute(r.id);
    // A dispatcher PATCHes the ad-hoc pickup through the booking service (QA B10: the real path, which bumps the version).
    const version = async () => (await prisma.transportBooking.findUniqueOrThrow({ where: { id: b.id } })).version;
    await bookings.update(admin, b.id, { expectedVersion: await version(), pickup: { lat: b.lat + 0.01, lng: 80.24, label: 'Pickup' } } as never);
    const refused = await errOf(publish(admin, r.id, `${TAG}-chg-1`));
    expect(refused).toMatchObject({ status: 409, code: 'PLAN_NOT_PUBLISHABLE' });
    const issues = refused.body.routes as { code: string; message: string }[];
    expect(issues.map((x) => x.code)).toEqual(['BOOKING_CHANGED']);
    expect(issues[0].message).toContain(b.id);
    expect(JSON.stringify(refused.body)).not.toMatch(/"lat"|Synthetic/);
    expect(await prisma.transportTrip.count({ where: { routePlanId: r.id } })).toBe(0);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('DRAFT');
    // The window edited instead: also refused.
    await bookings.update(admin, b.id, { expectedVersion: await version(), pickup: { lat: b.lat, lng: 80.24, label: 'Pickup' }, windowEnd: `${DAY2}T03:45:00Z` } as never);
    expect((await errOf(publish(admin, r.id, `${TAG}-chg-2`))).body.routes).toEqual([expect.objectContaining({ code: 'BOOKING_CHANGED' })]);
    // Edited back to what the plan holds (the version moved on): content matches, the plan publishes.
    await bookings.update(admin, b.id, { expectedVersion: await version(), windowEnd: WIN(DAY2)[1], note: 'gate 2' } as never);
    const ok = await publish(admin, r.id, `${TAG}-chg-3`);
    expect(ok.replay).toBe(false);
    expect(ok.value.trips).toHaveLength(1);
    // Publishing again with the same key: the same result, no second trip or seat.
    const again = await plans.publish(admin, r.id, { expectedVersion: 1 } as never, `${TAG}-chg-3`);
    expect(again.replay).toBe(true);
    expect(again.value.trips.map((t) => t.transportTripId)).toEqual(ok.value.trips.map((t) => t.transportTripId));
    // Another key on the published plan is refused.
    expect((await errOf(plans.publish(admin, r.id, { expectedVersion: 2 } as never, `${TAG}-chg-4`))).status).toBeGreaterThanOrEqual(400);
    expect(await prisma.transportTrip.count({ where: { routePlanId: r.id } })).toBe(1);
    for (const x of [a, b]) {
      expect(await prisma.transportTripPassenger.count({ where: { bookingId: x.id, status: { not: 'CANCELLED' } } })).toBe(1);
      expect((await prisma.transportBooking.findUniqueOrThrow({ where: { id: x.id } })).status).toBe('ASSIGNED');
    }
  });

  it('cross-path: a draft booking seated by a manual change set makes the plan publish refuse (INVALID_STATE); no second seat', async () => {
    const a = await booking(DAY3);
    const b = await booking(DAY3, { shift: null });
    const r = (await creator.create(admin, body(DAY3), `${TAG}-x`)).value;
    expect(planned(r)).toEqual([a.id, b.id].sort());
    await timeOnFirstRoute(r.id);
    // The dispatcher seats the ad-hoc booking by hand on another van.
    const t0 = Date.parse(`${DAY3}T02:30:00Z`);
    const changes: DispatchChangeOp[] = [
      {
        op: 'CREATE_TRIP',
        tempId: 't',
        objectId: w.vehicles[2],
        driverId: null,
        plannedStart: new Date(t0).toISOString(),
        stops: [
          { seq: 0, point: { lat: b.lat, lng: 80.24, label: 'Pickup' }, plannedArrival: new Date(t0).toISOString() },
          { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'HQ', poiId: w.site }, plannedArrival: new Date(t0 + 1800_000).toISOString() },
        ],
      },
      { op: 'ADD_PASSENGER', tripId: 't', bookingId: b.id, pickupSeq: 0, dropSeq: 1 },
    ];
    const manual = await dispatch.submit(admin, { serviceDate: DAY3, direction: 'IN', changes } as never, `${TAG}-x-manual`);
    expect(manual.value.trips).toHaveLength(1);
    const refused = await errOf(publish(admin, r.id, `${TAG}-x-plan`));
    expect(refused).toMatchObject({ status: 409, code: 'PLAN_NOT_PUBLISHABLE' });
    expect((refused.body.routes as { code: string; message: string }[]).filter((x) => x.code === 'INVALID_STATE').map((x) => x.message.includes(b.id))).toEqual([true]);
    expect(await prisma.transportTrip.count({ where: { routePlanId: r.id } })).toBe(0);
    expect(await prisma.transportTripPassenger.count({ where: { bookingId: b.id, status: { not: 'CANCELLED' } } })).toBe(1);
    expect(await prisma.transportTripPassenger.count({ where: { bookingId: a.id } })).toBe(0);
    expect((await prisma.transportBooking.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('PENDING_ASSIGNMENT');
  });
});
