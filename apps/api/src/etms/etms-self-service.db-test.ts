/**
 * ETMS E5 WP 5.3 passenger self-service on a real, freshly migrated PostgreSQL (no migration in this WP):
 * - OFF by default: a company with only the `etms` add-on answers 404 SELF_BOOKING_DISABLED and writes nothing;
 * - booking on the company cut-off (409 AFTER_CUTOFF, `bookingCutoffMin` honoured) and through the E3 create (real
 *   partial unique index → BOOKING_DUPLICATE, Idempotency-Key replay, audit row);
 * - cross-company isolation (another company's shift / trip / saved place) and the jsonb read-modify-write of saved
 *   places under a row lock (other preference keys kept);
 * - confirm / report rows in TransportTripEvent (CHECKs on actor / source; unique (tripId, clientEventId)).
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `veetrax_*_test` database with every migration
 * applied (`prisma migrate deploy`):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_selfbook_test \
 *     npx jest --testRegex 'etms-self-service\.db-test\.ts$' --runInBand
 * Synthetic data only (tag sb-…).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { addDays } from '../summarizer/tz';
import { dbDescribe } from '../test/scratch-db';
import { BookingsService } from './dispatch/bookings.service';
import { MeTransportService } from './dispatch/me-transport.service';
import { todayIn } from './dispatch/service-dates';
import { ConsentNoticeService } from './people/consent-notice.service';
import { PeopleService } from './people/people.service';
import { SelfServiceService } from './self-service/self-service.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `sb-${Date.now().toString(36)}`;
const TZ = 'Asia/Kolkata';
const MIN = 60_000;

const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `unexpected: ${String(e)}`));

d(`E5 WP 5.3 passenger self-service on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1 } };
  const audit = new AuditService(prisma as never);
  const people = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
  const svc = new SelfServiceService(prisma as never, audit, people, new BookingsService(prisma as never, audit, redis as never), new MeTransportService(prisma as never, people, redis as never));

  const id = () => randomUUID();
  const w = {
    partner: id(),
    a: id(), // self-booking ON
    b: id(), // self-booking ON (other tenant)
    off: id(), // etms add-on only: self-booking OFF (default)
    siteA: id(),
    siteB: id(),
    siteOff: id(),
    shiftA: id(),
    shiftB: id(),
    shiftOff: id(),
    users: { a: id(), a2: id(), b: id(), off: id() },
    profiles: { a: id(), a2: id(), b: id(), off: id() },
    vehicleA: id(),
    vehicleB: id(),
  };
  const ctx = (userId: string, companyId: string) => ({ userId, companyId, homeCompanyId: companyId, isSuperAdmin: false, isCompanyAdmin: false, permissions: { etms_self: ['view'] }, dataScope: 'ASSIGNED', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  const A = () => ctx(w.users.a, w.a);
  const A2 = () => ctx(w.users.a2, w.a);
  const B = () => ctx(w.users.b, w.b);
  const OFF = () => ctx(w.users.off, w.off);
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const tomorrow = addDays(todayIn(TZ), 1);
  const trips: Record<'a' | 'b', { tt: string; pt: string }> = { a: { tt: id(), pt: id() }, b: { tt: id(), pt: id() } };

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    const on = `{"features":["etms"],"etms":{"directoryListed":false,"selfBooking":true}}`;
    for (const [c, n, s] of [[w.a, 'a', on], [w.b, 'b', on], [w.off, 'off', '{"features":["etms"]}']]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${n}', '${TZ}', '${s}', now())`);
    for (const [p, c, n] of [[w.siteA, w.a, 'Office A'], [w.siteB, w.b, 'Office B'], [w.siteOff, w.off, 'Office Off']]) await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${p}', '${c}', '${n}', 'OTHER', 13.05, 80.25, now())`);
    for (const [s, c, site] of [[w.shiftA, w.a, w.siteA], [w.shiftB, w.b, w.siteB], [w.shiftOff, w.off, w.siteOff]]) {
      await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${s}', '${c}', '${site}', 'Day ${TAG}', 540, 1080, false, '{0,1,2,3,4,5,6}', '${TZ}', now())`);
    }
    for (const [k, c] of [['a', w.a], ['a2', w.a], ['b', w.b], ['off', w.off]] as const) {
      await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.users[k]}', '${c}', 'Synthetic ${k}', now())`);
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "userId", "homeLat", "homeLng", preferences, "updatedAt") VALUES ('${w.profiles[k]}', '${c}', 'SB-${k}', 'Synthetic ${k}', '${w.users[k]}', 13.0612, 80.2412, '{"notifications":{"push":true}}', now())`);
      await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${c}', '${w.profiles[k]}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB', now() - interval '1 hour')`);
    }
    // A published trip starting in 10 minutes, seating a (company a) and b (company b).
    for (const [k, c, v] of [['a', w.a, w.vehicleA], ['b', w.b, w.vehicleB]] as const) {
      const t = trips[k];
      const booking = id();
      await sql(`INSERT INTO "TrackedObject" (id, "companyId", name, "isActive", "updatedAt") VALUES ('${v}', '${c}', 'Van ${k}', true, now())`);
      await sql(`INSERT INTO "PlannedTrip" (id, "companyId", origin, "objectId", "routeName", "corridorM", "plannedStart", "plannedEnd", status, "updatedAt") VALUES ('${t.pt}', '${c}', 'ETMS', '${v}', 'Login ${TAG}', 200, now() + interval '10 minutes', now() + interval '70 minutes', 'SCHEDULED', now())`);
      await sql(`INSERT INTO "TransportTrip" (id, "plannedTripId", "providerCompanyId", "customerCompanyId", "serviceDate", direction, "seatCapacity", "occupiedSeats", "publishedAt", "updatedAt") VALUES ('${t.tt}', '${t.pt}', '${c}', '${c}', (now() AT TIME ZONE '${TZ}')::date, 'IN', 4, 1, now(), now())`);
      await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "providerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt") VALUES ('${booking}', '${c}', '${c}', '${w.profiles[k]}', 'ADHOC', (now() AT TIME ZONE '${TZ}')::date, 'IN', '${TZ}', 13.06, 80.24, 13.05, 80.25, now() - interval '20 minutes', now() + interval '70 minutes', 'ASSIGNED', now())`);
      const s0 = id();
      const s1 = id();
      await sql(`INSERT INTO "PlannedTripStop" (id, "tripId", seq, name, lat, lng, "radiusM", "plannedArrival", "plannedDeparture") VALUES ('${s0}', '${t.pt}', 0, 'Pickup', 13.06, 80.24, 100, now() + interval '10 minutes', now() + interval '10 minutes'), ('${s1}', '${t.pt}', 1, 'Office', 13.05, 80.25, 100, now() + interval '70 minutes', now() + interval '70 minutes')`);
      await sql(`INSERT INTO "TransportTripPassenger" (id, "tripId", "bookingId", "customerCompanyId", "providerCompanyId", "pickupStopId", "dropStopId", "pickupSeq", "dropSeq", seats, "updatedAt") VALUES (gen_random_uuid(), '${t.tt}', '${booking}', '${c}', '${c}', '${s0}', '${s1}', 0, 1, 1, now())`);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('OFF by default: policy says so; booking / places / confirm / report are 404 SELF_BOOKING_DISABLED and write nothing', async () => {
    expect(await svc.policy(OFF())).toMatchObject({ selfBooking: false, shifts: [], stops: [] });
    expect(await codeOf(svc.createBooking(OFF(), { serviceDate: tomorrow, direction: 'IN', shiftId: w.shiftOff, place: { kind: 'HOME' } } as never, `${TAG}-off`))).toBe('SELF_BOOKING_DISABLED');
    expect(await codeOf(svc.addPlace(OFF(), { label: 'Gym', lat: 13.07, lng: 80.2 }))).toBe('SELF_BOOKING_DISABLED');
    expect(await codeOf(svc.commute(OFF()))).toBe('SELF_BOOKING_DISABLED');
    expect(await prisma.transportBooking.count({ where: { customerCompanyId: w.off } })).toBe(0);
    const prefs = await prisma.employeeTransportProfile.findUniqueOrThrow({ where: { id: w.profiles.off }, select: { preferences: true } });
    expect(prefs.preferences).toEqual({ notifications: { push: true } });
  });

  it('books through the E3 create: own profile, one seat, cut-off from the company setting; replay; real duplicate index; audited', async () => {
    const key = `${TAG}-book-1`;
    const body = { serviceDate: tomorrow, direction: 'IN', shiftId: w.shiftA, place: { kind: 'HOME' } } as never;
    const r = await svc.createBooking(A(), body, key);
    expect(r.value).toMatchObject({ status: 'REQUESTED', approval: 'PENDING', serviceDate: tomorrow, direction: 'IN', dropLabel: 'Office A' });
    const row = await prisma.transportBooking.findUniqueOrThrow({ where: { id: r.value.id } });
    expect(row).toMatchObject({ customerCompanyId: w.a, profileId: w.profiles.a, passengerCount: 1, createdById: w.users.a, pickupLat: 13.0612, dropPoiId: w.siteA });
    expect(row.windowStart.getTime() - row.cutoffAt!.getTime()).toBe(60 * MIN);
    expect(await svc.createBooking(A(), body, key)).toMatchObject({ replay: true, value: { id: r.value.id } });
    expect(await codeOf(svc.createBooking(A(), body, `${TAG}-book-2`))).toBe('BOOKING_DUPLICATE');
    expect(await prisma.auditLog.count({ where: { entity: 'TransportBooking', entityId: r.value.id, action: 'CREATE' } })).toBe(1);
  });

  it('company cut-off: bookingCutoffMin 1440 makes tomorrow’s 00:30 login (window from 23:00 today) too late (409 AFTER_CUTOFF)', async () => {
    const night = id();
    await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${night}', '${w.b}', '${w.siteB}', 'Night ${TAG}', 30, 540, false, '{0,1,2,3,4,5,6}', '${TZ}', now())`);
    await sql(`UPDATE "Company" SET settings = jsonb_set(settings, '{etms,bookingCutoffMin}', '1440') WHERE id = '${w.b}'`);
    try {
      expect(await codeOf(svc.createBooking(B(), { serviceDate: tomorrow, direction: 'IN', shiftId: night, place: { kind: 'HOME' } } as never, `${TAG}-cut`))).toBe('AFTER_CUTOFF');
      expect(await prisma.transportBooking.count({ where: { customerCompanyId: w.b, serviceDate: new Date(`${tomorrow}T00:00:00Z`) } })).toBe(0);
    } finally {
      await sql(`UPDATE "Company" SET settings = settings #- '{etms,bookingCutoffMin}' WHERE id = '${w.b}'`);
    }
  });

  it('cross-company: another company’s shift is refused; another company’s trip is 404 for confirm / report', async () => {
    expect(await codeOf(svc.createBooking(A(), { serviceDate: addDays(todayIn(TZ), 2), direction: 'IN', shiftId: w.shiftB, place: { kind: 'HOME' } } as never, `${TAG}-x`))).toBe('VALIDATION_FAILED');
    expect(await codeOf(svc.confirm(A(), trips.b.tt, { clientEventId: id(), kind: 'PICKUP' }))).toBe('NOT_FOUND');
    expect(await codeOf(svc.report(B(), trips.a.tt, { clientEventId: id(), category: 'DELAY' }))).toBe('NOT_FOUND');
    expect(await codeOf(svc.confirm(A2(), trips.a.tt, { clientEventId: id(), kind: 'PICKUP' }))).toBe('NOT_FOUND');
    expect(await prisma.transportTripEvent.count({ where: { tripId: { in: [trips.a.tt, trips.b.tt] } } })).toBe(0);
  });

  it('saved places: jsonb read-modify-write keeps other preference keys; another passenger cannot touch them', async () => {
    const gym = await svc.addPlace(A(), { label: 'Gym', lat: 13.07, lng: 80.2 });
    const park = await svc.addPlace(A(), { label: 'Park', lat: 13.08, lng: 80.21 });
    const prefs = (await prisma.employeeTransportProfile.findUniqueOrThrow({ where: { id: w.profiles.a }, select: { preferences: true } })).preferences as Record<string, unknown>;
    expect(prefs.notifications).toEqual({ push: true });
    expect((prefs.places as { id: string }[]).map((p) => p.id)).toEqual([gym.id, park.id]);
    expect(await codeOf(svc.deletePlace(A2(), gym.id))).toBe('NOT_FOUND');
    expect(await codeOf(svc.updatePlace(B(), gym.id, { label: 'x' }))).toBe('NOT_FOUND');
    expect((await svc.places(B())).length).toBe(0);
    // Concurrent adds by the same passenger: the row lock serialises them, none is lost.
    await Promise.all([svc.addPlace(A(), { label: 'C1', lat: 13.09, lng: 80.2 }), svc.addPlace(A(), { label: 'C2', lat: 13.1, lng: 80.2 })]);
    expect((await svc.places(A())).map((p) => p.label).sort()).toEqual(['C1', 'C2', 'Gym', 'Park']);
    // Booking from a saved place (OUT leg: the place is the drop).
    const r = await svc.createBooking(A(), { serviceDate: tomorrow, direction: 'OUT', shiftId: w.shiftA, place: { kind: 'SAVED', placeId: park.id } } as never, `${TAG}-out`);
    expect(await prisma.transportBooking.findUniqueOrThrow({ where: { id: r.value.id } })).toMatchObject({ dropLat: 13.08, dropLng: 80.21, dropLabel: 'Park', pickupPoiId: w.siteA });
    // The audit never carries the coordinates.
    const audits = await prisma.auditLog.findMany({ where: { entity: 'EmployeeTransportProfile', entityId: w.profiles.a } });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audits)).not.toMatch(/13\.0[789]/);
  });

  it('confirm / report land in TransportTripEvent (PASSENGER / PASSENGER_APP pass the CHECKs); a replay is DUPLICATE; the seat is unchanged', async () => {
    const cid = id();
    expect(await svc.confirm(A(), trips.a.tt, { clientEventId: cid, kind: 'PICKUP' })).toMatchObject({ outcome: 'ACCEPTED', myStatus: 'PENDING', mismatch: false });
    expect(await svc.confirm(A(), trips.a.tt, { clientEventId: cid, kind: 'PICKUP' })).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await codeOf(svc.confirm(A(), trips.a.tt, { clientEventId: cid, kind: 'DROP' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    const rid = id();
    expect((await svc.report(A(), trips.a.tt, { clientEventId: rid, category: 'MISSED_PICKUP', note: 'Synthetic note' })).outcome).toBe('ACCEPTED');
    const evs = await prisma.transportTripEvent.findMany({ where: { tripId: trips.a.tt }, orderBy: { receivedAt: 'asc' } });
    expect(evs.map((e) => [e.kind, e.actorType, e.source, e.reasonCode, e.actorUserId])).toEqual([
      ['PASSENGER_CONFIRM', 'PASSENGER', 'PASSENGER_APP', 'PICKUP', w.users.a],
      ['PASSENGER_REPORT', 'PASSENGER', 'PASSENGER_APP', 'MISSED_PICKUP', w.users.a],
    ]);
    const seat = await prisma.transportTripPassenger.findFirstOrThrow({ where: { tripId: trips.a.tt } });
    expect(seat.status).toBe('PENDING');
  });
});
