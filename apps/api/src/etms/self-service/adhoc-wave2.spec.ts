jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException, StreamableFile } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import { meBookingApproval, selfBookingApprovalOn, transportSettingsOf, type MeAdhocRequestInput } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { addDays } from '../../summarizer/tz';
import { BookingsService, cleanPurpose, decisionKind } from '../dispatch/bookings.service';
import { MeTransportService } from '../dispatch/me-transport.service';
import { todayIn } from '../dispatch/service-dates';
import { ConsentNoticeService } from '../people/consent-notice.service';
import { PeopleService } from '../people/people.service';
import { TransportSettingsService } from '../settings/transport-settings.service';
import { MemoryStore } from '../testing/memory-store';
import { MeAdhocRequestDto, MeHomeLocationDto, MeTransportProfileUpdateDto } from './self-service.dto';
import { SelfServiceService } from './self-service.service';

/**
 * WP 3.9 wave 2 on the in-memory Prisma stand-in (real services, real where-clauses): D-A5 approval (both self paths,
 * notifications on approve / reject, no double notify), D-A7 passenger requests (end refs, consent, request places),
 * D-A8 group booking (all-or-nothing, replay, scope), D-A9 own profile / home / geocode (consent, audit, guard, limit).
 * The PostgreSQL counterparts (concurrency, constraints) are in etms-adhoc-wave2.db-test.ts.
 */

const MIN = 60_000;
const TZ = 'Asia/Kolkata';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function world(opts: { approval?: boolean; geocodeHits?: { label: string; lat: number; lng: number; confidence: number | null }[] } = {}) {
  const store = new MemoryStore();
  const etms = { features: ['etms'], etms: { directoryListed: false, selfBooking: true, bookingCutoffMin: 60, ...(opts.approval === false ? { selfBookingApproval: false } : {}) } };
  store.insert('company', { id: 'custA', name: 'custA', timezone: TZ, settings: etms });
  store.insert('company', { id: 'custB', name: 'custB', timezone: TZ, settings: { features: ['etms'], etms: { selfBooking: true } } });
  for (const [id, companyId] of [['u-pA', 'custA'], ['u-pA2', 'custA'], ['u-pB', 'custB'], ['u-desk', 'custA']]) store.insert('user', { id, companyId, name: id, preferences: {} });
  const poi = (companyId: string, name: string, category: string) => store.insert('poi', { companyId, name, category, lat: 13.05, lng: 80.25, isActive: true }).id as string;
  const siteA = poi('custA', 'Plant A', 'OTHER'); // a shift site (not an OFFICE category): offered through the shift
  const officeA = poi('custA', 'Office A', 'OFFICE');
  const stopA = poi('custA', 'Shuttle stop A', 'SHUTTLE_STOP');
  const secretA = poi('custA', 'Customer depot', 'OTHER');
  const officeB = poi('custB', 'Office B', 'OFFICE');
  const shiftA = store.insert('transportShift', { companyId: 'custA', sitePoiId: siteA, name: 'General A', startMin: 9 * 60, endMin: 18 * 60, overnight: false, days: ALL_DAYS, timeZone: TZ, isActive: true }).id as string;
  const profile = (companyId: string, code: string, userId: string | null, branchId = 'brA1') =>
    store.insert('employeeTransportProfile', { companyId, employeeCode: code, displayName: `Passenger ${code}`, userId, isActive: true, homeLat: 13.061234, homeLng: 80.241234, homeAddress: '12 Secret Lane', homeGeocodeSource: 'PIN', defaultStopPoiId: null, branchId, preferences: {}, accessibility: {}, emergencyContacts: [] }).id as string;
  const pA = profile('custA', 'A1', 'u-pA');
  const pA2 = profile('custA', 'A2', 'u-pA2', 'brA2');
  const pA3 = profile('custA', 'A3', null);
  const pB = profile('custB', 'B1', 'u-pB', 'brB1');
  store.insert('pushToken', { userId: 'u-pA', token: 'ExponentPushToken[a]', sessionId: null });

  const prisma = store.client();
  const audit = new AuditService(prisma as never);
  const redis = { client: { get: async () => null, set: async () => 'OK', eval: async () => { throw new Error('no valkey in unit tests'); }, publish: async () => 1, xadd: async () => '1-0' } };
  const geocoding = { enabled: true, search: async () => opts.geocodeHits ?? [] };
  const people = new PeopleService(prisma as never, audit, redis as never, geocoding as never, new ConsentNoticeService(prisma as never, audit));
  const bookings = new BookingsService(prisma as never, audit, redis as never);
  const me = new MeTransportService(prisma as never, people, redis as never);
  const svc = new SelfServiceService(prisma as never, audit, people, bookings, me);
  const pax = (userId: string, companyId = 'custA'): AuthContext => ({ userId, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: { etms_self: ['view'] }, dataScope: 'ASSIGNED', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null });
  const desk = (o: Partial<AuthContext> = {}): AuthContext => ({ userId: 'u-desk', homeCompanyId: 'custA', companyId: 'custA', isSuperAdmin: false, permissions: { etms_bookings: ['view', 'create', 'edit'] }, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null, ...o });
  const consent = (profileId: string, companyId = 'custA') => store.insert('employeeTransportConsent', { companyId, profileId, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: true, channel: 'WEB', occurredAt: new Date(Date.now() - 60 * MIN) });
  const row = (model: string, id: string) => store.table(model).find((r) => r.id === id)!;
  return { store, svc, bookings, me, audit, pax, desk, consent, row, ids: { siteA, officeA, stopA, secretA, officeB, shiftA, pA, pA2, pA3, pB } };
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: HttpException) => (e.getResponse() as { code?: string }).code ?? String(e.getStatus()));
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: HttpException) => ({ status: e.getStatus(), body: e.getResponse() as Record<string, unknown> }));
const day = (n: number) => addDays(todayIn(TZ), n);
/** A window on day +2 (always before the cut-off). */
const win = (startH = 10, hours = 1) => {
  const start = Date.parse(`${day(2)}T00:00:00+05:30`) + startH * 3_600_000;
  return { windowStart: new Date(start).toISOString(), windowEnd: new Date(start + hours * 3_600_000).toISOString() };
};
const request = (w: ReturnType<typeof world>, body: Partial<MeAdhocRequestInput>, user = 'u-pA', key = randomUUID()) =>
  w.svc.createRequest(w.pax(user), { serviceDate: day(2), journey: 'POINT_TO_POINT', pickup: { kind: 'PLACE', poiId: w.ids.officeA }, destination: { kind: 'PLACE', poiId: w.ids.stopA }, ...win(), ...body } as MeAdhocRequestDto, key);
const selfBook = (w: ReturnType<typeof world>, key = randomUUID()) =>
  w.svc.createBooking(w.pax('u-pA'), { serviceDate: day(2), direction: 'IN', shiftId: w.ids.shiftA, place: { kind: 'HOME' } } as never, key);

describe('D-A5 approval setting (etms.selfBookingApproval, default ON)', () => {
  it('absent = on; only the switched-off state is stored; the settings PUT keeps unmanaged keys', async () => {
    expect(selfBookingApprovalOn({})).toBe(true);
    expect(selfBookingApprovalOn({ etms: { selfBookingApproval: true } })).toBe(true);
    expect(selfBookingApprovalOn({ etms: { selfBookingApproval: false } })).toBe(false);
    expect(transportSettingsOf({ etms: { selfBookingApproval: true } })).toEqual({ directoryListed: false });
    const company = { settings: { etms: { directoryListed: false, bookingCutoffMin: 90 } } as Record<string, unknown> };
    const write = async (_s: TemplateStringsArray, key: string, json: string) => (company.settings[key] = JSON.parse(json));
    const settings = new TransportSettingsService(
      { company: { findUniqueOrThrow: async () => company }, $executeRaw: write, $transaction: async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: write }) } as never,
      { record: async () => undefined } as never,
    );
    const admin = { userId: 'a', companyId: 'custA', dataScope: 'COMPANY' } as AuthContext;
    expect(await settings.update(admin, { selfBookingApproval: false })).toEqual({ directoryListed: false, selfBookingApproval: false });
    expect(company.settings.etms).toEqual({ directoryListed: false, bookingCutoffMin: 90, selfBookingApproval: false });
    expect(await settings.update(admin, { selfBookingApproval: true })).toEqual({ directoryListed: false });
    expect(company.settings.etms).toEqual({ directoryListed: false, bookingCutoffMin: 90 });
  });

  it('both self paths start REQUESTED while approval is on, PENDING_ASSIGNMENT when off; policy says so', async () => {
    const on = world();
    on.consent(on.ids.pA);
    expect((await selfBook(on)).value).toMatchObject({ status: 'REQUESTED', needsApproval: true, approval: 'PENDING', arrangedByDesk: false });
    expect((await request(on, { purpose: '  Client   visit ' })).value).toMatchObject({ status: 'REQUESTED', approval: 'PENDING', purpose: 'Client visit', journey: 'POINT_TO_POINT' });
    expect(await on.svc.policy(on.pax('u-pA'))).toMatchObject({ adhocRequests: true, approvalRequired: true, timeZone: TZ });
    const off = world({ approval: false });
    off.consent(off.ids.pA);
    expect((await selfBook(off)).value).toMatchObject({ status: 'PENDING_ASSIGNMENT', needsApproval: false, approval: 'NOT_REQUIRED' });
    expect((await request(off, {})).value).toMatchObject({ status: 'PENDING_ASSIGNMENT', approval: 'NOT_REQUIRED' });
    expect(await off.svc.policy(off.pax('u-pA'))).toMatchObject({ approvalRequired: false });
  });

  it('approve → BOOKING_APPROVED, reject → BOOKING_REJECTED: generic text, bookingId only, reason via MeBookingDto; never twice', async () => {
    const w = world();
    w.consent(w.ids.pA);
    const a = (await request(w, {})).value;
    const b = (await request(w, { ...win(13) })).value;
    const c = (await request(w, { ...win(16) })).value;
    expect(w.store.table('transportNotification')).toHaveLength(0); // the passenger's own requests: no BOOKING_CREATED
    await w.bookings.command(w.desk(), a.id, 'approve', {});
    expect(await codeOf(w.bookings.command(w.desk(), a.id, 'approve', {}))).toBe('INVALID_STATE');
    const bulk = await w.bookings.bulkApprove(w.desk(), [a.id, b.id, b.id]);
    expect(bulk).toEqual({ approved: [b.id], skipped: [{ id: a.id, code: 'INVALID_STATE' }] });
    await w.bookings.command(w.desk(), c.id, 'reject', { reason: 'No vehicle for that plant visit' });
    const rows = w.store.table('transportNotification');
    expect(rows.map((r) => [r.kind, r.bookingId]).sort()).toEqual([['BOOKING_APPROVED', a.id], ['BOOKING_APPROVED', b.id], ['BOOKING_REJECTED', c.id]].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ userId: 'u-pA', audience: 'PASSENGER', tripId: null, pushQueued: true });
      for (const t of [r.title, r.body]) for (const leak of ['plant', 'Office', 'Shuttle', 'Passenger', day(2)]) expect(String(t)).not.toContain(leak);
    }
    expect(w.store.table('notificationLog')).toHaveLength(3);
    const mine = await w.svc['me'].booking(w.pax('u-pA'), c.id);
    expect(mine).toMatchObject({ status: 'REJECTED', statusReason: 'No vehicle for that plant visit', approval: 'REJECTED' });
    expect(await w.svc['me'].booking(w.pax('u-pA'), a.id)).toMatchObject({ status: 'PENDING_ASSIGNMENT', approval: 'APPROVED', statusReason: null });
    // A desk booking without hold never needed approval; a desk reject of a PENDING booking notifies too.
    const d = await w.bookings.create(w.desk(), { passengerId: w.ids.pA, serviceDate: day(3), journey: 'POINT_TO_POINT', pickup: { lat: 0, lng: 0, poiId: w.ids.officeA }, drop: { lat: 0, lng: 0, poiId: w.ids.stopA }, ...win(10) , windowStart: new Date(Date.parse(win(10).windowStart) + 86_400_000).toISOString(), windowEnd: new Date(Date.parse(win(10).windowEnd) + 86_400_000).toISOString() } as never, randomUUID());
    expect(await w.svc['me'].booking(w.pax('u-pA'), d.value.id)).toMatchObject({ approval: 'NOT_REQUIRED', arrangedByDesk: true });
    expect(d.value).toMatchObject({ requestedByPassenger: false, groupId: null, groupSize: null });
    expect((await w.bookings.get(w.desk(), a.id))).toMatchObject({ requestedByPassenger: true, purpose: null });
  });

  it('pure helpers: decision kinds, approval state, purpose', () => {
    expect(decisionKind('approve', 'REQUESTED')).toBe('BOOKING_APPROVED');
    expect(decisionKind('approve', 'WAITLISTED')).toBe('BOOKING_APPROVED');
    expect(decisionKind('approve', 'ASSIGNED')).toBeNull(); // confirming a seat is not an approval
    expect(decisionKind('reject', 'PENDING_ASSIGNMENT')).toBe('BOOKING_REJECTED');
    expect(decisionKind('cancel', 'REQUESTED')).toBeNull();
    expect(meBookingApproval({ status: 'REQUESTED', approvedAt: null })).toBe('PENDING');
    expect(meBookingApproval({ status: 'CONFIRMED', approvedAt: new Date() })).toBe('APPROVED');
    expect(meBookingApproval({ status: 'PENDING_ASSIGNMENT', approvedAt: null })).toBe('NOT_REQUIRED');
    expect(cleanPurpose('   ')).toBeNull();
    expect(() => cleanPurpose('x'.repeat(121))).toThrow();
  });
});

describe('D-A7 passenger requests', () => {
  it('personal ends need consent (409 CONSENT_REQUIRED, nothing stored); never "needs location"', async () => {
    const w = world();
    for (const end of [{ kind: 'HOME' }, { kind: 'MAP', lat: 13.07, lng: 80.2, label: 'Gym' }, { kind: 'SAVED', placeId: randomUUID() }] as const) {
      const e = await errOf(request(w, { pickup: end as never }));
      expect([end.kind, e?.status, e?.body.code]).toEqual([end.kind, 409, 'CONSENT_REQUIRED']);
    }
    expect(w.store.table('transportBooking')).toHaveLength(0);
    w.consent(w.ids.pA);
    const r = (await request(w, { pickup: { kind: 'MAP', lat: 13.07, lng: 80.2, label: 'Gym' }, destination: { kind: 'HOME' } })).value;
    expect(r).toMatchObject({ pickupLabel: 'Gym', dropLabel: 'Home' });
    const stored = w.row('transportBooking', r.id);
    expect([stored.pickupLat, stored.dropLat]).toEqual([13.07, 13.061234]);
    // No home point at all: a clear 400, not a "needs location" booking.
    Object.assign(w.row('employeeTransportProfile', w.ids.pA), { homeLat: null, homeLng: null });
    expect(await codeOf(request(w, { destination: { kind: 'HOME' }, ...win(14) }))).toBe('VALIDATION_FAILED');
  });

  it('PLACE must be a request place (422 PLACE_NOT_ALLOWED); SHIFT_SITE needs the shift; limits: horizon, P2P window, COMMUTE direction', async () => {
    const w = world();
    expect((await errOf(request(w, { pickup: { kind: 'PLACE', poiId: w.ids.secretA } })))?.body).toMatchObject({ code: 'NOT_ELIGIBLE', reason: 'PLACE_NOT_ALLOWED' });
    expect((await errOf(request(w, { pickup: { kind: 'PLACE', poiId: w.ids.officeB } })))?.body).toMatchObject({ reason: 'PLACE_NOT_ALLOWED' });
    expect(await codeOf(request(w, { destination: { kind: 'SHIFT_SITE' } }))).toBe('VALIDATION_FAILED');
    const commute = await request(w, { journey: 'COMMUTE', direction: 'IN', shiftId: w.ids.shiftA, windowStart: undefined, windowEnd: undefined, destination: { kind: 'SHIFT_SITE' } });
    expect(commute.value).toMatchObject({ journey: 'COMMUTE', direction: 'IN', dropLabel: 'Plant A', status: 'REQUESTED' });
    expect(await codeOf(request(w, { journey: 'COMMUTE', direction: undefined }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(request(w, { windowStart: undefined, windowEnd: undefined }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(request(w, { serviceDate: day(15) }))).toBe('VALIDATION_FAILED');
    // Replay by key; same key + other body = 422.
    const key = randomUUID();
    const r1 = await request(w, { ...win(19) }, 'u-pA', key);
    expect((await request(w, { ...win(19) }, 'u-pA', key)).replay).toBe(true);
    expect(await codeOf(request(w, { ...win(19), purpose: 'Other' }, 'u-pA', key))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(w.row('transportBooking', r1.value.id)).toMatchObject({ passengerCount: 1, createdById: 'u-pA', note: 'Requested by passenger' });
    // Validation of the body shape.
    const bad = plainToInstance(MeAdhocRequestDto, { serviceDate: day(2), journey: 'POINT_TO_POINT', pickup: { kind: 'OFFICE' }, destination: { kind: 'HOME' }, purpose: 'x'.repeat(121) });
    expect((await validate(bad)).map((e) => e.property).sort()).toEqual(['pickup', 'purpose']);
  });

  it('request places: OFFICE / SHUTTLE_STOP places, shift sites and own stops of the own company only; self-service off = 404', async () => {
    const w = world();
    const names = (await w.svc.requestPlaces(w.pax('u-pA'), undefined)).map((p) => p.name).sort();
    expect(names).toEqual(['Office A', 'Plant A', 'Shuttle stop A']);
    expect((await w.svc.requestPlaces(w.pax('u-pA'), 'shut')).map((p) => p.id)).toEqual([w.ids.stopA]);
    expect((await w.svc.requestPlaces(w.pax('u-pB', 'custB'), undefined)).map((p) => p.name)).toEqual(['Office B']);
    (w.row('company', 'custA').settings as { etms: Record<string, unknown> }).etms.selfBooking = false;
    expect(await codeOf(w.svc.requestPlaces(w.pax('u-pA'), undefined))).toBe('SELF_BOOKING_DISABLED');
    expect(await codeOf(request(w, {}))).toBe('SELF_BOOKING_DISABLED');
  });

  it('saved-place consent now answers 409 (was 403)', async () => {
    const w = world();
    const e = await errOf(w.svc.addPlace(w.pax('u-pA'), { label: 'Gym', lat: 13.07, lng: 80.2 }));
    expect(e).toMatchObject({ status: 409, body: { code: 'CONSENT_REQUIRED' } });
  });
});

describe('D-A8 group booking', () => {
  const group = (w: ReturnType<typeof world>, o: Record<string, unknown> = {}) => ({
    passengerIds: [w.ids.pA, w.ids.pA2, w.ids.pA3],
    serviceDate: day(2),
    journey: 'POINT_TO_POINT',
    pickup: { mode: 'COMMON', point: { lat: 0, lng: 0, poiId: w.ids.officeA } },
    drop: { lat: 0, lng: 0, poiId: w.ids.stopA },
    ...win(10, 3),
    purpose: 'Site visit — plant 2',
    ...o,
  });

  it('creates one booking per passenger, shared groupId / purpose, one BOOKING_CREATED per passenger with a login; replay = same group', async () => {
    const w = world();
    const key = randomUUID();
    const r = await w.bookings.createGroup(w.desk(), group(w) as never, key);
    expect(r.replay).toBe(false);
    expect(r.value.bookings).toHaveLength(3);
    for (const b of r.value.bookings) expect(b).toMatchObject({ groupId: r.value.groupId, purpose: 'Site visit — plant 2', groupSize: 3, status: 'PENDING_ASSIGNMENT', journey: 'POINT_TO_POINT', requestedByPassenger: false });
    expect(w.store.table('transportNotification').map((n) => n.userId).sort()).toEqual(['u-pA', 'u-pA2']); // pA3 has no login
    const again = await w.bookings.createGroup(w.desk(), group(w) as never, key);
    expect(again).toMatchObject({ replay: true, value: { groupId: r.value.groupId } });
    expect(again.value.bookings.map((b) => b.id)).toEqual(r.value.bookings.map((b) => b.id));
    expect(w.store.table('transportBooking')).toHaveLength(3);
    expect(w.store.table('transportNotification')).toHaveLength(2);
    expect(await codeOf(w.bookings.createGroup(w.desk(), group(w, { purpose: 'Another' }) as never, key))).toBe('IDEMPOTENCY_KEY_REUSED');
    const list = (await w.bookings.list(w.desk(), { groupId: r.value.groupId } as never)) as { items: { id: string; groupSize: number }[] };
    expect(list.items.map((b) => b.groupSize)).toEqual([3, 3, 3]);
    expect(w.store.table('auditLog').filter((a) => a.entity === 'TransportBooking' && a.action === 'CREATE')).toHaveLength(3);
  });

  it('all or nothing: per-passenger failures collected → 422 GROUP_INVALID, nothing written', async () => {
    const w = world();
    Object.assign(w.row('employeeTransportProfile', w.ids.pA2), { anonymisedAt: new Date() });
    // pA already has an overlapping booking.
    await w.bookings.createGroup(w.desk(), group(w, { passengerIds: [w.ids.pA, w.ids.pA3], ...win(11, 1) }) as never, randomUUID());
    const before = w.store.table('transportBooking').length;
    const e = await errOf(w.bookings.createGroup(w.desk(), group(w) as never, randomUUID()));
    expect(e?.status).toBe(422);
    expect(e?.body).toMatchObject({ code: 'GROUP_INVALID' });
    expect(e?.body.failures).toEqual([
      { passengerId: w.ids.pA2, code: 'NOT_ELIGIBLE', reason: 'PASSENGER_ANONYMISED' },
      { passengerId: w.ids.pA, code: 'BOOKING_OVERLAP' },
      { passengerId: w.ids.pA3, code: 'BOOKING_OVERLAP' },
    ]);
    expect(w.store.table('transportBooking')).toHaveLength(before);
    // A one-time drop needs every passenger's consent (D-A3); OWN pickup without home / consent fails per passenger.
    const w2 = world();
    w2.consent(w2.ids.pA);
    const e2 = await errOf(w2.bookings.createGroup(w2.desk(), group(w2, { drop: { lat: 13.07, lng: 80.2, label: 'Client' } }) as never, randomUUID()));
    expect(e2?.body.failures).toEqual([{ passengerId: w2.ids.pA2, code: 'CONSENT_REQUIRED' }, { passengerId: w2.ids.pA3, code: 'CONSENT_REQUIRED' }]);
    w2.consent(w2.ids.pA2);
    Object.assign(w2.row('employeeTransportProfile', w2.ids.pA2), { homeLat: null, homeLng: null });
    Object.assign(w2.row('employeeTransportProfile', w2.ids.pA3), { defaultStopPoiId: w2.ids.stopA });
    const e3 = await errOf(w2.bookings.createGroup(w2.desk(), group(w2, { pickup: { mode: 'OWN' } }) as never, randomUUID()));
    expect(e3?.body.failures).toEqual([{ passengerId: w2.ids.pA2, code: 'NEEDS_LOCATION' }]);
    expect(w2.store.table('transportBooking')).toHaveLength(0);
    // COMMUTE duplicate per passenger.
    const w3 = world();
    await w3.bookings.create(w3.desk(), { passengerId: w3.ids.pA3, serviceDate: day(2), direction: 'IN', shiftId: w3.ids.shiftA, pickup: { lat: 0, lng: 0, poiId: w3.ids.stopA } } as never, randomUUID());
    const e4 = await errOf(w3.bookings.createGroup(w3.desk(), group(w3, { journey: 'COMMUTE', direction: 'IN', shiftId: w3.ids.shiftA, windowStart: undefined, windowEnd: undefined }) as never, randomUUID()));
    expect(e4?.body.failures).toEqual([{ passengerId: w3.ids.pA3, code: 'BOOKING_DUPLICATE' }]);
  });

  it('scope: another company\'s or another branch\'s passenger → 404 for the whole group; purpose required; 2..30', async () => {
    const w = world();
    expect(await codeOf(w.bookings.createGroup(w.desk(), group(w, { passengerIds: [w.ids.pA, w.ids.pB] }) as never, randomUUID()))).toBe('NOT_FOUND');
    const branch = w.desk({ dataScope: 'ASSIGNED', branchIds: ['brA1'] });
    expect(await codeOf(w.bookings.createGroup(branch, group(w, { passengerIds: [w.ids.pA, w.ids.pA2] }) as never, randomUUID()))).toBe('NOT_FOUND');
    expect(w.store.table('transportBooking')).toHaveLength(0);
    expect(await codeOf(w.bookings.createGroup(w.desk(), group(w, { purpose: '  ' }) as never, randomUUID()))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.bookings.createGroup(w.desk(), group(w, { passengerIds: [w.ids.pA, w.ids.pA] }) as never, randomUUID()))).toBe('VALIDATION_FAILED');
    // The pA3-without-branch passenger is in scope for a branch dispatcher of brA1 together with pA.
    const ok = await w.bookings.createGroup(branch, group(w, { passengerIds: [w.ids.pA, w.ids.pA3] }) as never, randomUUID());
    expect(ok.value.bookings).toHaveLength(2);
  });
});

describe('D-A9 own profile and home', () => {
  it('profile: own data only; home coordinates only with consent', async () => {
    const w = world();
    const p = await w.svc.profile(w.pax('u-pA'));
    expect(p).toMatchObject({ displayName: 'Passenger A1', employeeCode: 'A1', home: { address: '12 Secret Lane', lat: null, lng: null, source: 'PIN' }, routingConsent: false, emergencyContacts: [], accessibility: {} });
    w.consent(w.ids.pA);
    expect((await w.svc.profile(w.pax('u-pA'))).home).toMatchObject({ lat: 13.061234, lng: 80.241234 });
    expect(await codeOf(w.svc.profile(w.pax('u-desk')))).toBe('NOT_A_PASSENGER');
  });

  it('home: set needs consent (409), audited without coordinates or address; clear needs none; openBookingsKept', async () => {
    const w = world();
    expect(await codeOf(w.svc.setHome(w.pax('u-pA'), { lat: 13.1, lng: 80.3, address: 'New Street 5', source: 'PHOTON' }))).toBe('CONSENT_REQUIRED');
    w.consent(w.ids.pA);
    await request(w, {});
    await request(w, { ...win(14) });
    const r = await w.svc.setHome(w.pax('u-pA'), { lat: 13.123456789, lng: 80.3, address: '  New   Street 5 ', source: 'PHOTON' });
    expect(r).toMatchObject({ openBookingsKept: 2, profile: { home: { address: 'New Street 5', lat: 13.123457, lng: 80.3, source: 'PHOTON' } } });
    expect(await codeOf(w.svc.setHome(w.pax('u-pA'), { lat: 0, lng: 0 }))).toBe('VALIDATION_FAILED');
    const cleared = await w.svc.setHome(w.pax('u-pA'), { clear: true });
    expect(cleared.profile.home).toBeNull();
    const audits = JSON.stringify(w.store.table('auditLog').filter((a) => a.entity === 'EmployeeTransportProfile'));
    for (const leak of ['13.12', '80.3', 'New Street', 'Secret Lane', '13.06']) expect(audits).not.toContain(leak);
    expect(audits).toContain('homeCommand');
    // A rejected body shape (address too long).
    expect((await validate(plainToInstance(MeHomeLocationDto, { lat: 13, lng: 80, address: 'x'.repeat(201), source: 'GPS' }))).map((e) => e.property).sort()).toEqual(['address', 'source']);
  });

  it('PATCH profile: allowed default stop only, ≤ 3 valid emergency contacts, accessibility; audit has counts only', async () => {
    const w = world();
    expect(await codeOf(w.svc.updateProfile(w.pax('u-pA'), { defaultStopId: w.ids.secretA }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.svc.updateProfile(w.pax('u-pA'), { emergencyContacts: [{ name: 'Mum', phone: '12' }] }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.svc.updateProfile(w.pax('u-pA'), { emergencyContacts: Array.from({ length: 4 }, () => ({ name: 'X', phone: '+919876543210' })) }))).toBe('VALIDATION_FAILED');
    expect((await validate(plainToInstance(MeTransportProfileUpdateDto, { emergencyContacts: Array.from({ length: 4 }, () => ({ name: 'X', phone: '+919876543210' })) }))).map((e) => e.property)).toEqual(['emergencyContacts']);
    const p = await w.svc.updateProfile(w.pax('u-pA'), { defaultStopId: w.ids.siteA, emergencyContacts: [{ name: ' Asha  K ', phone: '98765 43210', relation: 'Sister' }], accessibility: { wheelchair: true, notes: 'Ramp needed' } });
    expect(p).toMatchObject({ defaultStop: { id: w.ids.siteA, name: 'Plant A' }, emergencyContacts: [{ name: 'Asha K', phone: '+919876543210', relation: 'Sister' }], accessibility: { wheelchair: true, notes: 'Ramp needed' } });
    const audit = JSON.stringify(w.store.table('auditLog').filter((a) => a.entity === 'EmployeeTransportProfile'));
    for (const leak of ['Asha', '98765', 'Ramp', 'Sister']) expect(audit).not.toContain(leak);
    expect(audit).toContain('emergencyContactCount');
  });

  it('geocode: self-hosted only (503 GEOCODER_NOT_PRIVATE), ≥ 3 chars, ≤ 6 hits without extra fields, 20 / min per user', async () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ label: `Road ${i}`, lat: 13 + i / 100, lng: 80.2, confidence: 0.9 }));
    const w = world({ geocodeHits: hits });
    expect(await codeOf(w.svc.geocode(w.pax('u-pA'), 'ab'))).toBe('VALIDATION_FAILED');
    const r = await w.svc.geocode(w.pax('u-pA'), 'Road');
    expect(r).toHaveLength(6);
    expect(r[0]).toEqual({ label: 'Road 0', lat: 13, lng: 80.2 });
    const env = { ...process.env };
    try {
      process.env.GEOCODER = 'photon';
      process.env.GEOCODER_URL = 'https://photon.example.com';
      expect(await codeOf(w.svc.geocode(w.pax('u-pA'), 'Road'))).toBe('GEOCODER_NOT_PRIVATE');
    } finally {
      process.env.GEOCODER = env.GEOCODER;
      process.env.GEOCODER_URL = env.GEOCODER_URL;
      if (env.GEOCODER === undefined) delete process.env.GEOCODER;
      if (env.GEOCODER_URL === undefined) delete process.env.GEOCODER_URL;
    }
    // 2 searches so far (the guarded one counts too): 18 more reach the limit of 20.
    for (let i = 0; i < 18; i++) await w.svc.geocode(w.pax('u-pA'), 'Road');
    const e = await errOf(w.svc.geocode(w.pax('u-pA'), 'Road'));
    expect(e).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect(await codeOf(w.svc.geocode(w.pax('u-pA2'), 'Road'))).toBe('OK'); // per user
  });
});

const csvText = async (f: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of (f as StreamableFile).getStream()) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

describe('v1.15.0 security review fixes', () => {
  const homeP2P = (w: ReturnType<typeof world>, label = '12 Secret Lane, Ward 4', start = 10) =>
    w.bookings.create(w.desk(), { passengerId: w.ids.pA, serviceDate: day(2), journey: 'POINT_TO_POINT', pickup: { lat: 13.07, lng: 80.2, label }, drop: { lat: 0, lng: 0, poiId: w.ids.officeA }, ...win(start) } as never, randomUUID());

  it('M1: a personal end\'s label never reaches list rows, CSV or list search; detail keeps it only with consent; the passenger keeps it', async () => {
    const w = world();
    w.consent(w.ids.pA);
    const b = (await homeP2P(w)).value;
    expect(b).toMatchObject({ pickupLabel: '12 Secret Lane, Ward 4', dropLabel: 'Office A' }); // detail + consent
    const list = (await w.bookings.list(w.desk(), {} as never)) as { items: { id: string; pickupLabel: string | null; dropLabel: string | null; pointsHidden: string | null }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ pickupLabel: null, dropLabel: 'Office A', pointsHidden: 'LIST_VIEW' });
    const csv = await csvText(await w.bookings.list(w.desk(), { format: 'csv' } as never));
    expect(csv).not.toContain('Secret');
    expect(csv).toContain('Office A');
    // List search (q) on labels: the memory store cannot evaluate relation filters; see etms-adhoc-booking.db-test.ts.
    // The passenger sees their own label.
    expect((await w.me.bookings(w.pax('u-pA'), {} as never)).find((m) => m.id === b.id)).toMatchObject({ pickupLabel: '12 Secret Lane, Ward 4' });
    // Consent withdrawn (row kept as is): detail, list and CSV show no personal label.
    w.store.insert('employeeTransportConsent', { companyId: 'custA', profileId: w.ids.pA, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: false, channel: 'WEB', occurredAt: new Date() });
    expect(await w.bookings.get(w.desk(), b.id)).toMatchObject({ pickup: null, pickupLabel: null, dropLabel: 'Office A', pointsHidden: 'CONSENT_REQUIRED' });
    expect(await csvText(await w.bookings.list(w.desk(), { format: 'csv' } as never))).not.toContain('Secret');
  });
});

describe('v1.15 M2 desk geocode', () => {
  it('GET /transport/bookings/geocode: ≥ 3 characters (400), 20 / min per user (429 RATE_LIMITED with retryAfterSec)', async () => {
    const w = world();
    const calls: string[] = [];
    const search = async (term: string) => (calls.push(term), [{ label: 'Road 1', lat: 13, lng: 80.2, confidence: 0.9, matchType: 'street' }] as never);
    expect(await codeOf(w.bookings.geocode(w.desk(), '  ab ', search))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.bookings.geocode(w.desk(), undefined, search))).toBe('VALIDATION_FAILED');
    expect(calls).toEqual([]);
    for (let i = 0; i < 20; i++) expect(await w.bookings.geocode(w.desk(), ' Road ', search)).toHaveLength(1);
    expect(calls[0]).toBe('Road');
    const e = await errOf(w.bookings.geocode(w.desk(), 'Road', search));
    expect(e).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED', retryAfterSec: expect.any(Number) } });
    expect(calls).toHaveLength(20);
    expect(await codeOf(w.bookings.geocode(w.desk({ userId: 'u-other' }), 'Road', search))).toBe('OK'); // per user
  });
});

describe('v1.15 L1 booking places follow the branch POI scope', () => {
  it('a branch dispatcher lists and books its branches\' places and company-wide ones only; company scope unchanged', async () => {
    const w = world();
    const north = w.store.insert('poi', { companyId: 'custA', branchId: 'brA1', name: 'North gate', category: 'OFFICE', lat: 13.1, lng: 80.2, isActive: true }).id as string;
    const south = w.store.insert('poi', { companyId: 'custA', branchId: 'brA2', name: 'South gate', category: 'OFFICE', lat: 13.2, lng: 80.2, isActive: true }).id as string;
    const branch = w.desk({ dataScope: 'ASSIGNED', branchIds: ['brA1'] });
    const names = async (ctx: AuthContext) => (await w.bookings.places(ctx, undefined)).map((p) => p.id);
    expect(await names(branch)).toEqual(expect.arrayContaining([north, w.ids.officeA]));
    expect(await names(branch)).not.toContain(south);
    expect(await names(w.desk())).toEqual(expect.arrayContaining([north, south, w.ids.officeA]));
    const book = (ctx: AuthContext, poiId: string, h: number) =>
      w.bookings.create(ctx, { passengerId: w.ids.pA, serviceDate: day(2), journey: 'POINT_TO_POINT', pickup: { lat: 0, lng: 0, poiId }, drop: { lat: 0, lng: 0, poiId: w.ids.officeA }, ...win(h) } as never, randomUUID());
    expect((await errOf(book(branch, south, 8)))?.body).toMatchObject({ code: 'NOT_ELIGIBLE', reason: 'PLACE_NOT_ALLOWED' });
    expect(await codeOf(book(branch, north, 10))).toBe('OK');
    expect(await codeOf(book(w.desk(), south, 12))).toBe('OK');
  });
});

describe('v1.15 L2 group booking personal-point access', () => {
  it('create and replay that return passengers\' personal points write the L1 ACCESS entry; company places do not', async () => {
    const w = world();
    w.consent(w.ids.pA);
    w.consent(w.ids.pA2);
    const access = () => w.store.table('auditLog').filter((a) => a.action === 'ACCESS' && a.entity === 'TransportPersonalPoints');
    const base = { passengerIds: [w.ids.pA, w.ids.pA2], serviceDate: day(2), journey: 'POINT_TO_POINT', drop: { lat: 0, lng: 0, poiId: w.ids.stopA }, ...win(10, 3), purpose: 'Site visit' };
    await w.bookings.createGroup(w.desk(), { ...base, pickup: { mode: 'COMMON', point: { lat: 0, lng: 0, poiId: w.ids.officeA } } } as never, randomUUID());
    expect(access()).toHaveLength(0);
    const key = randomUUID();
    const own = await w.bookings.createGroup(w.desk(), { ...base, ...win(15, 2), pickup: { mode: 'OWN' } } as never, key);
    expect(own.value.bookings.every((b) => b.pickup && !b.pickup.poiId)).toBe(true);
    expect(access()).toHaveLength(1);
    expect(access()[0].changes).toMatchObject({ view: 'group', profileIds: [w.ids.pA, w.ids.pA2].sort(), passengers: 2, precise: true, groupId: own.value.groupId });
    await w.bookings.createGroup(w.desk(), { ...base, ...win(15, 2), pickup: { mode: 'OWN' } } as never, key); // replay
    expect(access()).toHaveLength(2);
    expect(access()[1].changes).toMatchObject({ view: 'group', groupId: own.value.groupId, replay: true });
  });
});
