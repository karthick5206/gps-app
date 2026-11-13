/**
 * ETMS E3 WP 3.9 ad-hoc booking on a real, freshly migrated PostgreSQL (migration 20261121090000_etms_booking_journey):
 * - desk creates a POINT_TO_POINT booking (company place → one-time point) and a COMMUTE one; the journey column, the
 *   COMMUTE-only duplicate index and the P2P GiST exclusion behave as the service says (incl. concurrent requests);
 * - eligibility / consent on the desk and the passenger (self-service) paths; nothing personal stored without consent;
 * - cut-off (D-A1): LATE_REASON_REQUIRED, stored lateReason + audit row; passenger path AFTER_CUTOFF;
 * - edit (set a missing location, late edit with reason), never a trip or a seat;
 * - BOOKING_CREATED (D-A4) committed with the booking: inbox row with bookingId, generic text, one QUEUED push row,
 *   no second notification on an Idempotency-Key replay or a concurrent twin, none for self-booking;
 * - isolation: another company's / another branch's passenger 404; the passenger sees only their own booking;
 * - end to end (ad-hoc acceptance, A9 in a DB test): the P2P booking is seated by a dispatch change set, published into
 *   PlannedTrip + TransportTrip, and the passenger's trip view carries journey POINT_TO_POINT.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `veetrax_*_test` database with every migration
 * applied (`prisma migrate deploy`):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_adhocapi_test \
 *     npx jest --testRegex 'etms-adhoc-booking\.db-test\.ts$' --runInBand
 * Synthetic data only (tag adh-…).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { addDays } from '../summarizer/tz';
import { dbDescribe } from '../test/scratch-db';
import { BookingsService } from './dispatch/bookings.service';
import { DispatchService } from './dispatch/dispatch.service';
import { MeTransportService } from './dispatch/me-transport.service';
import { todayIn, weekdayOf } from './dispatch/service-dates';
import { TripLiveService } from './dispatch/trip-live';
import { TransportNotificationsService } from './notifications/transport-notifications.service';
import { ConsentNoticeService } from './people/consent-notice.service';
import { PeopleService } from './people/people.service';
import { SelfServiceService } from './self-service/self-service.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `adh-${Date.now().toString(36)}`;
const TZ = 'Asia/Kolkata';
const H = 3_600_000;

const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `unexpected: ${String(e)}`));
const reasonOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { reason?: string; code?: string }).reason ?? (e.getResponse() as { code?: string }).code) : `unexpected: ${String(e)}`));
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

d(`E3 WP 3.9 ad-hoc booking on ${dbName}`, () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const xadds: unknown[][] = [];
  // Valkey stand-in: no live cache; eval throws so the rate limiter uses its in-process window; XADD recorded (no sends).
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async (...a: unknown[]) => (xadds.push(a), '1-0') } };
  const audit = new AuditService(prisma as never);
  const people = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
  const notifications = new TransportNotificationsService(prisma as never, redis as never);
  const bookings = new BookingsService(prisma as never, audit, redis as never, notifications);
  const me = new MeTransportService(prisma as never, people, redis as never);
  const self = new SelfServiceService(prisma as never, audit, people, bookings, me);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const dispatch = new DispatchService(prisma as never, audit, { enabled: false, route: async () => null, routeVia: async () => null } as never, live, redis as never);

  const id = () => randomUUID();
  const w = {
    partner: id(),
    a: id(),
    b: id(),
    branchN: id(),
    branchS: id(),
    office: id(),
    depot: id(),
    officeB: id(),
    shift: id(),
    vehicle: id(),
    driver: id(),
    users: { desk: id(), north: id(), p1: id(), p2: id(), p3: id(), p4: id(), south: id(), b: id() },
    profiles: { p1: id(), p2: id(), p3: id(), p4: id(), south: id(), b: id() },
  };
  const ctx = (userId: string, companyId: string, o: { branchIds?: string[]; perms?: Record<string, string[]> } = {}) =>
    ({ userId, companyId, homeCompanyId: companyId, isSuperAdmin: false, isCompanyAdmin: false, permissions: o.perms ?? { etms_bookings: ['view', 'create', 'edit'] }, dataScope: o.branchIds ? 'ASSIGNED' : 'COMPANY', branchIds: o.branchIds ?? [], objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  const DESK = () => ctx(w.users.desk, w.a);
  const NORTH = () => ctx(w.users.north, w.a, { branchIds: [w.branchN] });
  const PAX = (k: 'p1' | 'p2' | 'p3' | 'p4') => ctx(w.users[k], w.a, { branchIds: [], perms: { etms_self: ['view'] } });
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const day = addDays(todayIn(TZ), 3);
  const at = (h: number) => new Date(Date.parse(`${day}T00:00:00Z`) + h * H).toISOString();
  const DEPOT = { lat: 0, lng: 0, poiId: w.depot };
  const OFFICE = { lat: 0, lng: 0, poiId: w.office };
  const AIRPORT = { lat: 12.9941, lng: 80.1709, label: 'Terminal 1' };
  const p2p = (passengerId: string, o: Record<string, unknown> = {}) => ({ passengerId, serviceDate: day, journey: 'POINT_TO_POINT' as const, pickup: DEPOT, drop: AIRPORT, windowStart: at(8), windowEnd: at(10), ...o }) as never;
  const commute = (passengerId: string, o: Record<string, unknown> = {}) => ({ passengerId, serviceDate: day, direction: 'IN' as const, pickup: DEPOT, drop: OFFICE, windowStart: at(2), windowEnd: at(3.5), ...o }) as never;

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    const s = `{"features":["etms"],"etms":{"directoryListed":false,"selfBooking":true}}`;
    for (const [c, n] of [[w.a, 'a'], [w.b, 'b']]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${n}', '${TZ}', '${s}', now())`);
    for (const [b, n] of [[w.branchN, 'North'], [w.branchS, 'South']]) await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${b}', '${w.a}', '${n} ${TAG}', now())`);
    for (const [p, c, n] of [[w.office, w.a, 'Office A'], [w.depot, w.a, 'Depot A'], [w.officeB, w.b, 'Office B']]) await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${p}', '${c}', '${n}', 'OFFICE', 13.05, 80.25, now())`);
    await sql(`UPDATE "Poi" SET lat = 13.07, lng = 80.23 WHERE id = '${w.depot}'`);
    await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${w.shift}', '${w.a}', '${w.office}', 'Day ${TAG}', 540, 1080, false, '{0,1,2,3,4,5,6}', '${TZ}', now())`);
    for (const k of ['desk', 'north'] as const) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.users[k]}', '${w.a}', 'Synthetic ${k}', now())`);
    const pax: [keyof typeof w.profiles, string, string | null, boolean][] = [['p1', w.a, w.branchN, true], ['p2', w.a, w.branchN, true], ['p3', w.a, w.branchN, false], ['p4', w.a, w.branchN, true], ['south', w.a, w.branchS, true], ['b', w.b, null, true]];
    for (const [k, c, br, consent] of pax) {
      await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.users[k]}', '${c}', 'Synthetic ${k}', now())`);
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "userId", "homeLat", "homeLng", preferences, "updatedAt") VALUES ('${w.profiles[k]}', '${c}', ${br ? `'${br}'` : 'NULL'}, 'ADH-${k}', 'Synthetic ${k}', '${w.users[k]}', 13.0612, 80.2412, '{"notifications":{"push":true}}', now())`);
      if (consent) await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${c}', '${w.profiles[k]}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB', now() - interval '1 hour')`);
    }
    await sql(`INSERT INTO "PushToken" (id, "userId", token, platform, "updatedAt") VALUES (gen_random_uuid(), '${w.users.p1}', 'ExponentPushToken[${TAG}]', 'android', now())`);
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", name, "isActive", "updatedAt") VALUES ('${w.vehicle}', '${w.a}', 'Van ${TAG}', true, now())`);
    await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${w.vehicle}', '${w.a}', 4, now())`);
    await sql(`INSERT INTO "Driver" (id, "companyId", name, "isActive", "updatedAt") VALUES ('${w.driver}', '${w.a}', 'Synthetic Driver', true, now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('P2P + COMMUTE by the desk; BOOKING_CREATED in the same transaction; replay never notifies twice; passenger sees it', async () => {
    const key = `${TAG}-p2p-1`;
    const r = await bookings.create(DESK(), p2p(w.profiles.p1), key);
    expect(r.value).toMatchObject({ journey: 'POINT_TO_POINT', direction: 'IN', shiftId: null, afterCutoff: false, pickup: { poiId: w.depot, lat: 13.07 }, drop: { lat: 12.9941, label: 'Terminal 1' } });
    const row = await prisma.transportBooking.findUniqueOrThrow({ where: { id: r.value.id } });
    expect(row).toMatchObject({ journey: 'POINT_TO_POINT', direction: 'IN', lateReason: null, createdById: w.users.desk, dropPoiId: null, pickupPoiId: w.depot });
    expect(await bookings.create(DESK(), p2p(w.profiles.p1), key)).toMatchObject({ replay: true, value: { id: r.value.id } });
    const c = await bookings.create(DESK(), commute(w.profiles.p1), `${TAG}-c-1`);
    expect(c.value).toMatchObject({ journey: 'COMMUTE', direction: 'IN' });

    const inbox = await notifications.list(PAX('p1') as never, 'PASSENGER', {} as never);
    expect(inbox.filter((n) => n.kind === 'BOOKING_CREATED')).toHaveLength(2);
    const n = inbox.find((x) => x.bookingId === r.value.id)!;
    expect(n).toMatchObject({ kind: 'BOOKING_CREATED', tripId: null, bookingId: r.value.id, title: 'Ride booked for you', body: 'The transport desk booked a ride for you. Open the app for details.', pushQueued: true });
    const logs = await prisma.notificationLog.findMany({ where: { refType: 'TRANSPORT_NOTIFICATION', refId: n.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ channel: 'PUSH', status: 'QUEUED', recipient: `user:${w.users.p1}` });
    expect(`${logs[0].subject} ${logs[0].body}`).not.toMatch(/Terminal|Synthetic|Depot|Office|\d{4}-/);
    expect(xadds.length).toBeGreaterThanOrEqual(1);

    // The passenger opens it: own booking only; journey + "arranged by the desk".
    expect(await me.booking(PAX('p1'), r.value.id)).toMatchObject({ id: r.value.id, journey: 'POINT_TO_POINT', arrangedByDesk: true, dropLabel: 'Terminal 1' });
    expect(await codeOf(me.booking(PAX('p2'), r.value.id))).toBe('NOT_FOUND');
    // Audit row (CREATE) carries the journey.
    const a = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'TransportBooking', entityId: r.value.id, action: 'CREATE' } });
    expect(JSON.stringify(a.changes)).toContain('POINT_TO_POINT');
  });

  it('concurrent overlapping P2P (8 keys) → exactly one booking, the rest 409 BOOKING_OVERLAP; same-key twins → one booking, one notification', async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => codeOf(bookings.create(DESK(), p2p(w.profiles.p2, { windowStart: at(12 + i * 0.1), windowEnd: at(14) }), `${TAG}-race-${i}`))));
    expect(tally(outcomes)).toEqual({ OK: 1, BOOKING_OVERLAP: 7 });
    const twins = await Promise.all(Array.from({ length: 6 }, () => bookings.create(DESK(), p2p(w.profiles.p2, { windowStart: at(15), windowEnd: at(16) }), `${TAG}-twin`)));
    expect(new Set(twins.map((t) => t.value.id)).size).toBe(1);
    expect(twins.filter((t) => !t.replay)).toHaveLength(1);
    expect(await prisma.transportNotification.count({ where: { bookingId: twins[0].value.id } })).toBe(1);
    // COMMUTE vs P2P under concurrency (the per-passenger lock, not only the GiST exclusion).
    const mixed = await Promise.all([
      codeOf(bookings.create(DESK(), p2p(w.profiles.p4, { windowStart: at(2), windowEnd: at(4) }), `${TAG}-mix-p`)),
      codeOf(bookings.create(DESK(), commute(w.profiles.p4), `${TAG}-mix-c`)),
    ]);
    expect(tally(mixed)).toEqual({ OK: 1, BOOKING_OVERLAP: 1 });
    // COMMUTE duplicate under concurrency: one booking, the rest BOOKING_DUPLICATE.
    const dup = await Promise.all(Array.from({ length: 4 }, (_, i) => codeOf(bookings.create(DESK(), commute(w.profiles.p2, { direction: 'OUT', pickup: OFFICE, drop: DEPOT, windowStart: at(17 + i * 0.1), windowEnd: at(18) }), `${TAG}-dup-${i}`))));
    expect(tally(dup)).toEqual({ OK: 1, BOOKING_DUPLICATE: 3 });
  });

  it('the database backstop: a raw overlapping P2P insert violates TransportBooking_p2p_overlap_excl', async () => {
    const insert = (start: string, end: string) =>
      sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, journey, "serviceDate", direction, "timeZone", "windowStart", "windowEnd", status, "updatedAt") VALUES (gen_random_uuid(), '${w.a}', '${w.profiles.south}', 'ADHOC', 'POINT_TO_POINT', '${day}', 'IN', '${TZ}', '${start}', '${end}', 'PENDING_ASSIGNMENT', now())`);
    await insert(at(20), at(21));
    await expect(insert(at(20.5), at(22))).rejects.toThrow(/TransportBooking_p2p_overlap_excl/);
    await insert(at(21), at(22)); // half-open: touching is fine
    // Two COMMUTE rows of different directions on the same day are fine; the same direction is the unique index.
    await sql(`DELETE FROM "TransportBooking" WHERE "profileId" = '${w.profiles.south}'`);
  });

  it('consent (D-A3) on the desk and passenger paths: never stored without it', async () => {
    expect(await codeOf(bookings.create(DESK(), p2p(w.profiles.p3), `${TAG}-nc-1`))).toBe('CONSENT_REQUIRED');
    expect(await codeOf(bookings.create(DESK(), commute(w.profiles.p3, { pickup: { lat: 13.08, lng: 80.26, label: 'Typed address' } }), `${TAG}-nc-2`))).toBe('CONSENT_REQUIRED');
    // Default home pickup without consent: "needs location", nothing personal stored.
    const r = await bookings.create(DESK(), commute(w.profiles.p3, { pickup: undefined }), `${TAG}-nc-3`);
    expect(r.value.needsLocation).toBe(true);
    const row = await prisma.transportBooking.findUniqueOrThrow({ where: { id: r.value.id } });
    expect([row.pickupLat, row.pickupLabel]).toEqual([null, null]);
    // A one-time point set by PATCH without consent: refused.
    expect(await codeOf(bookings.update(DESK(), r.value.id, { expectedVersion: r.value.version, pickup: { lat: 13.08, lng: 80.26 } }))).toBe('CONSENT_REQUIRED');
    // Passenger path: a saved place without consent is refused (self-service check), HOME becomes "needs location".
    expect(await codeOf(self.createBooking(PAX('p3'), { serviceDate: addDays(day, 1), direction: 'OUT', shiftId: w.shift, place: { kind: 'SAVED', placeId: id() } } as never, `${TAG}-nc-4`))).toBe('CONSENT_REQUIRED');
    const sb = await self.createBooking(PAX('p3'), { serviceDate: addDays(day, 1), direction: 'OUT', shiftId: w.shift, place: { kind: 'HOME' } } as never, `${TAG}-nc-5`);
    expect(sb.value).toMatchObject({ arrangedByDesk: false, journey: 'COMMUTE' });
    expect(await prisma.transportBooking.findUniqueOrThrow({ where: { id: sb.value.id } })).toMatchObject({ dropLat: null, dropLabel: null });
    // Self-booking does not notify the passenger.
    expect(await prisma.transportNotification.count({ where: { bookingId: sb.value.id } })).toBe(0);
    expect(JSON.stringify(await prisma.transportBooking.findMany({ where: { profileId: w.profiles.p3 } }))).not.toContain('Typed address');
  });

  it('eligibility and isolation: 422 reasons; other company / other branch passenger 404; other company place refused', async () => {
    expect(await codeOf(bookings.create(DESK(), commute(w.profiles.b), `${TAG}-iso-1`))).toBe('NOT_FOUND');
    expect(await codeOf(bookings.create(NORTH(), commute(w.profiles.south), `${TAG}-iso-2`))).toBe('NOT_FOUND');
    expect(await reasonOf(bookings.create(DESK(), commute(w.profiles.south, { drop: { lat: 0, lng: 0, poiId: w.officeB } }), `${TAG}-iso-3`))).toBe('PLACE_NOT_ALLOWED');
    await sql(`UPDATE "EmployeeTransportProfile" SET "isActive" = false WHERE id = '${w.profiles.south}'`);
    expect(await reasonOf(bookings.create(DESK(), commute(w.profiles.south), `${TAG}-iso-4`))).toBe('PASSENGER_INACTIVE');
    await sql(`UPDATE "EmployeeTransportProfile" SET "isActive" = true WHERE id = '${w.profiles.south}'`);
    const others = [0, 1, 2, 3, 4, 5, 6].filter((x) => x !== weekdayOf(day)).join(',');
    await sql(`UPDATE "TransportShift" SET days = '{${others}}' WHERE id = '${w.shift}'`);
    expect(await reasonOf(bookings.create(DESK(), commute(w.profiles.south, { shiftId: w.shift }), `${TAG}-iso-5`))).toBe('SHIFT_NOT_RUNNING');
    await sql(`UPDATE "TransportShift" SET days = '{0,1,2,3,4,5,6}' WHERE id = '${w.shift}'`);
    expect(await prisma.transportBooking.count({ where: { profileId: { in: [w.profiles.south, w.profiles.b] } } })).toBe(0);
    // A branch dispatcher cannot read another branch's booking either.
    const own = await bookings.create(DESK(), commute(w.profiles.south), `${TAG}-iso-6`);
    expect(await codeOf(bookings.get(NORTH(), own.value.id))).toBe('NOT_FOUND');
    expect(await codeOf(bookings.update(NORTH(), own.value.id, { expectedVersion: 1, passengerCount: 2 }))).toBe('NOT_FOUND');
    // Places: only company a's active places.
    expect((await bookings.places(DESK(), 'office')).map((p) => p.id)).toEqual([w.office]);
  });

  it('cut-off (D-A1): desk needs a reason (stored, audited); passenger path AFTER_CUTOFF; late edit needs a reason too', async () => {
    const today = todayIn(TZ);
    const soon = { serviceDate: today, windowStart: new Date(Date.now() + 20 * 60_000).toISOString(), windowEnd: new Date(Date.now() + 80 * 60_000).toISOString() };
    expect(await codeOf(bookings.create(DESK(), commute(w.profiles.p4, { ...soon, direction: 'OUT', pickup: OFFICE, drop: DEPOT }), `${TAG}-late-1`))).toBe('LATE_REASON_REQUIRED');
    expect(await codeOf(bookings.create(DESK(), commute(w.profiles.p4, { ...soon, direction: 'OUT', pickup: OFFICE, drop: DEPOT, lateReason: '   too short ' }), `${TAG}-late-2`))).toBe('LATE_REASON_REQUIRED');
    expect(await codeOf(bookings.create(ctx(w.users.p4, w.a), commute(w.profiles.p4, { ...soon, direction: 'OUT', pickup: OFFICE, drop: DEPOT }), `${TAG}-late-3`, { actor: 'PASSENGER' }))).toBe('AFTER_CUTOFF');
    const r = await bookings.create(DESK(), commute(w.profiles.p4, { ...soon, direction: 'OUT', pickup: OFFICE, drop: DEPOT, lateReason: 'Late meeting at the client site' }), `${TAG}-late-4`);
    expect(r.value).toMatchObject({ afterCutoff: true, lateReason: 'Late meeting at the client site' });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'TransportBooking', entityId: r.value.id, action: 'CREATE' } });
    const late = (a.changes as { late: { to: Record<string, string> } }).late.to;
    expect(late).toMatchObject({ reason: 'Late meeting at the client site', dispatcherUserId: w.users.desk, cutoffAt: r.value.cutoffAt });
    expect(Date.parse(late.createdAt)).toBeGreaterThan(Date.parse(late.cutoffAt));
    // Late edit: reason required; stored and audited with editedAt.
    expect(await codeOf(bookings.update(DESK(), r.value.id, { expectedVersion: r.value.version, passengerCount: 2 }))).toBe('LATE_REASON_REQUIRED');
    const u = await bookings.update(DESK(), r.value.id, { expectedVersion: r.value.version, passengerCount: 2, lateReason: 'Colleague joins the ride now' });
    expect(u).toMatchObject({ passengerCount: 2, lateReason: 'Colleague joins the ride now', afterCutoff: true });
    const ua = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'TransportBooking', entityId: r.value.id, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect((ua.changes as { late: { to: Record<string, string> } }).late.to).toMatchObject({ reason: 'Colleague joins the ride now', dispatcherUserId: w.users.desk });
    const list = await bookings.list(DESK(), { afterCutoff: 'true' } as never);
    expect((list as { items: { id: string }[] }).items.map((b) => b.id)).toContain(r.value.id);
  });

  it('end to end: the P2P booking is seated by a dispatch change set and published; the passenger trip says POINT_TO_POINT', async () => {
    const b = await bookings.create(DESK(), p2p(w.profiles.p1, { windowStart: at(18), windowEnd: at(20), passengerCount: 1 }), `${TAG}-e2e`);
    // Edit before dispatch: a new one-time destination (consented); no trip / seat appears.
    const e = await bookings.update(DESK(), b.value.id, { expectedVersion: b.value.version, drop: { lat: 12.995, lng: 80.171, label: 'Terminal 2' } });
    expect(await prisma.transportTripPassenger.count({ where: { bookingId: b.value.id } })).toBe(0);
    const start = Date.parse(at(18));
    const res = await dispatch.submit(
      DESK() as never,
      {
        serviceDate: day,
        direction: 'IN',
        changes: [
          {
            op: 'CREATE_TRIP',
            tempId: 't',
            objectId: w.vehicle,
            driverId: w.driver,
            plannedStart: new Date(start).toISOString(),
            stops: [
              { seq: 0, point: { lat: 13.07, lng: 80.23, label: 'Depot A', poiId: w.depot }, plannedArrival: new Date(start).toISOString() },
              { seq: 1, point: { lat: 12.995, lng: 80.171, label: 'Terminal 2' }, plannedArrival: new Date(start + H).toISOString() },
            ],
          },
          { op: 'ADD_PASSENGER', tripId: 't', bookingId: b.value.id, pickupSeq: 0, dropSeq: 1 },
        ],
        expectedVersions: { [b.value.id]: e.version },
      } as never,
      `${TAG}-cs-1`,
    );
    expect(res.value).toMatchObject({ status: 'PUBLISHED', bookings: [{ id: b.value.id, status: 'ASSIGNED' }] });
    const tripId = res.value.trips[0].id;
    expect(await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId }, include: { plannedTrip: true } })).toMatchObject({ plannedTrip: { origin: 'ETMS', objectId: w.vehicle, driverId: w.driver } });
    // Same change set again: replay, no second trip.
    const again = await dispatch.submit(DESK() as never, { serviceDate: day, direction: 'IN', changes: [{ op: 'ADD_PASSENGER', tripId, bookingId: b.value.id, pickupSeq: 0, dropSeq: 1 }] } as never, `${TAG}-cs-1`).catch((x: unknown) => x);
    expect(await prisma.transportTripPassenger.count({ where: { bookingId: b.value.id } })).toBe(1);
    void again;
    // A seated booking can no longer be edited (an edit never moves a seat).
    expect(await codeOf(bookings.update(DESK(), b.value.id, { expectedVersion: e.version + 1, passengerCount: 2 }))).toBe('INVALID_STATE');
    // Passenger view.
    const trips = await me.trips(PAX('p1'), { from: day, to: day });
    const mine = trips.find((t) => t.id === tripId)!;
    expect(mine).toMatchObject({ journey: 'POINT_TO_POINT', direction: 'IN', myDrop: { label: 'Terminal 2' } });
    expect(await me.booking(PAX('p1'), b.value.id)).toMatchObject({ status: 'ASSIGNED', tripId, journey: 'POINT_TO_POINT', arrangedByDesk: true });
  });
});
