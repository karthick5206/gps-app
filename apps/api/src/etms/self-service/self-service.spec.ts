jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import { confirmMismatch, transportSettingsOf, type MeCreateBookingInput } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { addDays } from '../../summarizer/tz';
import { BookingsService } from '../dispatch/bookings.service';
import { MeTransportService } from '../dispatch/me-transport.service';
import { todayIn, weekdayOf } from '../dispatch/service-dates';
import { ConsentNoticeService } from '../people/consent-notice.service';
import { PeopleService } from '../people/people.service';
import { TransportSettingsService } from '../settings/transport-settings.service';
import { MemoryStore } from '../testing/memory-store';
import { MeCreateBookingDto, MeTripConfirmDto, MeTripReportDto } from './self-service.dto';
import { placesOf, selfBookingOn, SelfServiceService } from './self-service.service';

const MIN = 60_000;
const TZ = 'Asia/Kolkata';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Passenger self-service on the in-memory Prisma stand-in (real services, real where-clauses): OFF by default, own
 * profile only, cross-company isolation, the cut-off / horizon / shift-day rules on top of the E3 booking create,
 * consent for personal places, confirm as a dispute signal (P5) and reports.
 */
function world(opts: { selfBooking?: boolean; tripStartInMin?: number } = {}) {
  const store = new MemoryStore();
  const etms = (on: boolean) => ({ features: ['etms'], etms: { directoryListed: false, ...(on ? { selfBooking: true } : {}) } });
  store.insert('company', { id: 'custA', name: 'custA', timezone: TZ, settings: etms(opts.selfBooking ?? true) });
  store.insert('company', { id: 'custB', name: 'custB', timezone: TZ, settings: etms(true) });
  for (const [id, companyId] of [['u-pA', 'custA'], ['u-pA2', 'custA'], ['u-pB', 'custB'], ['u-nobody', 'custA']]) store.insert('user', { id, companyId, name: id });
  const site = (companyId: string, name: string) => store.insert('poi', { companyId, name, category: 'OTHER', lat: 13.05, lng: 80.25, isActive: true }).id as string;
  const siteA = site('custA', 'Office A');
  const stopA = site('custA', 'Shuttle stop A');
  const secretA = site('custA', 'Customer depot (not a transport stop)');
  const siteB = site('custB', 'Office B');
  // A shift late in the evening so its IN window (login − 90 min) is still ahead today in most runs; tests that need a
  // future day use tomorrow.
  const shift = (companyId: string, sitePoiId: string, name: string, startMin = 9 * 60) =>
    store.insert('transportShift', { companyId, sitePoiId, name, startMin, endMin: startMin + 9 * 60, overnight: false, days: ALL_DAYS, timeZone: TZ, isActive: true }).id as string;
  const shiftA = shift('custA', siteA, 'General A');
  const shiftB = shift('custB', siteB, 'General B');
  const profile = (companyId: string, code: string, userId: string | null, defaultStopPoiId: string | null = null) =>
    store.insert('employeeTransportProfile', { companyId, employeeCode: code, displayName: `Passenger ${code}`, userId, isActive: true, homeLat: 13.061234, homeLng: 80.241234, homeAddress: '12 Secret Lane', defaultStopPoiId, branchId: 'brA1', preferences: {} }).id as string;
  const pA = profile('custA', 'A1', 'u-pA', stopA);
  const pA2 = profile('custA', 'A2', 'u-pA2');
  const pB = profile('custB', 'B1', 'u-pB');

  // A published trip seating pA (custA) and pB (custB) each.
  const start = Date.now() + (opts.tripStartInMin ?? 10) * MIN;
  const trip = (companyId: string, profileId: string) => {
    const vehicle = store.insert('trackedObject', { companyId, name: `Van ${companyId}`, plateNumber: null, isActive: true }).id as string;
    const pt = store.insert('plannedTrip', { companyId, origin: 'ETMS', objectId: vehicle, driverId: null, routeName: 'Login', plannedStart: new Date(start), plannedEnd: new Date(start + 60 * MIN), status: 'SCHEDULED', actualStart: null, actualEnd: null, nextStopSeq: null });
    const tt = store.insert('transportTrip', { plannedTripId: pt.id, providerCompanyId: companyId, customerCompanyId: companyId, serviceDate: new Date(`${todayIn(TZ, start)}T00:00:00Z`), direction: 'IN', seatCapacity: 4, occupiedSeats: 1, publishedAt: new Date() });
    const b = store.insert('transportBooking', { customerCompanyId: companyId, providerCompanyId: companyId, profileId, status: 'ASSIGNED', source: 'ADHOC', serviceDate: tt.serviceDate, direction: 'IN', timeZone: TZ, windowStart: new Date(start - 30 * MIN), windowEnd: new Date(start + 60 * MIN), version: 1 });
    const seat = store.insert('transportTripPassenger', { tripId: tt.id, bookingId: b.id, customerCompanyId: companyId, providerCompanyId: companyId, pickupSeq: 0, dropSeq: 1, seats: 1, status: 'PENDING', droppedAt: null });
    return { tt: tt.id as string, pt: pt.id as string, seat: seat.id as string };
  };
  const tripA = trip('custA', pA);
  const tripB = trip('custB', pB);

  const prisma = store.client();
  const audit = new AuditService(prisma as never);
  const redis = { client: { get: async () => null, set: async () => 'OK', eval: async () => 1, publish: async () => 1 } };
  const people = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
  const bookings = new BookingsService(prisma as never, audit, redis as never);
  const me = new MeTransportService(prisma as never, people, redis as never);
  const svc = new SelfServiceService(prisma as never, audit, people, bookings, me);
  const ctx = (userId: string, companyId = 'custA'): AuthContext => ({
    userId,
    homeCompanyId: companyId,
    companyId,
    isSuperAdmin: false,
    permissions: { etms_self: ['view'] },
    dataScope: 'ASSIGNED',
    branchIds: [],
    objectIds: [],
    features: ['etms'],
    agreements: [],
    ip: null,
  });
  const consent = (profileId: string, companyId = 'custA', granted = true) =>
    store.insert('employeeTransportConsent', { companyId, profileId, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted, channel: 'WEB', occurredAt: new Date(Date.now() - 60 * MIN) });
  const row = (model: string, id: string) => store.table(model).find((r) => r.id === id)!;
  return { store, svc, ctx, consent, row, audit, ids: { siteA, stopA, secretA, siteB, shiftA, shiftB, pA, pA2, pB, tripA, tripB } };
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: HttpException) => (e.getResponse() as { code?: string }).code ?? String(e.getStatus()));
const statusOf = async (p: Promise<unknown>) => p.then(() => 200, (e: HttpException) => e.getStatus());
const tomorrow = () => addDays(todayIn(TZ), 1);
const book = (w: ReturnType<typeof world>, body: Partial<MeCreateBookingInput> = {}, user = 'u-pA', company = 'custA', key = randomUUID()) =>
  w.svc.createBooking(w.ctx(user, company), { serviceDate: tomorrow(), direction: 'IN', shiftId: company === 'custA' ? w.ids.shiftA : w.ids.shiftB, place: { kind: 'HOME' }, ...body } as MeCreateBookingDto, key);

describe('self-service: company setting selfBooking (default OFF)', () => {
  it('reads as off unless exactly true; the settings PATCH switches it and audits', async () => {
    expect(transportSettingsOf({ etms: {} }).selfBooking).toBeUndefined();
    expect(selfBookingOn({ etms: { selfBooking: 'true' } })).toBe(false);
    expect(selfBookingOn({ features: ['etms'] })).toBe(false);
    expect(selfBookingOn({ etms: { selfBooking: true } })).toBe(true);
    const w = world({ selfBooking: false });
    const settings = new TransportSettingsService(
      {
        company: w.store.client().company,
        $executeRaw: async (_s: TemplateStringsArray, key: string, json: string) => ((w.row('company', 'custA').settings as Record<string, unknown>)[key] = JSON.parse(json)),
        $transaction: async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: async (_s: TemplateStringsArray, key: string, json: string) => ((w.row('company', 'custA').settings as Record<string, unknown>)[key] = JSON.parse(json)) }),
      } as never,
      { record: async () => undefined } as never,
    );
    const admin = { ...w.ctx('u-admin'), dataScope: 'COMPANY' } as AuthContext;
    expect((await settings.update(admin, { selfBooking: true })).selfBooking).toBe(true);
    expect(selfBookingOn(w.row('company', 'custA').settings)).toBe(true);
    expect((await settings.update(admin, { selfBooking: false })).selfBooking).toBeUndefined();
  });

  it('while off: policy answers selfBooking false with no shifts / stops; every other route is 404 SELF_BOOKING_DISABLED', async () => {
    const w = world({ selfBooking: false });
    const p = await w.svc.policy(w.ctx('u-pA'));
    expect(p).toMatchObject({ selfBooking: false, shifts: [], stops: [], sos: true, cutoffMin: 60 });
    const c = w.ctx('u-pA');
    const calls: Promise<unknown>[] = [
      book(w),
      w.svc.commute(c),
      w.svc.places(c),
      w.svc.addPlace(c, { label: 'Gym', lat: 13.07, lng: 80.2 }),
      w.svc.updatePlace(c, randomUUID(), { label: 'X' }),
      w.svc.deletePlace(c, randomUUID()),
      w.svc.confirm(c, w.ids.tripA.tt, { clientEventId: randomUUID(), kind: 'PICKUP' }),
      w.svc.report(c, w.ids.tripA.tt, { clientEventId: randomUUID(), category: 'DELAY' }),
    ];
    for (const call of calls) expect(await codeOf(call)).toBe('SELF_BOOKING_DISABLED');
    expect(w.store.table('transportBooking')).toHaveLength(2); // only the seeded ones
    expect(w.store.table('transportTripEvent')).toHaveLength(0);
  });

  it('a login without an active passenger profile is 403 NOT_A_PASSENGER, also for policy', async () => {
    const w = world();
    expect(await codeOf(w.svc.policy(w.ctx('u-nobody')))).toBe('NOT_A_PASSENGER');
    expect(await codeOf(book(w, {}, 'u-nobody'))).toBe('NOT_A_PASSENGER');
    // A passenger of custA acting in custB (switched context) has no profile there.
    expect(await codeOf(w.svc.places(w.ctx('u-pA', 'custB')))).toBe('NOT_A_PASSENGER');
  });
});

describe('self-service: booking reuses the E3 rules', () => {
  it('books one seat on the own profile, REQUESTED (D-A5 approval default on), cut-off from the company setting, audited; replay by key', async () => {
    const w = world();
    w.consent(w.ids.pA);
    const key = randomUUID();
    const r = await book(w, { note: 'Late meeting' }, 'u-pA', 'custA', key);
    expect(r.replay).toBe(false);
    expect(r.value).toMatchObject({ status: 'REQUESTED', needsApproval: true, direction: 'IN', serviceDate: tomorrow(), dropLabel: 'Office A' });
    const row = w.row('transportBooking', r.value.id);
    expect(row).toMatchObject({ profileId: w.ids.pA, customerCompanyId: 'custA', passengerCount: 1, createdById: 'u-pA', pickupPoiId: w.ids.stopA, note: 'Booked by passenger: Late meeting' });
    expect((row.windowStart as Date).getTime() - (row.cutoffAt as Date).getTime()).toBe(60 * MIN);
    expect(w.store.table('auditLog').some((a) => a.entity === 'TransportBooking' && a.entityId === r.value.id && a.action === 'CREATE')).toBe(true);
    const again = await book(w, { note: 'Late meeting' }, 'u-pA', 'custA', key);
    expect(again).toMatchObject({ replay: true, value: { id: r.value.id } });
    expect(await codeOf(book(w, { note: 'Other body' }, 'u-pA', 'custA', key))).toBe('IDEMPOTENCY_KEY_REUSED');
    // Same date + direction again with another key: the E3 duplicate rule.
    expect(await codeOf(book(w))).toBe('BOOKING_DUPLICATE');
  });

  it('company cut-off: a leg whose cut-off has passed is 409 AFTER_CUTOFF (bookingCutoffMin honoured)', async () => {
    const w = world();
    const today = todayIn(TZ);
    // A shift whose IN window started an hour ago today: always after the cut-off.
    const nowLocalMin = Math.floor((Date.now() + 5.5 * 60 * MIN) / MIN) % (24 * 60);
    const login = Math.max(91, nowLocalMin + 30); // window start = login − 90 min ≤ now
    if (login < 24 * 60) {
      const late = w.store.insert('transportShift', { companyId: 'custA', sitePoiId: w.ids.siteA, name: 'Soon', startMin: login, endMin: Math.min(login + 60, 24 * 60 - 1), overnight: false, days: ALL_DAYS, timeZone: TZ, isActive: true }).id as string;
      expect(await codeOf(book(w, { serviceDate: today, shiftId: late }))).toBe('AFTER_CUTOFF');
    }
    // Tomorrow 00:30 login (window from 23:00 today) is fine with the default 60 min only until 22:00; with a cut-off of a
    // full day it is always too late.
    (w.row('company', 'custA').settings as { etms: Record<string, unknown> }).etms.bookingCutoffMin = 24 * 60;
    const shiftEarly = w.store.insert('transportShift', { companyId: 'custA', sitePoiId: w.ids.siteA, name: 'Early', startMin: 30, endMin: 9 * 60, overnight: false, days: ALL_DAYS, timeZone: TZ, isActive: true }).id as string;
    expect(await codeOf(book(w, { shiftId: shiftEarly }))).toBe('AFTER_CUTOFF');
    expect(w.store.table('transportBooking')).toHaveLength(2);
  });

  it('horizon, past dates, shift days and archived / foreign shifts are refused (400)', async () => {
    const w = world();
    expect(await codeOf(book(w, { serviceDate: addDays(todayIn(TZ), 15) }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(book(w, { serviceDate: addDays(todayIn(TZ), -1) }))).toBe('VALIDATION_FAILED');
    w.row('transportShift', w.ids.shiftA).days = ALL_DAYS.filter((d) => d !== weekdayOf(tomorrow()));
    expect(await codeOf(book(w))).toBe('VALIDATION_FAILED');
    w.row('transportShift', w.ids.shiftA).days = ALL_DAYS;
    expect(await codeOf(book(w, { shiftId: w.ids.shiftB }))).toBe('VALIDATION_FAILED'); // custB's shift
    w.row('transportShift', w.ids.shiftA).isActive = false;
    expect(await codeOf(book(w))).toBe('VALIDATION_FAILED');
  });

  it('HOME without routing consent keeps the E3 rule: booked "needs location" (no personal point used)', async () => {
    const w = world();
    const r = await book(w);
    expect(w.row('transportBooking', r.value.id)).toMatchObject({ pickupLat: null, pickupLng: null, dropPoiId: w.ids.siteA });
    expect(r.value.pickupLabel).toBeNull();
  });

  it('STOP: only the passenger’s own transport stops / shift sites; any other company place is refused', async () => {
    const w = world();
    const r = await book(w, { place: { kind: 'STOP', poiId: w.ids.stopA } });
    expect(w.row('transportBooking', r.value.id)).toMatchObject({ pickupPoiId: w.ids.stopA, pickupLabel: 'Shuttle stop A' });
    const w2 = world();
    expect(await codeOf(book(w2, { place: { kind: 'STOP', poiId: w2.ids.secretA } }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(book(w2, { place: { kind: 'STOP', poiId: w2.ids.siteB } }))).toBe('VALIDATION_FAILED');
    const p = await w2.svc.policy(w2.ctx('u-pA'));
    expect(p.stops.map((s) => s.name).sort()).toEqual(['Office A', 'Shuttle stop A']);
    expect(p.shifts.map((s) => s.name)).toEqual(['General A']);
  });

  it('OUT leg: the passenger point is the drop; the site is the pickup', async () => {
    const w = world();
    const r = await book(w, { direction: 'OUT', place: { kind: 'STOP', poiId: w.ids.stopA } });
    expect(w.row('transportBooking', r.value.id)).toMatchObject({ pickupPoiId: w.ids.siteA, dropPoiId: w.ids.stopA });
  });

  it('DTO validation: kind must be HOME / SAVED / STOP; serviceDate a date; note ≤ 200', async () => {
    const errs = async (b: unknown) => (await validate(plainToInstance(MeCreateBookingDto, b))).length;
    const ok = { serviceDate: '2026-11-20', direction: 'IN', shiftId: randomUUID(), place: { kind: 'HOME' } };
    expect(await errs(ok)).toBe(0);
    expect(await errs({ ...ok, place: { kind: 'ANYWHERE' } })).toBeGreaterThan(0);
    expect(await errs({ ...ok, serviceDate: 'tomorrow' })).toBeGreaterThan(0);
    expect(await errs({ ...ok, note: 'x'.repeat(201) })).toBeGreaterThan(0);
    expect(await errs({ ...ok, passengerId: randomUUID() })).toBe(0); // extra fields are stripped by the global whitelist pipe
  });
});

describe('self-service: saved places (personal points)', () => {
  it('need routing consent to add / change / use; coordinates hidden without it; delete always allowed', async () => {
    const w = world();
    const c = w.ctx('u-pA');
    expect(await codeOf(w.svc.addPlace(c, { label: 'Gym', lat: 13.07, lng: 80.2 }))).toBe('CONSENT_REQUIRED');
    const consentRow = w.consent(w.ids.pA);
    const gym = await w.svc.addPlace(c, { label: '  Gym   near   park ', lat: 13.07, lng: 80.2 });
    expect(gym).toMatchObject({ label: 'Gym near park', lat: 13.07, lng: 80.2 });
    expect(await w.svc.places(c)).toEqual([gym]);
    const r = await book(w, { place: { kind: 'SAVED', placeId: gym.id } });
    expect(w.row('transportBooking', r.value.id)).toMatchObject({ pickupLat: 13.07, pickupLng: 80.2, pickupLabel: 'Gym near park', pickupPoiId: null });
    // Audit without coordinates.
    const audits = w.store.table('auditLog').filter((a) => a.entity === 'EmployeeTransportProfile');
    expect(JSON.stringify(audits)).not.toContain('13.07');
    // Consent withdrawn: coordinates hidden, use refused, the place itself kept (owner decision on withdrawal pending).
    consentRow.occurredAt = new Date(Date.now() - 120 * MIN);
    w.store.insert('employeeTransportConsent', { companyId: 'custA', profileId: w.ids.pA, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: false, channel: 'SELF_WITHDRAWN', occurredAt: new Date(Date.now() - MIN) });
    expect(await w.svc.places(c)).toEqual([{ ...gym, lat: null, lng: null }]);
    expect(await codeOf(book(w, { serviceDate: addDays(todayIn(TZ), 2), place: { kind: 'SAVED', placeId: gym.id } }))).toBe('CONSENT_REQUIRED');
    expect(await codeOf(w.svc.updatePlace(c, gym.id, { label: 'Gym 2' }))).toBe('CONSENT_REQUIRED');
    expect(await w.svc.deletePlace(c, gym.id)).toEqual({ deleted: true });
    expect(await w.svc.places(c)).toEqual([]);
  });

  it('are per profile: another passenger (same or other company) cannot see, change or book them; other keys are kept', async () => {
    const w = world();
    w.consent(w.ids.pA);
    w.consent(w.ids.pA2);
    w.consent(w.ids.pB, 'custB');
    w.row('employeeTransportProfile', w.ids.pA).preferences = { notifications: { push: false } };
    const gym = await w.svc.addPlace(w.ctx('u-pA'), { label: 'Gym', lat: 13.07, lng: 80.2 });
    expect(w.row('employeeTransportProfile', w.ids.pA).preferences).toMatchObject({ notifications: { push: false } });
    expect(await w.svc.places(w.ctx('u-pA2'))).toEqual([]);
    expect(await w.svc.places(w.ctx('u-pB', 'custB'))).toEqual([]);
    expect(await codeOf(w.svc.updatePlace(w.ctx('u-pA2'), gym.id, { label: 'Mine' }))).toBe('NOT_FOUND');
    expect(await codeOf(w.svc.deletePlace(w.ctx('u-pB', 'custB'), gym.id))).toBe('NOT_FOUND');
    expect(await codeOf(book(w, { place: { kind: 'SAVED', placeId: gym.id } }, 'u-pA2'))).toBe('VALIDATION_FAILED');
    expect(placesOf(w.row('employeeTransportProfile', w.ids.pA).preferences)).toHaveLength(1);
  });

  it('at most 10, valid points only (not 0,0), label required', async () => {
    const w = world();
    w.consent(w.ids.pA);
    const c = w.ctx('u-pA');
    expect(await codeOf(w.svc.addPlace(c, { label: 'Null island', lat: 0, lng: 0 }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.svc.addPlace(c, { label: '   ', lat: 13, lng: 80 }))).toBe('VALIDATION_FAILED');
    for (let i = 0; i < 10; i++) await w.svc.addPlace(c, { label: `P${i}`, lat: 13 + i / 100, lng: 80 });
    expect(await codeOf(w.svc.addPlace(c, { label: 'P11', lat: 13.5, lng: 80 }))).toBe('VALIDATION_FAILED');
  });
});

describe('self-service: commute view', () => {
  it('lists own active schedules (shift, days, upcoming exceptions) and own upcoming bookings only', async () => {
    const w = world();
    const sched = w.store.insert('transportSchedule', { companyId: 'custA', profileId: w.ids.pA, shiftId: w.ids.shiftA, direction: 'IN', days: [5, 1, 3], pickupMode: 'STOP', stopPoiId: w.ids.stopA, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, isActive: true, version: 1 });
    w.store.insert('transportScheduleException', { companyId: 'custA', scheduleId: sched.id, date: new Date(`${tomorrow()}T00:00:00Z`), kind: 'SKIP' });
    w.store.insert('transportSchedule', { companyId: 'custA', profileId: w.ids.pA2, shiftId: w.ids.shiftA, direction: 'OUT', days: [1], pickupMode: 'HOME', stopPoiId: null, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, isActive: true, version: 1 });
    const c = await w.svc.commute(w.ctx('u-pA'));
    expect(c.schedules).toHaveLength(1);
    expect(c.schedules[0]).toMatchObject({ shiftName: 'General A', direction: 'IN', days: [1, 3, 5], pickupMode: 'STOP', validTo: null });
    expect(JSON.stringify(c)).not.toContain('Secret Lane');
    const cB = await w.svc.commute(w.ctx('u-pB', 'custB'));
    expect(cB.schedules).toEqual([]);
    expect(cB.upcoming.every((b) => !w.store.table('transportBooking').find((r) => r.id === b.id && r.customerCompanyId === 'custA'))).toBe(true);
  });
});

describe('self-service: confirm (P5 dispute signal) and report', () => {
  it('confirm records PASSENGER_CONFIRM (actor PASSENGER, source PASSENGER_APP) and never changes the seat; idempotent', async () => {
    const w = world();
    const id = randomUUID();
    const r = await w.svc.confirm(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: id, kind: 'PICKUP' });
    expect(r).toEqual({ clientEventId: id, outcome: 'ACCEPTED', myStatus: 'PENDING', mismatch: false });
    expect(w.row('transportTripPassenger', w.ids.tripA.seat).status).toBe('PENDING');
    const evs = w.store.table('transportTripEvent');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'PASSENGER_CONFIRM', actorType: 'PASSENGER', source: 'PASSENGER_APP', actorUserId: 'u-pA', reasonCode: 'PICKUP', passengerTripId: w.ids.tripA.seat, stopSeq: 0 });
    expect((await w.svc.confirm(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: id, kind: 'PICKUP' })).outcome).toBe('DUPLICATE');
    expect(await codeOf(w.svc.confirm(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: id, kind: 'DROP' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(w.store.table('transportTripEvent')).toHaveLength(1);
  });

  it('confirm on a no-show seat is accepted with mismatch true (the desk sees the dispute)', async () => {
    const w = world();
    w.row('transportTripPassenger', w.ids.tripA.seat).status = 'NO_SHOW';
    const r = await w.svc.confirm(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: randomUUID(), kind: 'PICKUP' });
    expect(r).toMatchObject({ outcome: 'ACCEPTED', myStatus: 'NO_SHOW', mismatch: true });
    expect(w.store.table('transportTripEvent')[0].data).toMatchObject({ mismatch: true, recordedStatus: 'NO_SHOW' });
  });

  it('confirm outside the trip window is 409 INVALID_STATE', async () => {
    const w = world({ tripStartInMin: 6 * 60 });
    expect(await codeOf(w.svc.confirm(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: randomUUID(), kind: 'PICKUP' }))).toBe('INVALID_STATE');
  });

  it('report stores the category and a trimmed note; outside [start − 2 h, end + 48 h] is refused', async () => {
    const w = world();
    const r = await w.svc.report(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: randomUUID(), category: 'DELAY', note: '  Cab is late  ' });
    expect(r.outcome).toBe('ACCEPTED');
    expect(w.store.table('transportTripEvent')[0]).toMatchObject({ kind: 'PASSENGER_REPORT', reasonCode: 'DELAY', data: { category: 'DELAY', note: 'Cab is late' }, actorType: 'PASSENGER' });
    const far = world({ tripStartInMin: 5 * 60 });
    expect(await codeOf(far.svc.report(far.ctx('u-pA'), far.ids.tripA.tt, { clientEventId: randomUUID(), category: 'OTHER' }))).toBe('INVALID_STATE');
  });

  it('cross-company / other passenger / cancelled seat: 404, nothing written', async () => {
    const w = world();
    for (const [user, company, trip] of [['u-pA', 'custA', w.ids.tripB.tt], ['u-pB', 'custB', w.ids.tripA.tt], ['u-pA2', 'custA', w.ids.tripA.tt]] as const) {
      expect(await statusOf(w.svc.confirm(w.ctx(user, company), trip, { clientEventId: randomUUID(), kind: 'PICKUP' }))).toBe(404);
      expect(await statusOf(w.svc.report(w.ctx(user, company), trip, { clientEventId: randomUUID(), category: 'DELAY' }))).toBe(404);
    }
    w.row('transportTripPassenger', w.ids.tripA.seat).status = 'CANCELLED';
    expect(await statusOf(w.svc.confirm(w.ctx('u-pA'), w.ids.tripA.tt, { clientEventId: randomUUID(), kind: 'PICKUP' }))).toBe(404);
    expect(w.store.table('transportTripEvent')).toHaveLength(0);
  });

  it('DTOs: clientEventId must be a UUID; kind / category from the lists; note ≤ 500', async () => {
    const n = async (cls: new () => object, b: unknown) => (await validate(plainToInstance(cls, b))).length;
    expect(await n(MeTripConfirmDto, { clientEventId: randomUUID(), kind: 'PICKUP' })).toBe(0);
    expect(await n(MeTripConfirmDto, { clientEventId: 'x', kind: 'PICKUP' })).toBeGreaterThan(0);
    expect(await n(MeTripConfirmDto, { clientEventId: randomUUID(), kind: 'BOARDED' })).toBeGreaterThan(0);
    expect(await n(MeTripReportDto, { clientEventId: randomUUID(), category: 'SOS' })).toBeGreaterThan(0);
    expect(await n(MeTripReportDto, { clientEventId: randomUUID(), category: 'DELAY', note: 'x'.repeat(501) })).toBeGreaterThan(0);
  });

  it('confirmMismatch: PICKUP contradicts NO_SHOW / CANCELLED; DROP also contradicts a passenger never boarded', () => {
    expect(confirmMismatch('PICKUP', 'PENDING')).toBe(false);
    expect(confirmMismatch('PICKUP', 'BOARDED')).toBe(false);
    expect(confirmMismatch('PICKUP', 'NO_SHOW')).toBe(true);
    expect(confirmMismatch('DROP', 'BOARDED')).toBe(false);
    expect(confirmMismatch('DROP', 'DROPPED')).toBe(false);
    expect(confirmMismatch('DROP', 'PENDING')).toBe(true);
  });
});
