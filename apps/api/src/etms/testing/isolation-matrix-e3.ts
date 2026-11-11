/**
 * ETMS E3 part of the tenant-isolation matrix (doc 11 §3.1): every E3 route × role × ownership, plus the world the
 * cases run in. Declared here, consumed by isolation-matrix.ts (ISOLATION_MATRIX) and isolation-matrix.spec.ts.
 *
 * World (on top of the E2 world): custA (the caller's customer company) and custB (nobody's partner) each have a shift,
 * a schedule of their passenger, an open booking (PENDING_ASSIGNMENT, OUT, tomorrow), a seated booking (ASSIGNED, IN,
 * tomorrow) on a published ETMS trip of their vehicle, a schedule exception and a DRAFT change set. custA's passenger is
 * the login of `customerPassenger`, so /api/me/transport sees custA's trip as its own. The prov ↔ custA agreement grants
 * VIEW_BOOKINGS (read-only bookings for the provider) but not MANAGE_DISPATCH / MANAGE_SCHEDULES, so the provider sees
 * none of custA's shifts, schedules or trips (R1: corporate-managed only).
 */
import { randomUUID } from 'crypto';
import type { AuthContext } from '../../access/auth-context';
import type { MemoryStore, Obj } from './memory-store';
import type { BookingsController, DispatchController, MyTransportTripsController, SchedulesController, ShiftsController, TransportTripsController } from '../dispatch/e3.controllers';
import type { MatrixRole, RoleTable } from './isolation-matrix';

export type E3Resource = 'shift' | 'schedule' | 'booking' | 'trip' | 'changeSet' | 'myTrip' | 'myBooking';
export const E3_RESOURCES: readonly E3Resource[] = ['shift', 'schedule', 'booking', 'trip', 'changeSet', 'myTrip', 'myBooking'];

export interface E3Controllers {
  shifts: ShiftsController;
  schedules: SchedulesController;
  bookings: BookingsController;
  dispatch: DispatchController;
  trips: TransportTripsController;
  meTrips: MyTransportTripsController;
}

export interface E3Ids {
  shift: string;
  schedule: string;
  booking: string;
  seatedBooking: string;
  trip: string;
  plannedTrip: string;
  passengerTrip: string;
  changeSet: string;
  vehicle: string;
  passenger: string;
}

export interface E3World {
  party: E3Ids;
  other: E3Ids;
  /** Service dates (company zone Asia/Kolkata). */
  tomorrow: string;
  later: string;
}

const H = 3_600_000;
const dayKey = (ms: number) => new Date(ms + 5.5 * H).toISOString().slice(0, 10);

function seedCompany(store: MemoryStore, companyId: string, site: string, passenger: string, vehicle: string, driver: string, tomorrow: string, later: string): E3Ids {
  store.insert('employeeTransportConsent', { companyId, profileId: passenger, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: true, channel: 'ADMIN_ON_BEHALF', occurredAt: new Date(Date.now() - H) });
  store.insert('transportVehicleProfile', { objectId: vehicle, companyId, seats: 4, wheelchairSpaces: 0 });
  const poi = store.table('poi').find((p) => p.id === site)!;
  const shift = store.insert('transportShift', { companyId, sitePoiId: site, name: `Day ${companyId}`, startMin: 540, endMin: 1080, overnight: false, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' });
  const schedule = store.insert('transportSchedule', { companyId, profileId: passenger, shiftId: shift.id, direction: 'IN', days: [1, 2, 3, 4, 5], pickupMode: 'HOME', validFrom: new Date(`${tomorrow}T00:00:00Z`) });
  store.insert('transportScheduleException', { companyId, scheduleId: schedule.id, date: new Date(`${later}T00:00:00Z`), kind: 'SKIP' });
  const base = Date.parse(`${tomorrow}T03:30:00Z`); // 09:00 IST
  const booking = (direction: 'IN' | 'OUT', status: string, start: number) =>
    store.insert('transportBooking', {
      customerCompanyId: companyId,
      providerCompanyId: status === 'ASSIGNED' ? companyId : null,
      profileId: passenger,
      shiftId: shift.id,
      source: 'ADHOC',
      serviceDate: new Date(`${tomorrow}T00:00:00Z`),
      direction,
      timeZone: 'Asia/Kolkata',
      pickupLat: 13.06,
      pickupLng: 80.24,
      dropLat: poi.lat,
      dropLng: poi.lng,
      windowStart: new Date(start),
      windowEnd: new Date(start + 1.5 * H),
      status,
      cutoffAt: new Date(start - H),
    });
  const open = booking('OUT', 'PENDING_ASSIGNMENT', base + 9 * H);
  const seated = booking('IN', 'ASSIGNED', base - 1.5 * H);
  const pt = store.insert('plannedTrip', { companyId, branchId: null, routeId: null, origin: 'ETMS', objectId: vehicle, driverId: driver, routeName: `Login ${companyId}`, corridorM: 200, plannedStart: new Date(base - H), plannedEnd: new Date(base), status: 'SCHEDULED' });
  const s0 = store.insert('plannedTripStop', { tripId: pt.id, seq: 0, name: 'Home', lat: 13.06, lng: 80.24, radiusM: 100, plannedArrival: new Date(base - H), plannedDeparture: new Date(base - H) });
  const s1 = store.insert('plannedTripStop', { tripId: pt.id, seq: 1, name: 'Office', lat: poi.lat, lng: poi.lng, radiusM: 100, plannedArrival: new Date(base), plannedDeparture: new Date(base) });
  const trip = store.insert('transportTrip', { plannedTripId: pt.id, providerCompanyId: companyId, customerCompanyId: companyId, serviceDate: new Date(`${tomorrow}T00:00:00Z`), direction: 'IN', shiftId: shift.id, sitePoiId: site, seatCapacity: 4, occupiedSeats: 1, publishedAt: new Date() });
  const pax = store.insert('transportTripPassenger', { tripId: trip.id, bookingId: seated.id, customerCompanyId: companyId, providerCompanyId: companyId, pickupStopId: s0.id, dropStopId: s1.id, pickupSeq: 0, dropSeq: 1, seats: 1 });
  const laterStart = Date.parse(`${later}T03:30:00Z`);
  const draft = store.insert('transportChangeSet', {
    companyId,
    status: 'DRAFT',
    serviceDate: new Date(`${later}T00:00:00Z`),
    direction: 'IN',
    draft: {
      serviceDate: later,
      direction: 'IN',
      expectedVersions: {},
      changes: [{ op: 'CREATE_TRIP', tempId: 'trip', objectId: vehicle, plannedStart: new Date(laterStart - H).toISOString(), stops: stopList(laterStart, poi) }],
    },
  });
  return { shift: shift.id as string, schedule: schedule.id as string, booking: open.id as string, seatedBooking: seated.id as string, trip: trip.id as string, plannedTrip: pt.id as string, passengerTrip: pax.id as string, changeSet: draft.id as string, vehicle, passenger };
}

function stopList(arrive: number, site: Obj) {
  return [
    { seq: 0, point: { lat: 13.06, lng: 80.24, label: 'Home' }, plannedArrival: new Date(arrive - H).toISOString() },
    { seq: 1, point: { lat: site.lat as number, lng: site.lng as number, label: 'Office' }, plannedArrival: new Date(arrive).toISOString() },
  ];
}

/** Adds the E3 rows to an E2 world (see the file comment). */
export function seedE3(store: MemoryStore, e2: { party: { passenger: string; vehicle: string; driver: string }; other: { passenger: string; vehicle: string; driver: string } }): E3World {
  const tomorrow = dayKey(Date.now() + 24 * H);
  const later = dayKey(Date.now() + 3 * 24 * H);
  return {
    party: seedCompany(store, 'custA', 'siteA1', e2.party.passenger, e2.party.vehicle, e2.party.driver, tomorrow, later),
    other: seedCompany(store, 'custB', 'siteB1', e2.other.passenger, e2.other.vehicle, e2.other.driver, tomorrow, later),
    tomorrow,
    later,
  };
}

/** Pick the E3 ids for an ownership ('none' = random ids). */
export function e3Ids(w: E3World, own: 'party' | 'other' | 'none'): E3Ids {
  if (own === 'party') return w.party;
  if (own === 'other') return w.other;
  const r = () => randomUUID();
  return { shift: r(), schedule: r(), booking: r(), seatedBooking: r(), trip: r(), plannedTrip: r(), passengerTrip: r(), changeSet: r(), vehicle: r(), passenger: r() };
}

// ───────────────────────────── Expected outcomes ─────────────────────────────

const T = (o: Partial<RoleTable>, base: RoleTable): RoleTable => ({ ...base, ...o });

/** Lists in the caller's own company (empty for companies without rows): any role holding the menu. */
const LIST: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
/** A custA row, customer-owned (shift / schedule / trip): custA roles; providers and the platform context 404. */
const OWN_ROW: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
/** A custB row: nobody but the menu-less roles' guard answers differently. */
const OTHER_ROW: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 404 };
/**
 * Bookings: VIEW_BOOKINGS lets a provider read the rows it operates (providerCompanyId = provider, transport-scope).
 * In R1 every booking is corporate-managed (provider = customer), so the prov ↔ custA agreement shows the provider
 * none of custA's bookings: 404 like any other tenant's row (E1b changes this with provider-managed bookings).
 */
const BOOKING_READ: RoleTable = OWN_ROW;
const BOOKING_WRITE: RoleTable = OWN_ROW;
/** Create referencing custA's passenger / vehicle / booking: only custA roles; elsewhere the reference is a 404. */
const CREATE_FOR_A: RoleTable = OWN_ROW;
/** /api/me/transport: only the passenger itself (etms_self + own profile); NOT_A_PASSENGER 403 for the others. */
const SELF: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 200, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 };
/** Another company's trip / booking through /api/me: the passenger gets 404, everyone else is no passenger (403). */
const SELF_OTHER: RoleTable = T({ customerPassenger: 404 }, SELF);

export interface E3Entry {
  route: string;
  resource: E3Resource;
  invoke(c: E3Controllers, ctx: AuthContext, ids: E3Ids, w: E3World): Promise<unknown>;
  /** Bring the target into the state the command needs before it runs (e.g. a started trip). */
  prepare?(store: MemoryStore, ids: E3Ids, w: E3World): void;
  expect: Partial<Record<'party' | 'other' | 'none', RoleTable>>;
  verify?(result: unknown, role: MatrixRole, own: 'party' | 'other' | 'none', ids: E3Ids, w: E3World): void;
}

const key = () => `matrix-${randomUUID()}`;
const set = (store: MemoryStore, model: string, id: string, patch: Obj) => Object.assign(store.table(model).find((r) => r.id === id) ?? {}, patch);
const started = (store: MemoryStore, ids: E3Ids) => set(store, 'plannedTrip', ids.plannedTrip, { status: 'IN_PROGRESS', actualStart: new Date() });
const fail = (m: string): never => {
  throw new Error(`isolation matrix (E3): ${m}`);
};

/** Lists must never contain the other company's rows. */
const noOther = (field: 'id') => (result: unknown, role: MatrixRole, _own: string, _ids: E3Ids, w: E3World) => {
  const items = Array.isArray(result) ? result : ((result as { items?: { [k: string]: unknown }[] }).items ?? []);
  const otherIds = new Set(Object.values(w.other));
  if (items.some((i: Record<string, unknown>) => otherIds.has(i[field] as string))) fail(`${role} list shows another company's row`);
};

export const E3_MATRIX: E3Entry[] = [
  // ── Shifts ──
  { route: 'GET transport/shifts', resource: 'shift', invoke: (c, ctx) => c.shifts.list(ctx, {}), expect: { none: LIST }, verify: noOther('id') },
  { route: 'POST transport/shifts', resource: 'shift', invoke: (c, ctx) => c.shifts.create(ctx, { name: `Night ${randomUUID().slice(0, 6)}`, startMin: 1320, endMin: 360, days: [1, 2, 3] }), expect: { none: LIST } },
  { route: 'PATCH transport/shifts/:id', resource: 'shift', invoke: (c, ctx, t) => c.shifts.update(ctx, t.shift, { name: 'Renamed shift' }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'DELETE transport/shifts/:id', resource: 'shift', invoke: (c, ctx, t) => c.shifts.archive(ctx, t.shift), expect: { party: OWN_ROW, other: OTHER_ROW } },
  // ── Schedules ──
  { route: 'GET transport/schedules', resource: 'schedule', invoke: (c, ctx) => c.schedules.list(ctx, {}), expect: { none: LIST }, verify: noOther('id') },
  { route: 'GET transport/schedules/preview', resource: 'schedule', invoke: (c, ctx) => c.schedules.preview(ctx, {}), expect: { none: LIST } },
  {
    route: 'POST transport/schedules',
    resource: 'schedule',
    invoke: (c, ctx, _t, w) => c.schedules.create(ctx, { profileIds: [w.party.passenger], shiftId: w.party.shift, directions: ['OUT'], pickupMode: 'HOME', validFrom: w.tomorrow }),
    expect: { none: CREATE_FOR_A },
  },
  { route: 'PATCH transport/schedules/:id', resource: 'schedule', invoke: (c, ctx, t) => c.schedules.update(ctx, t.schedule, { expectedVersion: 1, days: [1, 2] }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'DELETE transport/schedules/:id', resource: 'schedule', invoke: (c, ctx, t) => c.schedules.archive(ctx, t.schedule), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'GET transport/schedules/:id/exceptions', resource: 'schedule', invoke: (c, ctx, t) => c.schedules.exceptions(ctx, t.schedule), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'POST transport/schedules/:id/exceptions', resource: 'schedule', invoke: (c, ctx, t, w) => c.schedules.addException(ctx, t.schedule, { date: w.tomorrow, kind: 'SKIP', reason: 'Leave' }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'DELETE transport/schedules/:id/exceptions/:date', resource: 'schedule', invoke: (c, ctx, t, w) => c.schedules.deleteException(ctx, t.schedule, w.later), expect: { party: OWN_ROW, other: OTHER_ROW } },
  // ── Bookings ──
  { route: 'GET transport/bookings', resource: 'booking', invoke: (c, ctx) => c.bookings.list(ctx, {}), expect: { none: LIST }, verify: noOther('id') },
  { route: 'GET transport/bookings/:id', resource: 'booking', invoke: (c, ctx, t) => c.bookings.get(ctx, t.booking), expect: { party: BOOKING_READ, other: OTHER_ROW } },
  { route: 'GET transport/bookings/:id/events', resource: 'booking', invoke: (c, ctx, t) => c.bookings.events(ctx, t.booking), expect: { party: BOOKING_READ, other: OTHER_ROW } },
  {
    route: 'POST transport/bookings',
    resource: 'booking',
    invoke: (c, ctx, _t, w) => {
      const start = Date.parse(`${w.later}T02:00:00Z`);
      return c.bookings.create(ctx, { passengerId: w.party.passenger, serviceDate: w.later, direction: 'IN', windowStart: new Date(start).toISOString(), windowEnd: new Date(start + H).toISOString(), pickup: { lat: 13.07, lng: 80.25 }, drop: { lat: 13.05, lng: 80.25 } }, key());
    },
    expect: { none: CREATE_FOR_A },
  },
  { route: 'PATCH transport/bookings/:id', resource: 'booking', invoke: (c, ctx, t) => c.bookings.update(ctx, t.booking, { expectedVersion: 1, passengerCount: 2 }), expect: { party: BOOKING_WRITE, other: OTHER_ROW } },
  { route: 'POST transport/bookings/:id/approve', resource: 'booking', prepare: (s, t) => set(s, 'transportBooking', t.booking, { status: 'REQUESTED' }), invoke: (c, ctx, t) => c.bookings.approve(ctx, t.booking, {}), expect: { party: BOOKING_WRITE, other: OTHER_ROW } },
  { route: 'POST transport/bookings/:id/reject', resource: 'booking', invoke: (c, ctx, t) => c.bookings.reject(ctx, t.booking, { reason: 'Not eligible' }), expect: { party: BOOKING_WRITE, other: OTHER_ROW } },
  { route: 'POST transport/bookings/:id/cancel', resource: 'booking', invoke: (c, ctx, t) => c.bookings.cancel(ctx, t.booking, { reason: 'On leave' }), expect: { party: BOOKING_WRITE, other: OTHER_ROW } },
  {
    route: 'POST transport/bookings/bulk-approve',
    resource: 'booking',
    prepare: (s, _t, w) => set(s, 'transportBooking', w.party.booking, { status: 'REQUESTED' }),
    invoke: (c, ctx, _t, w) => c.bookings.bulkApprove(ctx, { ids: [w.party.booking, w.other.booking] }),
    // Per-id outcome: the route answers 200 to every role holding etms_bookings:edit; only custA's own roles approve.
    expect: { none: T({ providerAdmin: 200, providerDispatcher: 200, superAdmin: 200 }, OWN_ROW) },
    verify: (result, role, _own, _ids, w) => {
      const r = result as { approved: string[]; skipped: { id: string; code: string }[] };
      const own = role === 'customerAdmin' || role === 'customerDispatcher' || role === 'superAdminSwitched';
      if (r.approved.includes(w.other.booking)) fail(`${role} approved another company's booking`);
      if (own !== r.approved.includes(w.party.booking)) fail(`${role} approve of the party booking: approved ${r.approved.join(",")}, skipped ${JSON.stringify(r.skipped)}`);
    },
  },
  // ── Dispatch ──
  { route: 'GET transport/dispatch/board', resource: 'trip', invoke: (c, ctx, _t, w) => c.dispatch.board(ctx, { serviceDate: w.tomorrow }), expect: { none: LIST }, verify: (r, role, _o, _i, w) => noOther('id')((r as { trips: unknown[] }).trips, role, '', _i, w) },
  { route: 'POST transport/dispatch/candidates', resource: 'trip', invoke: (c, ctx, _t, w) => c.dispatch.candidates(ctx, { bookingIds: [w.party.booking] }), expect: { none: CREATE_FOR_A } },
  { route: 'GET transport/dispatch/change-sets', resource: 'changeSet', invoke: (c, ctx) => c.dispatch.changeSets(ctx, {}), expect: { none: LIST }, verify: noOther('id') },
  {
    route: 'POST transport/dispatch/change-sets',
    resource: 'changeSet',
    invoke: (c, ctx, _t, w) => {
      const at = Date.parse(`${w.later}T12:00:00Z`);
      return c.dispatch.submit(
        ctx,
        { serviceDate: w.later, direction: 'OUT', changes: [{ op: 'CREATE_TRIP', tempId: 'x', objectId: w.party.vehicle, plannedStart: new Date(at).toISOString(), stops: [{ seq: 0, point: { lat: 13.05, lng: 80.25 }, plannedArrival: new Date(at).toISOString() }, { seq: 1, point: { lat: 13.06, lng: 80.24 }, plannedArrival: new Date(at + H).toISOString() }] }] },
        key(),
      );
    },
    expect: { none: CREATE_FOR_A },
  },
  { route: 'POST transport/dispatch/change-sets/:id/publish', resource: 'changeSet', invoke: (c, ctx, t) => c.dispatch.publish(ctx, t.changeSet, key()), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'DELETE transport/dispatch/change-sets/:id', resource: 'changeSet', invoke: (c, ctx, t) => c.dispatch.discard(ctx, t.changeSet), expect: { party: OWN_ROW, other: OTHER_ROW } },
  // ── Trips ──
  { route: 'GET transport/trips', resource: 'trip', invoke: (c, ctx) => c.trips.list(ctx, {}), expect: { none: LIST }, verify: noOther('id') },
  { route: 'GET transport/trips/:id', resource: 'trip', invoke: (c, ctx, t) => c.trips.get(ctx, t.trip), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'POST transport/trips/:id/start', resource: 'trip', invoke: (c, ctx, t) => c.trips.start(ctx, t.trip, {}), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'POST transport/trips/:id/arrive', resource: 'trip', prepare: started, invoke: (c, ctx, t) => c.trips.arrive(ctx, t.trip, { stopSeq: 0 }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'POST transport/trips/:id/complete', resource: 'trip', prepare: started, invoke: (c, ctx, t) => c.trips.complete(ctx, t.trip, {}), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'POST transport/trips/:id/cancel', resource: 'trip', invoke: (c, ctx, t) => c.trips.cancel(ctx, t.trip, { reason: 'Vehicle broke down' }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  { route: 'POST transport/trips/:id/acknowledge', resource: 'trip', invoke: (c, ctx, t) => c.trips.acknowledge(ctx, t.trip, {}), expect: { party: OWN_ROW, other: OTHER_ROW } },
  {
    route: 'POST transport/trips/:id/passengers/:passengerTripId/outcome',
    resource: 'trip',
    prepare: started,
    invoke: (c, ctx, t) => c.trips.outcome(ctx, t.trip, t.passengerTrip, { outcome: 'BOARDED' }),
    expect: { party: OWN_ROW, other: OTHER_ROW },
    verify: (r, role) => {
      const p = (r as { passengers: { status: string; outcomeSource: string | null }[] }).passengers[0];
      if (p.status !== 'BOARDED' || p.outcomeSource !== 'WEB') fail(`${role} outcome not recorded as BOARDED / WEB`);
    },
  },
  { route: 'POST transport/trips/:id/repeat', resource: 'trip', invoke: (c, ctx, t, w) => c.trips.repeat(ctx, t.trip, { toDate: w.later }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  // ── Passenger self view ──
  {
    route: 'GET me/transport/trips',
    resource: 'myTrip',
    invoke: (c, ctx) => c.meTrips.trips(ctx, {}),
    expect: { none: SELF },
    verify: (r, role, _o, _i, w) => {
      const ids = (r as { id: string }[]).map((x) => x.id);
      if (ids.includes(w.other.trip)) fail(`${role} sees another passenger's trip`);
      if (!ids.includes(w.party.trip)) fail(`${role} does not see its own trip`);
    },
  },
  { route: 'GET me/transport/trips/:id', resource: 'myTrip', invoke: (c, ctx, t) => c.meTrips.trip(ctx, t.trip), expect: { party: SELF, other: SELF_OTHER } },
  {
    route: 'GET me/transport/trips/:id/vehicle',
    resource: 'myTrip',
    invoke: (c, ctx, t) => c.meTrips.vehicle(ctx, t.trip),
    expect: { party: SELF, other: SELF_OTHER },
    // The seeded trip starts tomorrow: outside the window the position is never served.
    verify: (r, role) => {
      if ((r as { visible: boolean }).visible) fail(`${role} sees the vehicle outside the trip window`);
    },
  },
  { route: 'GET me/transport/bookings', resource: 'myBooking', invoke: (c, ctx) => c.meTrips.bookings(ctx, {}), expect: { none: SELF }, verify: noOther('id') },
  { route: 'GET me/transport/bookings/:id', resource: 'myBooking', invoke: (c, ctx, t) => c.meTrips.booking(ctx, t.seatedBooking), expect: { party: SELF, other: SELF_OTHER } },
];
