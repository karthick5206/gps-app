/**
 * ETMS pooling part of the tenant-isolation matrix (doc 20 §6 "all new routes into the isolation matrix"; doc 11 §3.1):
 * every pooling route × role × ownership. E3-world entries (bookings, vehicles: custA party / custB other) and one
 * E5-world entry (the driver's route acknowledgement on the assigned trip). Consumed by isolation-matrix.ts.
 *
 * Policy: bookings / vehicles of another company are 404 (never a hint), the menu decides 403 (etms_dispatch for hold,
 * live decide and the log; etms_bookings for the desk policy read; etms_settings + whole-company scope for the policy,
 * pooling settings and driver policy; objects for vehicle availability; etms_self for the passenger's policy read;
 * etms_driver for the route acknowledgement).
 */
import { randomUUID } from 'crypto';
import type { E3Entry } from './isolation-matrix-e3';
import type { E5Entry } from './isolation-matrix-e5';
import type { RoleTable } from './isolation-matrix';

const T = (o: Partial<RoleTable>, base: RoleTable): RoleTable => ({ ...base, ...o });
/** The company's own list / read (any role holding the menu; providers see their own company's, empty). */
const LIST: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
/** A custA booking: custA roles; providers and the platform context 404. */
const OWN_ROW: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
/** A custB booking: 404 for everyone holding the menu. */
const OTHER_ROW: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 404 };
/** Company-wide settings (etms_settings:edit, whole-company scope). */
const ADMINS_ONLY: RoleTable = { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
/** Vehicle rows: fleet grants (objects), own company, branch-scoped; never a provider (as the vehicle seat profile). */
const F_READ: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 200, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
const F_READ_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 404, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 404 };
const F_WRITE: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 200, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
const F_WRITE_OTHER: RoleTable = { ...F_WRITE, fleetUser: 404, superAdminSwitched: 404 };
/** The passenger's own self-service read (etms_self). */
const SELF: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 200, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 };
/** Driver commands (etms_driver): the assigned driver's own trip only. */
const NOT_DRIVERS: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403, assignedDriver: 403, otherDriver: 403, foreignDriver: 403 };
const DRV_TRIP_A: RoleTable = T({ assignedDriver: 200, otherDriver: 404, foreignDriver: 404 }, NOT_DRIVERS);
const DRV_TRIP_B: RoleTable = T({ assignedDriver: 404, otherDriver: 404, foreignDriver: 200 }, NOT_DRIVERS);

const fail = (m: string): never => {
  throw new Error(`isolation matrix (pooling): ${m}`);
};

const POLICY = { text: 'Shared rides may carry other passengers within the limits below.', limits: { SHARED: { maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: null }, FLEXIBLE: { maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: null } } };

/** custA has live dispatch switched on (the matrix judges isolation, not the switch). */
const liveOn = (store: { table(m: string): Record<string, unknown>[] }) => {
  for (const c of store.table('company')) if (c.id === 'custA' || c.id === 'custB') c.settings = { ...((c.settings as object) ?? {}), etmsPooling: { liveDispatch: true } };
};

export const POOLING_E3_MATRIX: E3Entry[] = [
  { route: 'PATCH transport/bookings/:id/hold', resource: 'booking', invoke: (c, ctx, t) => c.pooling.hold(ctx, t.booking, { hold: true, reason: 'isolation matrix hold', expectedVersion: 1 }), expect: { party: OWN_ROW, other: OTHER_ROW } },
  {
    route: 'GET transport/sharing-policy',
    resource: 'booking',
    invoke: (c, ctx) => c.pooling.policy(ctx),
    expect: { none: LIST },
    verify: (r, role) => {
      if (typeof (r as { version?: unknown }).version !== 'number') fail(`${role} policy: unexpected shape`);
    },
  },
  { route: 'PUT transport/sharing-policy', resource: 'booking', invoke: (c, ctx) => c.pooling.updatePolicy(ctx, POLICY as never), expect: { none: ADMINS_ONLY } },
  { route: 'GET transport/pooling/settings', resource: 'booking', invoke: (c, ctx) => c.pooling.settings(ctx), expect: { none: LIST } },
  { route: 'PUT transport/pooling/settings', resource: 'booking', invoke: (c, ctx) => c.pooling.updateSettings(ctx, { delayThresholdS: 900 } as never), expect: { none: ADMINS_ONLY } },
  { route: 'PUT transport/driver-policy', resource: 'booking', invoke: (c, ctx) => c.pooling.driverPolicy(ctx, { policy: null } as never), expect: { none: ADMINS_ONLY } },
  { route: 'GET transport/vehicles/:objectId/availability', resource: 'booking', invoke: (c, ctx, t) => c.pooling.availability(ctx, t.vehicle), expect: { party: F_READ, other: F_READ_OTHER } },
  { route: 'PUT transport/vehicles/:objectId/availability', resource: 'booking', invoke: (c, ctx, t) => c.pooling.putAvailability(ctx, t.vehicle, { windows: [] } as never), expect: { party: F_WRITE, other: F_WRITE_OTHER } },
  {
    route: 'POST transport/dispatch/live/decide',
    resource: 'booking',
    prepare: (s) => liveOn(s),
    invoke: (c, ctx, t) => c.live.decide(ctx, { bookingId: t.booking } as never, undefined),
    expect: { party: OWN_ROW, other: OTHER_ROW },
    verify: (r, role, own, t, w) => {
      if (own !== 'party') return;
      const text = JSON.stringify(r);
      if (text.includes(w.other.booking) || text.includes(w.other.vehicle)) fail(`${role} decision names another company's booking / vehicle`);
      if (/1[23]\.\d{4,}/.test(text)) fail(`${role} decision carries coordinates`);
      if ((r as { bookingId?: string }).bookingId !== t.booking) fail(`${role} decision is for another booking`);
    },
  },
  {
    route: 'GET transport/dispatch/live/requests',
    resource: 'booking',
    invoke: (c, ctx) => c.live.requests(ctx, {}),
    expect: { none: LIST },
    verify: (r, role, _own, _t, w) => {
      if ((r as { bookingId: string | null }[]).some((x) => x.bookingId === w.other.booking)) fail(`${role} log shows another company's request`);
    },
  },
  { route: 'GET me/transport/sharing-policy', resource: 'booking', invoke: (c, ctx) => c.mySharing.policy(ctx), expect: { none: SELF } },
];

export const POOLING_E5_MATRIX: E5Entry[] = [
  { route: 'POST driver/v1/trips/:id/route-ack', resource: 'driverTrip', invoke: (c, ctx, t) => c.routeAck.ack(ctx, t.trip, { routeVersion: 0, clientEventId: randomUUID() }), expect: { party: DRV_TRIP_A, other: DRV_TRIP_B } },
];
