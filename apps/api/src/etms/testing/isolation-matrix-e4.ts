/**
 * ETMS E4 part of the tenant-isolation matrix (doc 11 §3.1): every route-plans route × role × ownership, plus the world
 * the cases run in. Consumed by isolation-matrix.ts (ISOLATION_MATRIX) and isolation-matrix.spec.ts.
 *
 * World (on top of the E3 world): custA and custB each have two DRAFT plans of their branch (brA1 / brB1) for the `later`
 * service date, IN: one route on the company's vehicle carrying the company's passenger (an open booking with a
 * personal pickup, routing consent active, drop at the company place), timed from planStartAt. The plan is the
 * company's own (R1 corporate-managed): providers, the platform context and other companies get 404. Plans need
 * etms_planning (customer / provider templates hold it; fleet users and passengers 403); publish additionally needs
 * etms_dispatch:command.
 */
import { randomUUID } from 'crypto';
import type { RoutePlanDetailDto, RoutePlanSummaryDto } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import type { RoutePlansController } from '../planning/plans.controller';
import type { RoutePlanCreateController } from '../planning/plan-create';
import type { RoutingJobsController } from '../../routing-jobs/routing-jobs.controller';
import type { RoutingCapabilitiesController } from '../../routing-jobs/routing-capabilities.controller';
import type { E3World } from './isolation-matrix-e3';
import type { MatrixRole, RoleTable } from './isolation-matrix';
import type { MemoryStore } from './memory-store';

export type E4Resource = 'routePlan';
export const E4_RESOURCES: readonly E4Resource[] = ['routePlan'];

export interface E4Controllers {
  plans: RoutePlansController;
  /** WP 4.2: plan creation from bookings, optimisation jobs, capabilities. */
  create: RoutePlanCreateController;
  jobs: RoutingJobsController;
  caps: RoutingCapabilitiesController;
}

export interface E4Ids {
  plan: string;
  plan2: string;
  assignment: string;
  pickupStop: string;
  dropStop: string;
  booking: string;
  passenger: string;
  vehicle: string;
  /** A QUEUED optimisation job of `plan2` (WP 4.2). */
  job: string;
  /** The company place the plans serve (site of a new plan). */
  site: string;
}

export interface E4World {
  party: E4Ids;
  other: E4Ids;
  later: string;
}

const H = 3_600_000;

/** Exact personal pickup of the plan's passenger (a whole-company role sees it exactly, a branch dispatcher at 4 decimals). */
export const E4_PICKUP = { lat: 13.061234, lng: 80.241234 };

function seedPlan(store: MemoryStore, companyId: string, branchId: string, e3: E3World['party'], later: string, bookingId: string, name: string) {
  const place = store.table('poi').find((p) => p.id === e3.place)!;
  const plan = store.insert('routePlan', {
    companyId,
    branchId,
    name,
    planDate: new Date(`${later}T00:00:00Z`),
    planStartAt: new Date(Date.parse(`${later}T02:00:00Z`)),
    status: 'DRAFT',
    profile: 'car',
    graphVersion: null,
    depot: null,
    options: {},
    version: 1,
    publishedAt: null,
    direction: 'IN',
    shiftId: null,
    sitePoiId: e3.place,
    createdById: null,
  });
  const a = store.insert('routeAssignment', { planId: plan.id, companyId, objectId: e3.vehicle, driverId: null, vehicleLabel: `Van ${companyId}`, seq: 0, capacity: 4, distanceM: 9000, durationS: 1800, adjustedDurationS: 1800, startS: 0, endS: 1800, geometry: [[E4_PICKUP.lng, E4_PICKUP.lat], [place.lng, place.lat]], etaModel: null });
  const common = { planId: plan.id, companyId, assignmentId: a.id, demand: 1, serviceS: 60, timeWindows: null, unassignedReason: null, customerCompanyId: companyId, bookingId, snappedLat: null, snappedLng: null, snapDistanceM: null, snapGraphVersion: null };
  const pickup = store.insert('routePlanStop', { ...common, ref: `p-${bookingId.slice(0, 8)}`, name: null, lat: E4_PICKUP.lat, lng: E4_PICKUP.lng, sequence: 0, etaS: 600, stopKind: 'PICKUP', profileId: e3.passenger, poiId: null });
  const drop = store.insert('routePlanStop', { ...common, ref: `d-${bookingId.slice(0, 8)}`, name: 'Gate', lat: place.lat, lng: place.lng, sequence: 1, etaS: 1800, stopKind: 'DROP', profileId: null, poiId: e3.place });
  return { plan: plan.id as string, assignment: a.id as string, pickupStop: pickup.id as string, dropStop: drop.id as string };
}

function seedCompany(store: MemoryStore, companyId: string, branchId: string, e3: E3World['party'], later: string): E4Ids {
  const place = store.table('poi').find((p) => p.id === e3.place)!;
  const start = Date.parse(`${later}T02:00:00Z`);
  const booking = store.insert('transportBooking', {
    customerCompanyId: companyId,
    providerCompanyId: null,
    profileId: e3.passenger,
    shiftId: null,
    source: 'ADHOC',
    serviceDate: new Date(`${later}T00:00:00Z`),
    direction: 'IN',
    timeZone: 'Asia/Kolkata',
    pickupLat: E4_PICKUP.lat,
    pickupLng: E4_PICKUP.lng,
    dropLat: place.lat,
    dropLng: place.lng,
    dropPoiId: e3.place,
    dropLabel: 'Gate',
    pickupLabel: 'Home',
    windowStart: new Date(start),
    windowEnd: new Date(start + 1.5 * H),
    status: 'PENDING_ASSIGNMENT',
    cutoffAt: new Date(start - H),
  });
  const one = seedPlan(store, companyId, branchId, e3, later, booking.id as string, `Morning ${companyId}`);
  // A second plan (an alternative) over the same booking, for compare.
  const two = seedPlan(store, companyId, branchId, e3, later, booking.id as string, `Alternative ${companyId}`);
  const job = store.insert('routingJob', {
    companyId,
    planId: two.plan,
    userId: null,
    kind: 'optimize',
    status: 'QUEUED',
    phase: null,
    input: { kind: 'optimize', planId: two.plan, planVersion: 1, profile: 'car', timeLimitS: 10 },
    result: null,
    error: null,
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    timeoutS: 250,
    cancelRequested: false,
    idempotencyKey: null,
    requestHash: null,
    lockedBy: null,
    lockedUntil: null,
    notBefore: null,
    graphVersion: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
  });
  return { ...one, plan2: two.plan, booking: booking.id as string, passenger: e3.passenger, vehicle: e3.vehicle, job: job.id as string, site: e3.place };
}

/** Adds the E4 rows to an E3 world. */
export function seedE4(store: MemoryStore, e3: E3World): E4World {
  return { party: seedCompany(store, 'custA', 'brA1', e3.party, e3.later), other: seedCompany(store, 'custB', 'brB1', e3.other, e3.later), later: e3.later };
}

export function e4Ids(w: E4World, own: 'party' | 'other' | 'none'): E4Ids {
  if (own === 'party') return w.party;
  if (own === 'other') return w.other;
  const r = () => randomUUID();
  return { plan: r(), plan2: r(), assignment: r(), pickupStop: r(), dropStop: r(), booking: r(), passenger: r(), vehicle: r(), job: r(), site: r() };
}

// ───────────────────────────── Expected outcomes ─────────────────────────────

/** Lists of the caller's own company (empty elsewhere): every role holding etms_planning:view. */
const LIST: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
/** A custA plan: custA roles (the dispatcher's branch is the plan's); providers and the platform context 404. */
const OWN_PLAN: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
/** A custB plan: 404 for everyone holding the menu. */
const OTHER_PLAN: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 404 };
/** Discard needs etms_planning:delete (the dispatcher template has none: 403 before any lookup). */
const OWN_DELETE: RoleTable = { ...OWN_PLAN, customerDispatcher: 403, providerDispatcher: 403 };
const OTHER_DELETE: RoleTable = { ...OTHER_PLAN, customerDispatcher: 403, providerDispatcher: 403 };

export interface E4Entry {
  route: string;
  resource: E4Resource;
  invoke(c: E4Controllers, ctx: AuthContext, ids: E4Ids, w: E4World): Promise<unknown>;
  prepare?(store: MemoryStore, ids: E4Ids, w: E4World): void;
  expect: Partial<Record<'party' | 'other' | 'none', RoleTable>>;
  verify?(result: unknown, role: MatrixRole, own: 'party' | 'other' | 'none', ids: E4Ids, w: E4World): void;
}

const fail = (m: string): never => {
  throw new Error(`isolation matrix (E4): ${m}`);
};
const key = () => `matrix-${randomUUID()}`;

/** Lists never show another company's plan. */
const noOtherPlans = (result: unknown, role: MatrixRole, _own: string, _ids: E4Ids, w: E4World) => {
  const ids = (result as RoutePlanSummaryDto[]).map((p) => p.id);
  if (ids.includes(w.other.plan) || ids.includes(w.other.plan2)) fail(`${role} list shows another company's plan`);
};

/** Detail: the consented pickup exact for the whole-company admin, 4 decimals for the branch dispatcher (02 §7.2). */
const detailPoints = (result: unknown, role: MatrixRole, own: string) => {
  if (own !== 'party') return;
  const p = result as RoutePlanDetailDto;
  const pickup = p.stops.find((s) => s.stopKind === 'PICKUP');
  if (!pickup || pickup.pointHidden || pickup.lat === null) fail(`${role} detail hides the consented pickup`);
  const exact = pickup!.lat === E4_PICKUP.lat;
  if (role === 'customerDispatcher' && (exact || pickup!.lat !== 13.0612)) fail(`${role} gets ${pickup!.lat}, expected 4 decimals`);
  if ((role === 'customerAdmin' || role === 'superAdminSwitched') && !exact) fail(`${role} gets a rounded point`);
};

/** Compare: metrics only (no stop, point or passenger name). */
const metricsOnly = (result: unknown, role: MatrixRole) => {
  const text = JSON.stringify(result);
  if (text.includes('13.06') || text.includes('Passenger') || text.includes('stops":[')) fail(`${role} compare carries stop data`);
};

const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };

/** No host, URL or engine message in the capabilities answer. */
const noHosts = (result: unknown, role: MatrixRole) => {
  if (/https?:|127\.0\.0\.1|localhost|:8989|:8090/.test(JSON.stringify(result))) fail(`${role} capabilities carry a host / URL`);
};

/** Job lists never show another company's job. */
const noOtherJobs = (result: unknown, role: MatrixRole, _own: string, _ids: E4Ids, w: E4World) => {
  if ((result as { jobId: string }[]).some((j) => j.jobId === w.other.job)) fail(`${role} job list shows another company's job`);
};

/** A new plan from the company's own open booking: personal pickup = the booking's consented point, never another company's. */
const createdFromOwnBooking = (result: unknown, role: MatrixRole, _own: string, _ids: E4Ids, w: E4World) => {
  const p = result as RoutePlanDetailDto & { skippedBookings: unknown[] };
  if (p.stops.some((s) => s.bookingId === w.other.booking)) fail(`${role} plan took another company's booking`);
  if (!p.stops.some((s) => s.bookingId === w.party.booking && s.stopKind === 'PICKUP')) fail(`${role} plan lacks the company's open booking`);
};

export const E4_MATRIX: E4Entry[] = [
  // ── WP 4.2: create a plan from bookings, optimisation jobs, capabilities ──
  {
    route: 'POST transport/route-plans',
    resource: 'routePlan',
    invoke: (c, ctx, _t, w) =>
      c.create.create(ctx, { name: 'New plan', planDate: w.later, direction: 'IN', sitePoiId: w.party.site, objectIds: [w.party.vehicle], branchId: ctx.dataScope === 'COMPANY' ? null : 'brA1' }, key()),
    // custA's site and vehicle: custA roles create; everyone else 404 (another company's site), no menu 403.
    expect: { none: OWN_PLAN },
    verify: createdFromOwnBooking,
  },
  { route: 'GET routing/capabilities', resource: 'routePlan', invoke: (c, ctx) => c.caps.get(ctx), expect: { none: LIST }, verify: noHosts },
  {
    route: 'POST routing/jobs/optimize',
    resource: 'routePlan',
    invoke: (c, ctx, _t, w) => c.jobs.optimize(ctx, { planId: w.party.plan, expectedVersion: 1, weights: W }, key()),
    expect: { none: OWN_PLAN },
  },
  { route: 'GET routing/jobs', resource: 'routePlan', invoke: (c, ctx) => c.jobs.list(ctx, {}), expect: { none: LIST }, verify: noOtherJobs },
  { route: 'GET routing/jobs/:id', resource: 'routePlan', invoke: (c, ctx, t) => c.jobs.get(ctx, t.job), expect: { party: OWN_PLAN, other: OTHER_PLAN } },
  { route: 'POST routing/jobs/:id/cancel', resource: 'routePlan', invoke: (c, ctx, t) => c.jobs.cancel(ctx, t.job), expect: { party: OWN_PLAN, other: OTHER_PLAN } },
  // ── P9 plans ──
  { route: 'GET transport/route-plans', resource: 'routePlan', invoke: (c, ctx) => c.plans.list(ctx, {}), expect: { none: LIST }, verify: noOtherPlans },
  // compare names the company's own two plans: 404 for every caller outside custA (a plan of another scope is never compared).
  { route: 'GET transport/route-plans/compare', resource: 'routePlan', invoke: (c, ctx, _t, w) => c.plans.compare(ctx, { ids: `${w.party.plan},${w.party.plan2}` }), expect: { none: OWN_PLAN }, verify: metricsOnly },
  { route: 'GET transport/route-plans/:id', resource: 'routePlan', invoke: (c, ctx, t) => c.plans.get(ctx, t.plan), expect: { party: OWN_PLAN, other: OTHER_PLAN }, verify: detailPoints },
  { route: 'GET transport/route-plans/:id/history', resource: 'routePlan', invoke: (c, ctx, t) => c.plans.history(ctx, t.plan), expect: { party: OWN_PLAN, other: OTHER_PLAN } },
  {
    route: 'POST transport/route-plans/:id/move-passenger',
    resource: 'routePlan',
    invoke: (c, ctx, t) => c.plans.movePassenger(ctx, t.plan, { expectedVersion: 1, bookingId: t.booking, toAssignmentId: null }),
    expect: { party: OWN_PLAN, other: OTHER_PLAN },
  },
  {
    route: 'PUT transport/route-plans/:id/sequence',
    resource: 'routePlan',
    invoke: (c, ctx, t) => c.plans.resequence(ctx, t.plan, { expectedVersion: 1, assignments: [{ assignmentId: t.assignment, stopIds: [t.pickupStop, t.dropStop] }] }),
    expect: { party: OWN_PLAN, other: OTHER_PLAN },
  },
  { route: 'PATCH transport/route-plans/:id/assignments/:assignmentId', resource: 'routePlan', invoke: (c, ctx, t) => c.plans.updateAssignment(ctx, t.plan, t.assignment, { expectedVersion: 1, locked: true }), expect: { party: OWN_PLAN, other: OTHER_PLAN } },
  { route: 'PATCH transport/route-plans/:id/stops/:stopId', resource: 'routePlan', invoke: (c, ctx, t) => c.plans.updateStop(ctx, t.plan, t.pickupStop, { expectedVersion: 1, pinned: true }), expect: { party: OWN_PLAN, other: OTHER_PLAN } },
  { route: 'POST transport/route-plans/:id/discard', resource: 'routePlan', invoke: (c, ctx, t) => c.plans.discard(ctx, t.plan, { expectedVersion: 1 }), expect: { party: OWN_DELETE, other: OTHER_DELETE } },
  {
    route: 'POST transport/route-plans/:id/publish',
    resource: 'routePlan',
    invoke: (c, ctx, t) => c.plans.publish(ctx, t.plan, { expectedVersion: 1 }, key()),
    expect: { party: OWN_PLAN, other: OTHER_PLAN },
    verify: (r, role, own) => {
      if (own === 'party' && (r as { trips: { transportTripId: string }[] }).trips.length !== 1) fail(`${role} publish made no trip`);
    },
  },
];
