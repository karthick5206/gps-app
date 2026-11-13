/**
 * ETMS E5 part of the tenant-isolation matrix (doc 11 §3.1): every /api/driver/v1 route and the passenger's
 * notification routes × role × ownership. Declared here, consumed by isolation-matrix.ts and isolation-matrix.spec.ts.
 *
 * World (on top of the E3 world): custA's published trip is assigned to custA's driver (login `assignedDriver`),
 * custB's to custB's driver (`foreignDriver`); custA has a second, unassigned driver with a login (`otherDriver`).
 * Each driver and custA's passenger have one in-app notification. Expected policy (D5, 09 §3): a driver sees only the
 * trips assigned to them — another driver of the same company and a driver of another company get 404 — and a menu
 * grant alone is never enough: the Super Admin (who bypasses menus) is 403 NOT_A_DRIVER; dispatchers, admins,
 * providers, passengers and fleet users lack `etms_driver` (403).
 */
import type { IncidentDetail, IncidentListResponse, SosReceipt } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import type { AuthContext } from '../../access/auth-context';
import type { DriverController, MyTransportBookingsController, MyTransportNotificationsController } from '../driver/driver.controller';
import type { DriverSosController, IncidentsController, MySosController } from '../safety/safety.controller';
import type { MySelfServiceController } from '../self-service/self-service.controller';
import type { E3Ids, E3World } from './isolation-matrix-e3';
import type { MatrixRole, RoleTable } from './isolation-matrix';
import type { MemoryStore, Obj } from './memory-store';

export type E5Resource = 'driverSelf' | 'driverTrip' | 'myNotifications' | 'myBookingCancel' | 'sosPassenger' | 'sosDriver' | 'incident' | 'mySelfService' | 'myPlace' | 'mySelfTrip';
export const E5_RESOURCES: readonly E5Resource[] = ['driverSelf', 'driverTrip', 'myNotifications', 'myBookingCancel', 'sosPassenger', 'sosDriver', 'incident', 'mySelfService', 'myPlace', 'mySelfTrip'];

export interface E5Controllers {
  driver: DriverController;
  myNotifications: MyTransportNotificationsController;
  myBookings: MyTransportBookingsController;
  /** WP 5.4: durable SOS (passenger, driver) and the dispatcher SOS lane. */
  mySos: MySosController;
  driverSos: DriverSosController;
  incidents: IncidentsController;
  /** WP 5.3 passenger self-service. */
  mySelf: MySelfServiceController;
}

/** E3 ids + the driver + the WP 5.4 incidents (an OPEN SOS of the company's passenger and one of its driver). */
export type E5Ids = E3Ids & { driver: string; paxIncident: string; driverIncident: string };

export interface E5World {
  e3: E3World;
  party: E5Ids;
  other: E5Ids;
  /** custA's second driver (no trip). */
  otherDriverId: string;
}

/** Drivers' logins (userId) as the matrix callers use them. */
export const DRIVER_USERS: Record<'assignedDriver' | 'otherDriver' | 'foreignDriver', { userId: string; companyId: string }> = {
  assignedDriver: { userId: 'user-driverA', companyId: 'custA' },
  otherDriver: { userId: 'user-otherDriver', companyId: 'custA' },
  foreignDriver: { userId: 'user-driverB', companyId: 'custB' },
};

/** Adds the E5 rows (second custA driver, notifications) to an E3 world. */
export function seedE5(store: MemoryStore, e3: E3World, drivers: { party: string; other: string }, roleId: (companyId: string, name: string) => string): E5World {
  store.insert('user', { id: 'user-otherDriver', companyId: 'custA', name: 'user-otherDriver', email: 'driver.a2@corp.test' });
  store.table('userRole').push({ userId: 'user-otherDriver', roleId: roleId('custA', 'Transport driver') });
  const otherDriverId = store.insert('driver', { companyId: 'custA', branchId: 'brA1', name: 'Second Driver', mobile: null, isActive: true, userId: 'user-otherDriver', licenseExpiry: null, employeeId: null }).id as string;
  for (const [userId, companyId, audience, tripId] of [
    ['user-driverA', 'custA', 'DRIVER', e3.party.trip],
    ['user-otherDriver', 'custA', 'DRIVER', null],
    ['user-driverB', 'custB', 'DRIVER', e3.other.trip],
    ['user-customerPassenger', 'custA', 'PASSENGER', e3.party.trip],
    ['user-passengerB', 'custB', 'PASSENGER', e3.other.trip],
  ] as const) {
    store.insert('transportNotification', { companyId, userId, audience, kind: 'TRIP_CHANGED', tripId, title: 'Trip updated', body: 'One of your trips has changed. Open the app for details.', dedupeKey: `seed:${userId}`, pushQueued: false, readAt: null });
  }
  // WP 5.4: one OPEN SOS of each company's passenger (on its trip) and one of each company's driver.
  const sos = (companyId: string, raiserType: 'PASSENGER' | 'DRIVER', userId: string, tripId: string, profileId: string | null, driverId: string | null) =>
    store.insert('transportIncident', {
      kind: 'SOS', status: 'OPEN', severity: 'CRITICAL', raiserType, raiserUserId: userId, raiserDriverId: driverId, raiserProfileId: profileId, providerCompanyId: companyId, customerCompanyId: companyId, tripId,
      vehicleLabel: null, idempotencyKey: randomUUID(), requestHash: 'seed', raisedAt: new Date(), receivedAt: new Date(), note: null, fixLat: null, fixLng: null, fixAccuracyM: null, fixAt: null,
      repeatCount: 0, lastRepeatAt: null, acknowledgedAt: null, acknowledgedByUserId: null, ackNote: null, resolvedAt: null, resolvedByUserId: null, resolution: null, resolveNote: null, legalHold: false, anonymisedAt: null,
    }).id as string;
  const party = { ...e3.party, driver: drivers.party, paxIncident: sos('custA', 'PASSENGER', 'user-customerPassenger', e3.party.trip, e3.party.passenger, null), driverIncident: sos('custA', 'DRIVER', 'user-driverA', e3.party.trip, null, drivers.party) };
  const other = { ...e3.other, driver: drivers.other, paxIncident: sos('custB', 'PASSENGER', 'user-passengerB', e3.other.trip, e3.other.passenger, null), driverIncident: sos('custB', 'DRIVER', 'user-driverB', e3.other.trip, null, drivers.other) };
  return { e3, party, other, otherDriverId };
}

export function e5Ids(w: E5World, own: 'party' | 'other' | 'none'): E5World['party'] {
  if (own === 'party') return w.party;
  if (own === 'other') return w.other;
  const r = () => randomUUID();
  return { shift: r(), schedule: r(), booking: r(), seatedBooking: r(), trip: r(), plannedTrip: r(), passengerTrip: r(), changeSet: r(), vehicle: r(), passenger: r(), place: r(), driver: r(), paxIncident: r(), driverIncident: r() };
}

// ───────────────────────────── Expected outcomes ─────────────────────────────

const T = (o: Partial<RoleTable>, base: RoleTable): RoleTable => ({ ...base, ...o });

/** No ETMS role but the driver template holds etms_driver; the Super Admin passes the menu check and fails the relationship. */
const NOT_DRIVERS: RoleTable = {
  customerAdmin: 403,
  customerDispatcher: 403,
  customerPassenger: 403,
  providerAdmin: 403,
  providerDispatcher: 403,
  fleetUser: 403,
  etmsOffCompany: 404,
  superAdmin: 403,
  superAdminSwitched: 403,
  assignedDriver: 403,
  otherDriver: 403,
  foreignDriver: 403,
};
/** The caller's own driver data (any linked driver). */
const DRV_SELF: RoleTable = T({ assignedDriver: 200, otherDriver: 200, foreignDriver: 200 }, NOT_DRIVERS);
/** custA's trip: only the driver it is assigned to. */
const DRV_TRIP_A: RoleTable = T({ assignedDriver: 200, otherDriver: 404, foreignDriver: 404 }, NOT_DRIVERS);
/** custB's trip: only custB's driver (its own); custA's drivers 404. */
const DRV_TRIP_B: RoleTable = T({ assignedDriver: 404, otherDriver: 404, foreignDriver: 200 }, NOT_DRIVERS);
/** WP 5.4 dispatcher lane: the templates holding etms_incidents (admin, dispatcher of both companies), the Super Admin. */
const INC_LIST: RoleTable = T({ customerAdmin: 200, customerDispatcher: 200, providerAdmin: 200, providerDispatcher: 200, superAdmin: 200, superAdminSwitched: 200 }, NOT_DRIVERS);
/** custA's incident: custA's incident roles and the Super Admin; prov has no incident grant in its agreement (404). */
const INC_A: RoleTable = T({ customerAdmin: 200, customerDispatcher: 200, providerAdmin: 404, providerDispatcher: 404, superAdmin: 200, superAdminSwitched: 200 }, NOT_DRIVERS);
/** custB's incident: only the platform Super Admin (switched into custA it acts as custA: 404). */
const INC_B: RoleTable = T({ customerAdmin: 404, customerDispatcher: 404, providerAdmin: 404, providerDispatcher: 404, superAdmin: 200, superAdminSwitched: 404 }, NOT_DRIVERS);
/** M1: VeeTrax support is view only — acknowledge / resolve are 403 for the Super Admin (platform or switched). */
const INC_A_ACT: RoleTable = { ...INC_A, superAdmin: 403, superAdminSwitched: 403 };
const INC_B_ACT: RoleTable = { ...INC_B, superAdmin: 403 };
/** The reason VeeTrax support gives for the detail read (X-Access-Reason; others may send one, it is logged). */
const SUPPORT_REASON = 'Ticket 42: customer asked us to check an SOS';
/** The lane lists exactly the incidents of the caller's company (custA: its 2; prov: none; platform: all 4). */
const laneOnlyOwn = (result: unknown, role: MatrixRole, _own: string, _ids: unknown, w: E5World) => {
  const ids = (result as IncidentListResponse).items.map((i) => i.id).sort();
  const a = [w.party.paxIncident, w.party.driverIncident];
  const expected = role === 'superAdmin' ? [...a, w.other.paxIncident, w.other.driverIncident] : role.startsWith('provider') ? [] : a;
  if (JSON.stringify(ids) !== JSON.stringify([...expected].sort())) fail(`${role} lane shows ${JSON.stringify(ids)}`);
  if ((result as IncidentListResponse).openCount !== expected.length) fail(`${role} lane openCount ${(result as IncidentListResponse).openCount}`);
};
/** Passenger notification routes: the passenger itself only (etms_self + own profile). */
const PAX_SELF: RoleTable = T({ customerPassenger: 200 }, NOT_DRIVERS);

export interface E5Entry {
  route: string;
  resource: E5Resource;
  invoke(c: E5Controllers, ctx: AuthContext, ids: E5World['party'], w: E5World): Promise<unknown>;
  prepare?(store: MemoryStore, ids: E5World['party'], w: E5World): void;
  expect: Partial<Record<'party' | 'other' | 'none', RoleTable>>;
  verify?(result: unknown, role: MatrixRole, own: 'party' | 'other' | 'none', ids: E5World['party'], w: E5World): void;
}

const fail = (m: string): never => {
  throw new Error(`isolation matrix (E5): ${m}`);
};
const now = () => new Date().toISOString();
const set = (store: MemoryStore, model: string, id: string, patch: Record<string, unknown>) => Object.assign(store.table(model).find((r) => r.id === id) ?? {}, patch);
/** Both companies' trips startable now (start window) — the cases differ only by the caller. */
const startable = (store: MemoryStore, _ids: unknown, w: E5World) => {
  for (const pt of [w.party.plannedTrip, w.other.plannedTrip]) set(store, 'plannedTrip', pt, { plannedStart: new Date(Date.now() + 10 * 60_000), plannedEnd: new Date(Date.now() + 70 * 60_000) });
};
const openDuties = (store: MemoryStore, _ids: unknown, w: E5World) => {
  for (const [driverId, companyId] of [[w.party.driver, 'custA'], [w.otherDriverId, 'custA'], [w.other.driver, 'custB']]) {
    store.insert('transportDriverDuty', { companyId, driverId, objectId: null, startedAt: new Date(Date.now() - 60_000), endedAt: null, source: 'DRIVER_APP', startClientEventId: randomUUID(), endClientEventId: null });
  }
};

/** Nothing of another company, no contacts, no addresses, no employee codes in a driver answer. */
const PII = ['Secret Lane', '13.061234', '+9198765', '@corp.test', 'Passenger A1', 'Passenger B1', '"employeeCode"', '"mobile"', '"email"'];
const driverClean = (result: unknown, role: MatrixRole, _own: string, _ids: unknown, w: E5World) => {
  const text = JSON.stringify(result);
  for (const leak of PII) if (text.includes(leak)) fail(`${role} driver answer leaks ${leak}`);
  const foreign = role === 'foreignDriver' ? w.party : w.other;
  for (const id of [foreign.trip, foreign.passengerTrip]) if (text.includes(id)) fail(`${role} driver answer shows another company's / driver's trip ${id}`);
  if (role === 'otherDriver' && (text.includes(w.party.trip) || text.includes(w.party.passengerTrip))) fail('otherDriver sees the trip assigned to another driver');
};
const onlyOwnTrips = (result: unknown, role: MatrixRole, own: string, ids: unknown, w: E5World, mustSee = true) => {
  driverClean(result, role, own, ids, w);
  const list = result as { id: string }[];
  const mine = role === 'assignedDriver' ? w.party.trip : role === 'foreignDriver' ? w.other.trip : null;
  if (list.some((t) => t.id !== mine)) fail(`${role} lists a trip not assigned to them`);
  if (mustSee && mine && !list.some((t) => t.id === mine)) fail(`${role} does not see its own trip`);
};
const ownNotifications = (userId: (role: MatrixRole) => string) => (result: unknown, role: MatrixRole) => {
  const list = result as { id: string; tripId: string | null }[];
  if (list.length !== 1) fail(`${role} sees ${list.length} notifications (expected only its own one)`);
  void userId;
};

const ev = (type: string, seq: number, extra: Record<string, unknown> = {}) => ({ clientEventId: randomUUID(), seq, type, occurredAt: now(), ...extra });

/** WP 5.3: switches the company setting selfBooking on for both companies (default off). */
const selfOn = (store: MemoryStore) => {
  for (const c of store.table('company')) if (c.id === 'custA' || c.id === 'custB') c.settings = { ...(c.settings as Obj), etms: { ...((c.settings as { etms?: Obj }).etms ?? {}), selfBooking: true } };
};
/** selfOn + one saved place on each company's passenger (id = that company's E3 place id, so `t.place` targets it). */
const selfOnWithPlaces = (store: MemoryStore, _ids: unknown, w: E5World) => {
  selfOn(store);
  for (const side of [w.party, w.other]) {
    const p = store.table('employeeTransportProfile').find((r) => r.id === side.passenger)!;
    p.preferences = { places: [{ id: side.place, label: `Saved ${side.passenger.slice(0, 4)}`, lat: 13.07, lng: 80.2, createdAt: now() }] };
  }
};
const onlyOwnPlace = (r: unknown, role: MatrixRole, w: E5World) => {
  const list = r as { id: string }[];
  if (list.length !== 1 || list[0].id !== w.party.place) fail(`${role} sees saved places that are not its own: ${JSON.stringify(list)}`);
};

export const E5_MATRIX: E5Entry[] = [
  { route: 'GET driver/v1/me', resource: 'driverSelf', invoke: (c, ctx) => c.driver.me(ctx), expect: { none: DRV_SELF }, verify: driverClean },
  { route: 'GET driver/v1/duty', resource: 'driverSelf', invoke: (c, ctx) => c.driver.duty(ctx), expect: { none: DRV_SELF }, verify: (r, role, o, i, w) => onlyOwnTrips((r as { trips: unknown }).trips, role, o, i, w, false) },
  { route: 'POST driver/v1/duty/start', resource: 'driverSelf', invoke: (c, ctx) => c.driver.startDuty(ctx, { clientEventId: randomUUID(), occurredAt: now() }), expect: { none: DRV_SELF } },
  { route: 'POST driver/v1/duty/end', resource: 'driverSelf', prepare: openDuties, invoke: (c, ctx) => c.driver.endDuty(ctx, { clientEventId: randomUUID(), occurredAt: now() }), expect: { none: DRV_SELF } },
  { route: 'GET driver/v1/trips', resource: 'driverSelf', invoke: (c, ctx) => c.driver.trips(ctx, {}), expect: { none: DRV_SELF }, verify: onlyOwnTrips },
  {
    route: 'GET driver/v1/trips/history',
    resource: 'driverSelf',
    prepare: (s, _i, w) => {
      for (const pt of [w.party.plannedTrip, w.other.plannedTrip]) set(s, 'plannedTrip', pt, { status: 'COMPLETED', plannedStart: new Date(Date.now() - 3 * 3_600_000), plannedEnd: new Date(Date.now() - 2 * 3_600_000) });
    },
    invoke: (c, ctx) => c.driver.history(ctx, {}),
    expect: { none: DRV_SELF },
    verify: onlyOwnTrips,
  },
  {
    route: 'GET driver/v1/trips/:id',
    resource: 'driverTrip',
    invoke: (c, ctx, t) => c.driver.trip(ctx, t.trip),
    expect: { party: DRV_TRIP_A, other: DRV_TRIP_B },
    verify: (r, role, o, i, w) => {
      driverClean(r, role, o, i, w);
      const d = r as { passengers: { displayName: string; contact: unknown }[] };
      if (d.passengers.length !== 1 || d.passengers[0].displayName !== (o === 'other' ? 'Passenger B.' : 'Passenger A.') || d.passengers[0].contact !== null) fail(`${role} manifest is not the minimum projection: ${JSON.stringify(d.passengers)}`);
    },
  },
  {
    route: 'GET driver/v1/trips/:id/motion',
    resource: 'driverTrip',
    invoke: (c, ctx, t) => c.driver.motion(ctx, t.trip),
    expect: { party: DRV_TRIP_A, other: DRV_TRIP_B },
    // No live fix in the matrix world: stale, never invented.
    verify: (r, role) => {
      if (JSON.stringify(r) !== JSON.stringify({ speedKph: null, moving: null, fixAt: null, stale: true })) fail(`${role} motion invents a state: ${JSON.stringify(r)}`);
    },
  },
  { route: 'POST driver/v1/trips/:id/start', resource: 'driverTrip', prepare: startable, invoke: (c, ctx, t) => c.driver.start(ctx, t.trip, { clientEventId: randomUUID(), occurredAt: now() }), expect: { party: DRV_TRIP_A, other: DRV_TRIP_B } },
  {
    route: 'POST driver/v1/trips/:id/events',
    resource: 'driverTrip',
    invoke: (c, ctx, t) => c.driver.events(ctx, t.trip, { events: [ev('ACKNOWLEDGE', 1)] as never }),
    expect: { party: DRV_TRIP_A, other: DRV_TRIP_B },
    verify: (r, role) => {
      const res = (r as { results: { outcome: string }[] }).results;
      if (res[0]?.outcome !== 'ACCEPTED') fail(`${role} acknowledge not accepted: ${JSON.stringify(res)}`);
    },
  },
  { route: 'GET driver/v1/sync', resource: 'driverSelf', invoke: (c, ctx) => c.driver.sync(ctx, {}), expect: { none: DRV_SELF }, verify: (r, role, o, i, w) => onlyOwnTrips((r as { trips: unknown }).trips, role, o, i, w) },
  { route: 'GET driver/v1/notifications', resource: 'driverSelf', invoke: (c, ctx) => c.driver.notificationList(ctx, {}), expect: { none: DRV_SELF }, verify: ownNotifications((r) => r) },
  {
    route: 'POST driver/v1/notifications/read',
    resource: 'driverSelf',
    invoke: (c, ctx) => c.driver.notificationRead(ctx, { all: true }),
    expect: { none: DRV_SELF },
    verify: (r, role) => {
      if ((r as { updated: number }).updated !== 1) fail(`${role} marked ${(r as { updated: number }).updated} notifications read (expected only its own one)`);
    },
  },
  // ── Passenger notification inbox ──
  { route: 'GET me/transport/notifications', resource: 'myNotifications', invoke: (c, ctx) => c.myNotifications.list(ctx, {}), expect: { none: PAX_SELF }, verify: ownNotifications((r) => r) },
  { route: 'POST me/transport/notifications/read', resource: 'myNotifications', invoke: (c, ctx) => c.myNotifications.read(ctx, { all: true }), expect: { none: PAX_SELF } },
  { route: 'GET me/transport/notifications/preferences', resource: 'myNotifications', invoke: (c, ctx) => c.myNotifications.preferences(ctx), expect: { none: PAX_SELF } },
  {
    route: 'POST me/transport/bookings/:id/cancel',
    resource: 'myBookingCancel',
    invoke: (c, ctx, t) => c.myBookings.cancel(ctx, t.seatedBooking, { reason: 'On leave' }),
    // Only the passenger, only their own booking (custB's booking: 404 for custA's passenger).
    expect: { party: PAX_SELF, other: T({ customerPassenger: 404 }, PAX_SELF) },
    verify: (r, role) => {
      const b = r as { status: string; tripId: string | null };
      if (b.status !== 'CANCELLED' || b.tripId !== null) fail(`${role} cancel did not free the seat: ${JSON.stringify(b)}`);
    },
  },
  { route: 'PUT me/transport/notifications/preferences', resource: 'myNotifications', invoke: (c, ctx) => c.myNotifications.setPreferences(ctx, { push: false, kinds: {} }), expect: { none: PAX_SELF } },
  // ── WP 5.4: durable SOS (raise: own identity only; receipt: own incident only) ──
  {
    route: 'POST me/transport/sos',
    resource: 'sosPassenger',
    invoke: (c, ctx) => c.mySos.raise(ctx, { note: 'help', fix: { lat: 13.05, lng: 80.25, at: now() } }, randomUUID()),
    expect: { none: PAX_SELF },
    // The passenger already has an OPEN SOS in the world: the press merges into it (never a second incident, never 429).
    verify: (r, role, _o, _i, w) => {
      const rc = r as SosReceipt;
      if (rc.status !== 'RECEIVED_BY_SERVER' || rc.incidentId !== w.party.paxIncident || !rc.merged) fail(`${role} SOS receipt: ${JSON.stringify(rc)}`);
    },
  },
  {
    route: 'GET me/transport/sos/:id',
    resource: 'sosPassenger',
    invoke: (c, ctx, t) => c.mySos.receipt(ctx, t.paxIncident),
    expect: { party: PAX_SELF, other: T({ customerPassenger: 404 }, PAX_SELF) },
  },
  {
    route: 'POST driver/v1/sos',
    resource: 'sosDriver',
    invoke: (c, ctx) => c.driverSos.raise(ctx, {}, randomUUID()),
    expect: { none: DRV_SELF },
    verify: (r, role, _o, _i, w) => {
      const rc = r as SosReceipt;
      // assignedDriver / foreignDriver already have an OPEN SOS (merge); otherDriver raises a new one with no trip.
      const expected = role === 'assignedDriver' ? w.party.driverIncident : role === 'foreignDriver' ? w.other.driverIncident : null;
      if (rc.status !== 'RECEIVED_BY_SERVER' || (expected && rc.incidentId !== expected) || (!expected && rc.merged)) fail(`${role} driver SOS receipt: ${JSON.stringify(rc)}`);
    },
  },
  {
    route: 'GET driver/v1/sos/:id',
    resource: 'sosDriver',
    invoke: (c, ctx, t) => c.driverSos.receipt(ctx, t.driverIncident),
    expect: { party: DRV_TRIP_A, other: DRV_TRIP_B },
  },
  // ── WP 5.4: dispatcher SOS lane (etms_incidents; the raiser's company, Super Admin; agreement grants only) ──
  { route: 'GET transport/incidents', resource: 'incident', invoke: (c, ctx) => c.incidents.list(ctx, { open: '1' }), expect: { none: INC_LIST }, verify: laneOnlyOwn },
  { route: 'GET transport/incidents/:id', resource: 'incident', invoke: (c, ctx, t) => c.incidents.detail(ctx, t.paxIncident, SUPPORT_REASON), expect: { party: INC_A, other: INC_B } },
  {
    route: 'POST transport/incidents/:id/ack',
    resource: 'incident',
    invoke: (c, ctx, t) => c.incidents.ack(ctx, t.paxIncident, { note: 'Called the passenger' }),
    expect: { party: INC_A_ACT, other: INC_B_ACT },
    verify: (r, role) => {
      if ((r as IncidentDetail).status !== 'ACKNOWLEDGED') fail(`${role} ack did not acknowledge`);
    },
  },
  {
    route: 'POST transport/incidents/:id/resolve',
    resource: 'incident',
    invoke: (c, ctx, t) => c.incidents.resolve(ctx, t.paxIncident, { resolution: 'FALSE_ALARM', note: 'Pressed by mistake' }),
    expect: { party: INC_A_ACT, other: INC_B_ACT },
    verify: (r, role) => {
      if ((r as IncidentDetail).status !== 'RESOLVED') fail(`${role} resolve did not resolve`);
    },
  },
  // ── WP 5.3 passenger self-service (company setting selfBooking switched on for both companies in `selfOn`; the OFF
  //    default is covered by self-service.spec.ts and etms-self-service.db-test.ts) ──
  {
    route: 'GET me/transport/policy',
    resource: 'mySelfService',
    prepare: selfOn,
    invoke: (c, ctx) => c.mySelf.policy(ctx),
    expect: { none: PAX_SELF },
    verify: (r, role, _o, _i, w) => {
      const p = r as { selfBooking: boolean; shifts: { id: string }[]; stops: { id: string }[] };
      if (!p.selfBooking || p.shifts.some((s) => s.id === w.other.shift) || !p.shifts.some((s) => s.id === w.party.shift)) fail(`${role} policy shows the wrong shifts: ${JSON.stringify(p)}`);
      if (p.stops.some((s) => s.id === w.other.place || s.id === 'siteB1')) fail(`${role} policy shows another company's place`);
    },
  },
  {
    route: 'POST me/transport/bookings',
    resource: 'mySelfService',
    prepare: selfOn,
    invoke: (c, ctx, _t, w) => c.mySelf.book(ctx, { serviceDate: w.e3.later, direction: 'IN', shiftId: w.party.shift, place: { kind: 'HOME' } } as never, randomUUID()),
    expect: { none: PAX_SELF },
    verify: (r, role) => {
      // D-A5: approval is on by default, so a self-booking waits as REQUESTED.
      if ((r as { status: string }).status !== 'REQUESTED') fail(`${role} self-booking not created: ${JSON.stringify(r)}`);
    },
  },
  {
    route: 'GET me/transport/schedule',
    resource: 'mySelfService',
    prepare: selfOn,
    invoke: (c, ctx) => c.mySelf.commute(ctx),
    expect: { none: PAX_SELF },
    verify: (r, role, _o, _i, w) => {
      const text = JSON.stringify(r);
      for (const id of [w.other.schedule, w.other.booking, w.other.seatedBooking]) if (text.includes(id)) fail(`${role} commute shows another company's row ${id}`);
      if (!text.includes(w.party.schedule)) fail(`${role} commute misses its own schedule`);
    },
  },
  { route: 'GET me/transport/places', resource: 'mySelfService', prepare: selfOnWithPlaces, invoke: (c, ctx) => c.mySelf.places(ctx), expect: { none: PAX_SELF }, verify: (r, role, _o, _i, w) => onlyOwnPlace(r, role, w) },
  { route: 'POST me/transport/places', resource: 'mySelfService', prepare: selfOn, invoke: (c, ctx) => c.mySelf.addPlace(ctx, { label: 'Gym', lat: 13.07, lng: 80.2 }), expect: { none: PAX_SELF } },
  {
    route: 'PATCH me/transport/places/:id',
    resource: 'myPlace',
    prepare: selfOnWithPlaces,
    invoke: (c, ctx, t) => c.mySelf.updatePlace(ctx, t.place, { label: 'Renamed' }),
    // Saved places live on the passenger's own profile: custB's place is 404 for custA's passenger.
    expect: { party: PAX_SELF, other: T({ customerPassenger: 404 }, PAX_SELF) },
  },
  { route: 'DELETE me/transport/places/:id', resource: 'myPlace', prepare: selfOnWithPlaces, invoke: (c, ctx, t) => c.mySelf.deletePlace(ctx, t.place), expect: { party: PAX_SELF, other: T({ customerPassenger: 404 }, PAX_SELF) } },
  {
    route: 'POST me/transport/trips/:id/confirm',
    resource: 'mySelfTrip',
    prepare: (s, i, w) => (selfOn(s), startable(s, i, w)),
    invoke: (c, ctx, t) => c.mySelf.confirm(ctx, t.trip, { clientEventId: randomUUID(), kind: 'PICKUP' }),
    expect: { party: PAX_SELF, other: T({ customerPassenger: 404 }, PAX_SELF) },
    verify: (r, role) => {
      const x = r as { outcome: string; myStatus: string };
      if (x.outcome !== 'ACCEPTED' || x.myStatus !== 'PENDING') fail(`${role} confirm changed or lost the seat: ${JSON.stringify(x)}`);
    },
  },
  {
    route: 'POST me/transport/trips/:id/reports',
    resource: 'mySelfTrip',
    prepare: (s, i, w) => (selfOn(s), startable(s, i, w)),
    invoke: (c, ctx, t) => c.mySelf.report(ctx, t.trip, { clientEventId: randomUUID(), category: 'DELAY', note: 'Late' }),
    expect: { party: PAX_SELF, other: T({ customerPassenger: 404 }, PAX_SELF) },
  },
];

/** Roles E5 adds to the matrix: on every older route they hold only etms_driver, so the menu guard answers 403. */
export const DRIVER_MATRIX_ROLES = ['assignedDriver', 'otherDriver', 'foreignDriver'] as const;
