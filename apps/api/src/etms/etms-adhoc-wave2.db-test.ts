/**
 * ETMS WP 3.9 wave 2 on a real, freshly migrated PostgreSQL (migration 20261121090000_etms_booking_journey, amended):
 * - D-A5: passenger self-booking and ad-hoc request REQUESTED while approval is on (default), PENDING_ASSIGNMENT when
 *   off; approve → BOOKING_APPROVED (approvedAt), reject → BOOKING_REJECTED (reason via the passenger's booking);
 *   the kind CHECK accepts both; concurrent / repeated / bulk approves notify once per booking;
 * - D-A7: personal request ends without consent → 409, nothing stored;
 * - D-A8: group booking all-or-nothing (groupId / purpose columns), same-key concurrent twins = one group, two
 *   concurrent groups sharing a passenger = one wins, the other 422 GROUP_INVALID with nothing written; scope 404;
 * - D-A9: home set needs consent, audit without coordinates; openBookingsKept; clear.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `veetrax_*_test` database with every migration
 * applied (`prisma migrate deploy`):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_adhocapi2_test \
 *     npx jest --testRegex 'etms-adhoc-wave2\.db-test\.ts$' --runInBand
 * Synthetic data only (tag adw-…).
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
import { TransportNotificationsService } from './notifications/transport-notifications.service';
import { ConsentNoticeService } from './people/consent-notice.service';
import { PeopleService } from './people/people.service';
import { SelfServiceService } from './self-service/self-service.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `adw-${Date.now().toString(36)}`;
const TZ = 'Asia/Kolkata';
const H = 3_600_000;

const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `unexpected: ${String(e)}`));
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

d(`WP 3.9 wave 2 (approval, requests, groups, profile) on ${dbName}`, () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0' } };
  const audit = new AuditService(prisma as never);
  const people = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
  const notifications = new TransportNotificationsService(prisma as never, redis as never);
  const bookings = new BookingsService(prisma as never, audit, redis as never, notifications);
  const me = new MeTransportService(prisma as never, people, redis as never);
  const self = new SelfServiceService(prisma as never, audit, people, bookings, me);

  const id = () => randomUUID();
  const w = {
    partner: id(),
    a: id(),
    b: id(),
    branchN: id(),
    branchS: id(),
    office: id(),
    stop: id(),
    officeB: id(),
    shift: id(),
    users: { desk: id(), north: id(), p1: id(), p2: id(), p4: id(), south: id(), b: id() } as Record<string, string>,
    profiles: { p1: id(), p2: id(), p3: id(), p4: id(), south: id(), b: id() } as Record<string, string>,
  };
  const ctx = (userId: string, companyId: string, o: { branchIds?: string[]; perms?: Record<string, string[]> } = {}) =>
    ({ userId, companyId, homeCompanyId: companyId, isSuperAdmin: false, isCompanyAdmin: false, permissions: o.perms ?? { etms_bookings: ['view', 'create', 'edit'] }, dataScope: o.branchIds ? 'ASSIGNED' : 'COMPANY', branchIds: o.branchIds ?? [], objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  const DESK = () => ctx(w.users.desk, w.a);
  const NORTH = () => ctx(w.users.north, w.a, { branchIds: [w.branchN] });
  const PAX = (k: string) => ctx(w.users[k], w.a, { branchIds: [], perms: { etms_self: ['view'] } });
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const day = (n: number) => addDays(todayIn(TZ), n);
  const at = (n: number, h: number) => new Date(Date.parse(`${day(n)}T00:00:00+05:30`) + h * H).toISOString();
  const setApproval = (on: boolean) => sql(`UPDATE "Company" SET settings = jsonb_set(settings, '{etms,selfBookingApproval}', '${on ? 'true' : 'false'}') WHERE id = '${w.a}'`);
  const request = (k: string, n: number, h: number, o: Record<string, unknown> = {}) =>
    self.createRequest(PAX(k), { serviceDate: day(n), journey: 'POINT_TO_POINT', pickup: { kind: 'PLACE', poiId: w.office }, destination: { kind: 'PLACE', poiId: w.stop }, windowStart: at(n, h), windowEnd: at(n, h + 1), ...o } as never, `${TAG}-${id()}`);
  const group = (ids: string[], n: number, h: number, o: Record<string, unknown> = {}) =>
    ({ passengerIds: ids, serviceDate: day(n), journey: 'POINT_TO_POINT', pickup: { mode: 'COMMON', point: { lat: 0, lng: 0, poiId: w.office } }, drop: { lat: 0, lng: 0, poiId: w.stop }, windowStart: at(n, h), windowEnd: at(n, h + 2), purpose: 'Site visit — plant 2', ...o }) as never;

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    const s = `{"features":["etms"],"etms":{"directoryListed":false,"selfBooking":true}}`;
    for (const [c, n] of [[w.a, 'a'], [w.b, 'b']]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${n}', '${TZ}', '${s}', now())`);
    for (const [b, n] of [[w.branchN, 'North'], [w.branchS, 'South']]) await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${b}', '${w.a}', '${n} ${TAG}', now())`);
    for (const [p, c, n, cat] of [[w.office, w.a, 'Office A', 'OFFICE'], [w.stop, w.a, 'Stop A', 'SHUTTLE_STOP'], [w.officeB, w.b, 'Office B', 'OFFICE']]) await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${p}', '${c}', '${n}', '${cat}', 13.05, 80.25, now())`);
    await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${w.shift}', '${w.a}', '${w.office}', 'Day ${TAG}', 540, 1080, false, '{0,1,2,3,4,5,6}', '${TZ}', now())`);
    for (const k of ['desk', 'north']) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.users[k]}', '${w.a}', 'Synthetic ${k}', now())`);
    const pax: [string, string, string | null, boolean, boolean][] = [['p1', w.a, w.branchN, true, true], ['p2', w.a, w.branchN, true, true], ['p3', w.a, w.branchN, false, true], ['p4', w.a, w.branchN, true, false], ['south', w.a, w.branchS, true, true], ['b', w.b, null, true, true]];
    for (const [k, c, br, user, consent] of pax) {
      if (user) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.users[k]}', '${c}', 'Synthetic ${k}', now())`);
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "userId", "homeLat", "homeLng", "homeAddress", preferences, "updatedAt") VALUES ('${w.profiles[k]}', '${c}', ${br ? `'${br}'` : 'NULL'}, 'ADW-${k}', 'Synthetic ${k}', ${user ? `'${w.users[k]}'` : 'NULL'}, 13.0612, 80.2412, '7 Synthetic Street', '{}', now())`);
      if (consent) await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${c}', '${w.profiles[k]}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB', now() - interval '1 hour')`);
    }
    await sql(`INSERT INTO "PushToken" (id, "userId", token, platform, "updatedAt") VALUES (gen_random_uuid(), '${w.users.p1}', 'ExponentPushToken[${TAG}]', 'android', now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('D-A5: REQUESTED with approval on (both self paths), PENDING_ASSIGNMENT when off; approve / reject notify once, kinds accepted by the CHECK', async () => {
    const r1 = (await request('p1', 2, 10)).value;
    expect(r1).toMatchObject({ status: 'REQUESTED', approval: 'PENDING' });
    const sb = await self.createBooking(PAX('p1'), { serviceDate: day(2), direction: 'IN', shiftId: w.shift, place: { kind: 'HOME' } } as never, `${TAG}-${id()}`);
    expect(sb.value.status).toBe('REQUESTED');
    // Five concurrent approvals of the same booking: one wins, one notification.
    const res = await Promise.all(Array.from({ length: 5 }, () => codeOf(bookings.command(DESK(), r1.id, 'approve', {}))));
    // Losers: INVALID_STATE (saw it approved) or VERSION_CONFLICT (lost the version race).
    expect(res.filter((x) => x === 'OK')).toHaveLength(1);
    expect(res.filter((x) => x !== 'OK').every((x) => x === 'INVALID_STATE' || x === 'VERSION_CONFLICT')).toBe(true);
    const approved = await prisma.transportBooking.findUniqueOrThrow({ where: { id: r1.id } });
    expect(approved.status).toBe('PENDING_ASSIGNMENT');
    expect(approved.approvedAt).not.toBeNull();
    // Bulk approve (incl. the already-approved one) and a reject.
    const r2 = (await request('p1', 2, 12)).value;
    const r3 = (await request('p1', 2, 15)).value;
    const bulk = await bookings.bulkApprove(DESK(), [r1.id, r2.id, sb.value.id]);
    expect(bulk.approved.sort()).toEqual([r2.id, sb.value.id].sort());
    await bookings.command(DESK(), r3.id, 'reject', { reason: 'No vehicle that afternoon' });
    const rows = await prisma.transportNotification.findMany({ where: { userId: w.users.p1, kind: { in: ['BOOKING_APPROVED', 'BOOKING_REJECTED'] } } });
    expect(rows.map((r) => `${r.kind}:${r.bookingId}`).sort()).toEqual([`BOOKING_APPROVED:${r1.id}`, `BOOKING_APPROVED:${r2.id}`, `BOOKING_APPROVED:${sb.value.id}`, `BOOKING_REJECTED:${r3.id}`].sort());
    for (const r of rows) expect(`${r.title} ${r.body}`).not.toMatch(/vehicle that|Synthetic|Office|Stop/);
    const logs = await prisma.notificationLog.findMany({ where: { refType: 'TRANSPORT_NOTIFICATION', refId: { in: rows.map((r) => r.id) } } });
    expect(logs).toHaveLength(4);
    expect(await me.booking(PAX('p1'), r3.id)).toMatchObject({ status: 'REJECTED', statusReason: 'No vehicle that afternoon', approval: 'REJECTED' });
    expect(await me.booking(PAX('p1'), r1.id)).toMatchObject({ approval: 'APPROVED', statusReason: null });
    // Approval off: straight to the queue on both paths.
    await setApproval(false);
    try {
      expect((await request('p2', 3, 12)).value).toMatchObject({ status: 'PENDING_ASSIGNMENT', approval: 'NOT_REQUIRED' });
      expect((await self.createBooking(PAX('p2'), { serviceDate: day(3), direction: 'IN', shiftId: w.shift, place: { kind: 'HOME' } } as never, `${TAG}-${id()}`)).value.status).toBe('PENDING_ASSIGNMENT');
    } finally {
      await setApproval(true);
    }
    // The amended CHECK still refuses an unknown kind.
    await expect(sql(`INSERT INTO "TransportNotification" (id, "companyId", "userId", audience, kind, title, body, "dedupeKey") VALUES (gen_random_uuid(), '${w.a}', '${w.users.p1}', 'PASSENGER', 'BOOKING_EXPLODED', 't', 'b', '${TAG}-bad')`)).rejects.toThrow(/TransportNotification_kind_check/);
  });

  it('D-A7: personal ends without consent are 409 and nothing is stored', async () => {
    const before = await prisma.transportBooking.count({ where: { profileId: w.profiles.p4 } });
    for (const end of [{ kind: 'HOME' }, { kind: 'MAP', lat: 13.07, lng: 80.2, label: 'Gym' }]) expect(await codeOf(request('p4', 2, 8, { pickup: end }))).toBe('CONSENT_REQUIRED');
    expect(await codeOf(self.addPlace(PAX('p4'), { label: 'Gym', lat: 13.07, lng: 80.2 }))).toBe('CONSENT_REQUIRED');
    expect(await prisma.transportBooking.count({ where: { profileId: w.profiles.p4 } })).toBe(before);
  });

  it('D-A8: group all-or-nothing; same-key twins = one group; competing groups = one wins, nothing partial; scope 404', async () => {
    const key = `${TAG}-g-1`;
    const twins = await Promise.all(Array.from({ length: 4 }, () => bookings.createGroup(DESK(), group([w.profiles.p1, w.profiles.p2, w.profiles.p3], 5, 9), key)));
    const gid = twins[0].value.groupId;
    expect(new Set(twins.map((t) => t.value.groupId))).toEqual(new Set([gid]));
    expect(twins.filter((t) => !t.replay)).toHaveLength(1);
    const rows = await prisma.transportBooking.findMany({ where: { groupId: gid } });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ purpose: 'Site visit — plant 2', status: 'PENDING_ASSIGNMENT', journey: 'POINT_TO_POINT' });
    // p1 and p2 have logins (p3 none): one BOOKING_CREATED each, never more.
    expect(await prisma.transportNotification.count({ where: { kind: 'BOOKING_CREATED', bookingId: { in: rows.map((r) => r.id) } } })).toBe(2);

    // Two different groups racing for p1 at the same time (COMMUTE same day + direction).
    const commute = (ids: string[]) => group(ids, 6, 0, { journey: 'COMMUTE', direction: 'IN', shiftId: w.shift, windowStart: undefined, windowEnd: undefined });
    const race = await Promise.all([
      codeOf(bookings.createGroup(DESK(), commute([w.profiles.p1, w.profiles.p2]), `${TAG}-g-r1`)),
      codeOf(bookings.createGroup(DESK(), commute([w.profiles.p1, w.profiles.p3]), `${TAG}-g-r2`)),
    ]);
    expect(race.sort()).toEqual(['GROUP_INVALID', 'OK']);
    const day6 = await prisma.transportBooking.findMany({ where: { profileId: { in: [w.profiles.p1, w.profiles.p2, w.profiles.p3] }, serviceDate: new Date(`${day(6)}T00:00:00Z`) } });
    const groups = tally(day6.map((b) => b.groupId ?? 'none'));
    expect(Object.values(groups)).toEqual([2]); // only the winner's two rows, nothing of the loser
    const e = await bookings.createGroup(DESK(), commute([w.profiles.p1, w.profiles.p3]), `${TAG}-g-r3`).catch((x: HttpException) => x.getResponse() as { code: string; failures: unknown[] });
    // Whichever group won the race, p1 is taken (p3 too when the second group won).
    expect(e).toMatchObject({ code: 'GROUP_INVALID', failures: expect.arrayContaining([{ passengerId: w.profiles.p1, code: 'BOOKING_DUPLICATE' }]) });

    // Scope: another company's passenger, or another branch for a branch dispatcher: 404, nothing written.
    const count = await prisma.transportBooking.count();
    expect(await codeOf(bookings.createGroup(DESK(), group([w.profiles.p1, w.profiles.b], 7, 9), `${TAG}-g-s1`))).toBe('NOT_FOUND');
    expect(await codeOf(bookings.createGroup(NORTH(), group([w.profiles.p1, w.profiles.south], 7, 9), `${TAG}-g-s2`))).toBe('NOT_FOUND');
    expect(await prisma.transportBooking.count()).toBe(count);
    expect((await bookings.createGroup(NORTH(), group([w.profiles.p1, w.profiles.p2], 7, 9), `${TAG}-g-s3`)).value.bookings).toHaveLength(2);
  });

  it('D-A9: home set needs consent; stored, audited without coordinates; openBookingsKept; clear', async () => {
    expect(await codeOf(self.setHome(PAX('p4'), { lat: 13.1, lng: 80.3 }))).toBe('CONSENT_REQUIRED');
    const open = await prisma.transportBooking.count({ where: { profileId: w.profiles.p2, status: { in: ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'WAITLISTED'] }, windowEnd: { gt: new Date() } } });
    const r = await self.setHome(PAX('p2'), { lat: 13.0987654, lng: 80.2765432, address: '9 New Synthetic Road', source: 'PHOTON' });
    expect(r.openBookingsKept).toBe(open);
    expect(open).toBeGreaterThan(0);
    expect(await prisma.employeeTransportProfile.findUniqueOrThrow({ where: { id: w.profiles.p2 } })).toMatchObject({ homeLat: 13.098765, homeLng: 80.276543, homeAddress: '9 New Synthetic Road', homeGeocodeSource: 'PHOTON' });
    const log = await prisma.auditLog.findMany({ where: { entity: 'EmployeeTransportProfile', entityId: w.profiles.p2 } });
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toMatch(/13\.09|80\.27|New Synthetic|13\.0612/);
    expect((await self.setHome(PAX('p2'), { clear: true })).profile.home).toBeNull();
  });
});
