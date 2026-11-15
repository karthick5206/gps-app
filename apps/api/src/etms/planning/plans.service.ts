import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  can,
  meaningfulOverrideReason,
  overrideReasonText,
  planBookingsLimitMessage,
  ROUTE_PLAN_COMPARE_MAX,
  ROUTE_PLAN_EDITABLE,
  ROUTE_PLAN_OVERRIDE_REASON_MIN,
  ROUTING_LIMITS,
  routePlanLocks,
  uncalibratedEta,
  type ChangeSetResult,
  type LatLng,
  type RoutePlanAddBookingRefusal,
  type RoutePlanChangeType,
  type RoutePlanCompareDto,
  type RoutePlanDetailDto,
  type RoutePlanEditResult,
  type RoutePlanPublishCheck,
  type RoutePlanPublishDecision,
  type RoutePlanPublishResult,
  type RoutePlanReviewDto,
  type RoutePlanReviewUnassigned,
  type RoutePlanRouteError,
  type RoutePlanStatus,
  type RoutePlanRouteViolation,
  type RoutePlanStopViolation,
  type RoutePlanSummaryDto,
  type RoutePlanVersionDto,
  type RoutePlanVersionSnapshot,
  type RoutingDegradedReason,
  type TransportDirection,
} from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { driverScopeWhere } from '../../drivers/drivers.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ROUTING_PROVIDER, type RoutingProvider } from '../../routing/provider/routing-provider';
import { effectiveMaxRideS, maxRidePolicyOf, maxRideView } from '../../routing-jobs/max-ride';
import { RoutingHttpError } from '../../routing-jobs/routing-flags';
import { DispatchService, type PublishSource } from '../dispatch/dispatch.service';
import { idempotencyKey, idempotencyReused, inProfileBranch, invalid, isUniqueViolation, notFound, requestHash } from '../dispatch/e3-common';
import { preciseFor } from '../dispatch/e3-mapping';
import type { Replayable } from '../dispatch/bookings.service';
import { legWindow } from '../dispatch/service-dates';
import { overlapWhere } from '../dispatch/trip-overlap';
import { activeRoutingConsents } from '../people/people.service';
import { bookingStopRows, endProblem, PLAN_CANDIDATE_STATUSES, personalEnd, planSkipReason } from './plan-booking-scope';
import { AVAILABILITY_CODES, availabilityErrors, manualChanges, restorePlacements, reviewHashOf, routeSpan, snapshotRoutes } from './plan-review';
import { buildPlanChangeSet, pairProblem, pinnedStopsMoved, planMetrics, publishIssues, retime, routeStops, routeViolations, windowsOf, type PublishBooking, type RideRule, type PublishPlace, type PublishRoute, type RuleStop } from './plan-rules';
import { PLAN_INCLUDE, outOfScope, personalOwners, planSnapshot, seatsLookup, toPlanDetail, toPlanSummary, toRuleStop, type PlanPointView, type PlanRow, type ViewBooking } from './plan-view';
import { extendedPlanMetrics } from './plan-metrics';
import type { AddBookingDto, AssignmentUpdateDto, BookingPinDto, DiscardDto, MovePassengerDto, PlanListQuery, PublishDto, RecalculateDto, ResequenceDto, RestoreDto, ReviewQuery, StopUpdateDto } from './plans.dto';

export const PLAN_ENTITY = 'RoutePlan';
const EDITABLE = ROUTE_PLAN_EDITABLE as readonly string[];

const planError = (status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}) => new HttpException({ message, code, ...extra }, status);
const stale = (currentVersion: number) => planError(HttpStatus.CONFLICT, 'PLAN_STALE', 'The plan was changed meanwhile; reload it', { currentVersion });
const notEditable = (status: string) => planError(HttpStatus.CONFLICT, 'PLAN_NOT_EDITABLE', `A ${status} plan cannot be changed`);
/** WP-B: a published route is immutable (its trip exists); the rest of the plan stays editable. */
const alreadyPublished = (message = 'This route is already published; it can no longer be changed or published again') => planError(HttpStatus.CONFLICT, 'ROUTE_ALREADY_PUBLISHED', message);

/** WP-B: routes of the plan that were published (their TransportTrip links them; unique per route). */
export function publishedRoutes(plan: Pick<PlanRow, 'transportTrips'>): Set<string> {
  return new Set(plan.transportTrips.flatMap((t) => (t.routeAssignmentId ? [t.routeAssignmentId] : [])));
}

/** One entry of RoutePlan.options.publishes: a (partial) publish and what it was asked with (replay check). */
interface PublishRecord {
  changeSetId: string;
  requestHash: string;
  assignmentIds: string[];
  version: number;
  at: string;
}

const publishesOf = (options: unknown): PublishRecord[] => {
  const v = (options as { publishes?: unknown } | null)?.publishes;
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as PublishRecord[]) : [];
};

/** In-memory edit of a plan: new stop placements, assignment changes and options; the routes whose order changed. */
interface PlanEdit {
  /** stop id → new { assignmentId, sequence } (only stops that moved / were renumbered). */
  placements: Map<string, { assignmentId: string | null; sequence: number | null }>;
  assignments?: Map<string, Prisma.RouteAssignmentUncheckedUpdateInput>;
  options?: Prisma.InputJsonValue;
  /** WP-B add-booking: new stops (ids given up front) and the same stops as the rules see them. */
  createStops?: { rows: Prisma.RoutePlanStopCreateManyInput[]; rule: RuleStop[] };
  /** WP-B remove-booking: stops taken off the plan. */
  removeStopIds?: Set<string>;
  /** Routes to re-time on the engine (their order changed). */
  retime: Set<string>;
  /** Routes whose checks are reported (re-time ones + capacity changes). */
  checked: Set<string>;
  changeType: RoutePlanChangeType;
  details: Record<string, unknown>;
}

/**
 * ETMS route plans (doc 17 §7 P9, WP 4.2 / 4.5 backend): list / detail (consent-gated points, E3 trip-detail rules),
 * manual edits with optimistic versions, discard, compare (metrics only) and publish. Publish turns the plan into ONE
 * E3 change set and runs it through DispatchService.publishPrepared — the E3 publish transaction with its locks, scope,
 * consent, capacity and idempotency — so the result is ordinary E3 trips; the plan only records links to them and
 * becomes read-only (R-7: a plan is never an execution record). Scope: the caller's own company; ASSIGNED roles only
 * plans of their branches (404 otherwise).
 */
@Injectable()
export class RoutePlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dispatch: DispatchService,
    @Optional() @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider | null = null,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  /** Plans the caller may see: own company; ASSIGNED roles only their branches' plans (and branch-less plans they made). */
  planWhere(ctx: AuthContext): Prisma.RoutePlanWhereInput {
    if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
    return { companyId: ctx.companyId, OR: [{ branchId: { in: ctx.branchIds } }, { branchId: null, createdById: ctx.userId }] };
  }

  async list(ctx: AuthContext, q: PlanListQuery): Promise<RoutePlanSummaryDto[]> {
    const and: Prisma.RoutePlanWhereInput[] = [this.planWhere(ctx)];
    if (q.planDate) and.push({ planDate: new Date(`${q.planDate}T00:00:00Z`) });
    if (q.from) and.push({ planDate: { gte: new Date(`${q.from}T00:00:00Z`) } });
    if (q.to) and.push({ planDate: { lte: new Date(`${q.to}T00:00:00Z`) } });
    if (q.status) and.push({ status: q.status });
    if (q.direction) and.push({ direction: q.direction });
    const rows = await this.prisma.routePlan.findMany({
      where: { AND: and },
      include: { stops: { select: { assignmentId: true } }, assignments: { select: { id: true } } },
      orderBy: [{ planDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map(toPlanSummary);
  }

  async get(ctx: AuthContext, id: string): Promise<RoutePlanDetailDto> {
    const plan = await this.find(ctx, id);
    const view = await this.view(ctx, plan);
    const policyS = await maxRidePolicyOf(this.prisma, ctx.companyId);
    // D-M1: the plan's effective max ride (snapshot of the last optimisation, else override, else policy now).
    const ride = rideRuleOf(plan, policyS);
    const { dto, shown, named } = toPlanDetail(plan, view, ride);
    // Decision 5: the server's publish classification (as publish recomputes it) and what a publish accepted.
    // D-L1: with the vehicles' current seats, as publish uses them (not the capacity stored when the plan was drafted).
    // WP-B: over the routes still to publish (a published route is immutable), with the availability blockers.
    if (dto.editable) {
      const published = publishedRoutes(plan);
      const open = plan.assignments.filter((a) => !published.has(a.id));
      const capacities = routeCapacities({ assignments: open }, await this.currentSeats(ctx, plan));
      dto.publishCheck = { ...publishCheckFor(ctx, capacities, plan, dto, seatsLookup(view.bookings), ride), routeErrors: (await this.availability(ctx, plan, open, plan.stops.map(toRuleStop))).errors };
    } else dto.publishCheck = null;
    // D-L2: the override's stored violations with the refs as this caller sees them (like publishCheck).
    dto.publishDecision = publishDecisionShown(publishDecisionOf(plan.options), dto);
    // L1: a read that returned personal points or passenger names is ACCESS-audited (de-duplicated per user, view and day).
    await this.dispatch.recordPersonalAccess(ctx, 'plan', [...new Set([...shown, ...named])], dto.precise, { planId: id, ...(named.length ? { passengerNames: named.length } : {}) });
    // Owner decision 1: the max ride of the last optimisation and its source, the policy now, the plan's override.
    return { ...dto, maxRide: maxRideView(plan.options, policyS) };
  }

  /** Version history (newest first): ids, sequences and times only; another branch's stops lose their ref for ASSIGNED roles. */
  async history(ctx: AuthContext, id: string): Promise<RoutePlanVersionDto[]> {
    const plan = await this.find(ctx, id);
    const rows = await this.prisma.routePlanVersion.findMany({ where: { planId: id, companyId: ctx.companyId }, orderBy: { version: 'desc' }, take: 200 });
    let foreign = new Set<string>();
    if (ctx.dataScope !== 'COMPANY') {
      const view = await this.view(ctx, plan);
      foreign = new Set(plan.stops.filter((s) => outOfScope(s, view)).map((s) => s.id));
    }
    return [...rows].sort((a, b) => b.version - a.version).map((r) => {
      const snap = r.snapshot as unknown as RoutePlanVersionSnapshot;
      const stops = (snap?.stops ?? []).map((s) => (foreign.has(s.id) ? { ...s, ref: `stop-${s.id.slice(0, 8)}` } : s));
      return { version: r.version, changeType: r.changeType, changedById: r.changedById, createdAt: r.createdAt.toISOString(), snapshot: { ...snap, stops } };
    });
  }

  /** Metrics of 2..5 plans side by side (counts and sums only: no stops, points or passenger names). */
  async compare(ctx: AuthContext, rawIds: string): Promise<RoutePlanCompareDto> {
    const ids = [...new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length < 2 || ids.length > ROUTE_PLAN_COMPARE_MAX) throw invalid(`Compare 2 to ${ROUTE_PLAN_COMPARE_MAX} plans`);
    if (ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) throw invalid('ids must be plan ids');
    const plans = await this.prisma.routePlan.findMany({ where: { AND: [this.planWhere(ctx), { id: { in: ids } }] }, include: PLAN_INCLUDE });
    if (plans.length !== ids.length) throw notFound('Plan not found');
    const bookings = await this.bookingSeats(plans.flatMap((p) => p.stops));
    const seats = seatsLookup(bookings);
    return {
      plans: ids.map((id) => {
        const p = plans.find((x) => x.id === id)!;
        // E4 WP-A: + vehicles used, rides, occupancy, deadline compliance, excluded with reasons, strategy (plan-metrics.ts).
        return { ...planMetrics({ id: p.id, name: p.name, planDate: p.planDate, status: p.status as RoutePlanStatus, version: p.version, graphVersion: p.graphVersion, assignments: p.assignments, stops: p.stops.map(toRuleStop) }, seats), ...extendedPlanMetrics({ direction: p.direction as TransportDirection | null, options: p.options, assignments: p.assignments, stops: p.stops }, seats) };
      }),
    };
  }

  // ───────────────────────────── manual edits ─────────────────────────────

  /** Move one booking (both of its stops) to another route, or out of every route. */
  async movePassenger(ctx: AuthContext, id: string, dto: MovePassengerDto): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const ends = plan.stops.filter((s) => s.bookingId === dto.bookingId);
      // Another branch's passenger is a 404 for a branch dispatcher, like any id out of scope.
      if (!ends.length || ends.some((s) => outOfScope(s, view))) throw notFound('Booking not found on this plan');
      const locks = routePlanLocks(plan.options);
      const from = ends[0].assignmentId;
      const to = dto.toAssignmentId;
      // E4 review M1: a pin keeps the stop on its route (the same rule as resequence): moving the passenger within
      // that route is allowed, to another route or out of every route is not. Other stops' gaps never count.
      const endsTo = new Map(ends.map((s) => [s.id, { assignmentId: to ?? null, sequence: null }]));
      if (pinnedStopsMoved(locks.pinnedStopIds, ends, endsTo).size) throw planError(HttpStatus.CONFLICT, 'STOP_PINNED', 'A stop of this passenger is pinned to its route; unpin it first');
      if (to && !plan.assignments.some((a) => a.id === to)) throw notFound('Route not found');
      const published = publishedRoutes(plan);
      for (const r of [from, to]) if (r && published.has(r)) throw alreadyPublished();
      for (const r of [from, to]) if (r && locks.lockedAssignmentIds.has(r)) throw planError(HttpStatus.CONFLICT, 'ROUTE_LOCKED', 'The route is locked; unlock it first');
      const rule = plan.stops.map(toRuleStop);
      const placements = new Map<string, { assignmentId: string | null; sequence: number | null }>();
      const endIds = new Set(ends.map((s) => s.id));
      // Source routes: close the gaps.
      for (const r of new Set(ends.map((s) => s.assignmentId).filter((x): x is string => !!x))) {
        routeStops(rule, r)
          .filter((s) => !endIds.has(s.id))
          .forEach((s, i) => placements.set(s.id, { assignmentId: r, sequence: i }));
      }
      if (!to) {
        for (const s of ends) placements.set(s.id, { assignmentId: null, sequence: null });
      } else {
        const order = routeStops(rule, to).filter((s) => !endIds.has(s.id));
        const pickup = ends.find((s) => s.stopKind === 'PICKUP');
        const drop = ends.find((s) => s.stopKind === 'DROP');
        const others = ends.filter((s) => s !== pickup && s !== drop);
        const firstDrop = order.findIndex((s) => s.stopKind === 'DROP');
        const ids = order.map((s) => s.id);
        if (pickup) ids.splice(Math.min(dto.pickupIndex ?? (firstDrop >= 0 ? firstDrop : ids.length), ids.length), 0, pickup.id);
        if (drop) {
          const at = dto.dropIndex ?? ids.length;
          const min = pickup ? ids.indexOf(pickup.id) + 1 : 0;
          if (at < min) throw invalid('The drop must come after the pickup');
          ids.splice(Math.min(at, ids.length), 0, drop.id);
        }
        ids.push(...others.map((s) => s.id));
        ids.forEach((sid, i) => placements.set(sid, { assignmentId: to, sequence: i }));
      }
      const touched = new Set([from, to].filter((x): x is string => !!x));
      return { placements, retime: touched, checked: touched, changeType: 'EDITED', details: { change: 'move-passenger', bookingId: dto.bookingId, from, to } };
    });
  }

  /** Set the full stop order of the listed routes (reorder, or move stops between them). */
  async resequence(ctx: AuthContext, id: string, dto: ResequenceDto): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const locks = routePlanLocks(plan.options);
      const rule = plan.stops.map(toRuleStop);
      const byId = new Map(plan.stops.map((s) => [s.id, s]));
      const listed = new Set<string>();
      const seen = new Set<string>();
      for (const r of dto.assignments) {
        if (!plan.assignments.some((a) => a.id === r.assignmentId)) throw notFound('Route not found');
        if (listed.has(r.assignmentId)) throw invalid('A route is listed twice');
        listed.add(r.assignmentId);
        for (const s of r.stopIds) {
          if (!byId.has(s)) throw notFound('Stop not found');
          if (seen.has(s)) throw invalid('A stop is listed twice');
          seen.add(s);
        }
      }
      const placements = new Map<string, { assignmentId: string | null; sequence: number | null }>();
      for (const r of dto.assignments) r.stopIds.forEach((s, i) => placements.set(s, { assignmentId: r.assignmentId, sequence: i }));
      // Stops of a listed route that are not listed any more become unassigned.
      for (const a of listed) for (const s of routeStops(rule, a)) if (!seen.has(s.id)) placements.set(s.id, { assignmentId: null, sequence: null });
      const movedPins = pinnedStopsMoved(locks.pinnedStopIds, rule, placements);
      const published = publishedRoutes(plan);
      const changed = new Set<string>();
      for (const [sid, to] of placements) {
        const s = byId.get(sid)!;
        if (s.assignmentId === to.assignmentId && s.sequence === to.sequence) {
          placements.delete(sid);
          continue;
        }
        if (outOfScope(s, view)) throw notFound('Stop not found');
        if (movedPins.has(sid)) throw planError(HttpStatus.CONFLICT, 'STOP_PINNED', `Stop ${s.ref} is pinned to its route; unpin it first`);
        for (const r of [s.assignmentId, to.assignmentId]) {
          if (!r) continue;
          if (published.has(r)) throw alreadyPublished('A listed route is already published; it can no longer be changed');
          if (locks.lockedAssignmentIds.has(r)) throw planError(HttpStatus.CONFLICT, 'ROUTE_LOCKED', 'A listed route is locked; unlock it first');
          changed.add(r);
        }
      }
      // A stop that left an unlisted route closes that route's gap.
      for (const r of [...changed].filter((a) => !listed.has(a))) {
        routeStops(rule, r)
          .filter((s) => !placements.has(s.id))
          .forEach((s, i) => (s.sequence !== i ? placements.set(s.id, { assignmentId: r, sequence: i }) : undefined));
      }
      return { placements, retime: changed, checked: changed, changeType: 'RESEQUENCED', details: { change: 'sequence', routes: [...changed], stops: placements.size } };
    });
  }

  /** Change a route's vehicle / driver, or lock / unlock it. */
  async updateAssignment(ctx: AuthContext, id: string, assignmentId: string, dto: AssignmentUpdateDto): Promise<RoutePlanEditResult> {
    if (dto.objectId === undefined && dto.driverId === undefined && dto.locked === undefined) throw invalid('Nothing to change');
    // Scope checks outside the transaction (404 for another company's / branch's vehicle or driver).
    const vehicle = dto.objectId
      ? await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(ctx), { id: dto.objectId, isActive: true }] }, select: { id: true, name: true, plateNumber: true, companyId: true, transportProfile: { select: { seats: true } } } })
      : null;
    if (dto.objectId && (!vehicle || vehicle.companyId !== ctx.companyId)) throw notFound('Vehicle not found');
    if (dto.driverId) {
      const d = await this.prisma.driver.findFirst({ where: { AND: [driverScopeWhere(ctx), { id: dto.driverId, isActive: true }] }, select: { id: true } });
      if (!d) throw notFound('Driver not found');
    }
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const a = plan.assignments.find((x) => x.id === assignmentId);
      if (!a) throw notFound('Route not found');
      // E4 security review (informational): like the stop edits, a branch dispatcher may change only a route that
      // carries no passenger outside their scope (another branch's passenger is a 404, as everywhere).
      if (plan.stops.some((s) => s.assignmentId === a.id && outOfScope(s, view))) throw notFound('Route not found');
      if (publishedRoutes(plan).has(a.id)) throw alreadyPublished();
      const locks = routePlanLocks(plan.options);
      const lockedNow = dto.locked ?? locks.lockedAssignmentIds.has(a.id);
      if (locks.lockedAssignmentIds.has(a.id) && dto.locked !== false && (dto.objectId !== undefined || dto.driverId !== undefined)) throw planError(HttpStatus.CONFLICT, 'ROUTE_LOCKED', 'The route is locked; unlock it first');
      // QA B4: one vehicle cannot drive two routes of the same plan (publish would refuse it as VEHICLE_BUSY later).
      if (vehicle && plan.assignments.some((x) => x.id !== a.id && x.objectId === vehicle.id)) {
        throw planError(HttpStatus.CONFLICT, 'VEHICLE_DUPLICATE', 'This vehicle already drives another route of this plan');
      }
      // T1-D5: likewise one driver cannot drive two routes of the same plan (publish refused it later as DRIVER_BUSY,
      // naming the plan's own other route).
      if (dto.driverId && plan.assignments.some((x) => x.id !== a.id && x.driverId === dto.driverId)) {
        throw planError(HttpStatus.CONFLICT, 'DRIVER_DUPLICATE', 'This driver already drives another route of this plan');
      }
      const data: Prisma.RouteAssignmentUncheckedUpdateInput = {};
      if (vehicle) Object.assign(data, { objectId: vehicle.id, vehicleLabel: vehicle.plateNumber ? `${vehicle.name} (${vehicle.plateNumber})`.slice(0, 120) : vehicle.name, capacity: vehicle.transportProfile?.seats ?? null });
      if (dto.driverId !== undefined) data.driverId = dto.driverId;
      const lockedIds = new Set(locks.lockedAssignmentIds);
      if (lockedNow) lockedIds.add(a.id);
      else lockedIds.delete(a.id);
      const options = dto.locked === undefined ? undefined : ({ ...(plan.options as object), lockedAssignmentIds: [...lockedIds] } as Prisma.InputJsonValue);
      return {
        placements: new Map(),
        assignments: Object.keys(data).length ? new Map([[a.id, data]]) : undefined,
        options,
        retime: new Set(),
        checked: new Set([a.id]),
        changeType: 'EDITED',
        details: { change: 'assignment', assignmentId: a.id, ...(vehicle ? { objectId: vehicle.id, capacity: vehicle.transportProfile?.seats ?? null } : {}), ...(dto.driverId !== undefined ? { driverId: dto.driverId } : {}), ...(dto.locked !== undefined ? { locked: dto.locked } : {}) },
      };
    });
  }

  /**
   * Pin / unpin a stop. Re-optimising keeps a pinned stop on its vehicle (solver pinnedVehicleId); its place in the
   * order may change (T2-D6: no solver position constraint; lock the route to keep the exact order). Manual edits follow
   * the same rule: a pinned stop may change place within its route but never leaves it (STOP_PINNED; pinnedStopsMoved).
   */
  async updateStop(ctx: AuthContext, id: string, stopId: string, dto: StopUpdateDto): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const s = plan.stops.find((x) => x.id === stopId);
      if (!s || outOfScope(s, view)) throw notFound('Stop not found');
      return pinEdit(plan, [s], dto.pinned, { change: 'pin', stopId: s.id, pinned: dto.pinned });
    });
  }

  /** WP-B: pin / unpin both stops of a passenger's booking (the stop pin rule, for the two ends together). */
  async pinBooking(ctx: AuthContext, id: string, bookingId: string, dto: BookingPinDto): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const ends = plan.stops.filter((s) => s.bookingId === bookingId);
      if (!ends.length || ends.some((s) => outOfScope(s, view))) throw notFound('Booking not found on this plan');
      return pinEdit(plan, ends, dto.pinned, { change: 'pin-booking', bookingId, stopIds: ends.map((s) => s.id), pinned: dto.pinned });
    });
  }

  /**
   * WP-B: re-time routes on the road engine in their current order (default: every unpublished route with stops; for a
   * branch dispatcher, those carrying no passenger outside their scope). ETAs null with the reason when the engine does
   * not answer, never estimated (the edit() rule). A published route cannot be re-timed (its trip is the record now).
   */
  async recalculate(ctx: AuthContext, id: string, dto: RecalculateDto): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const published = publishedRoutes(plan);
      const rule = plan.stops.map(toRuleStop);
      const foreign = (aid: string) => plan.stops.some((s) => s.assignmentId === aid && outOfScope(s, view));
      let ids: string[];
      if (dto.assignmentIds) {
        ids = [...new Set(dto.assignmentIds)];
        for (const aid of ids) {
          if (!plan.assignments.some((a) => a.id === aid) || foreign(aid)) throw notFound('Route not found');
          if (published.has(aid)) throw alreadyPublished();
        }
      } else {
        ids = plan.assignments.filter((a) => !published.has(a.id) && routeStops(rule, a.id).length > 0 && !foreign(a.id)).map((a) => a.id);
      }
      if (!ids.length) throw invalid('No route with stops to recalculate');
      return { placements: new Map(), retime: new Set(ids), checked: new Set(ids), changeType: 'RECALCULATED', details: { change: 'recalculate', routes: ids } };
    });
  }

  /**
   * WP-B undo / redo backbone: put back the route membership and stop order of an earlier version (restorePlacements):
   * only while the plan's stop set is that version's (409 PLAN_RESTORE_CONFLICT with the stop ids added / removed
   * since); locked and published routes stay as they are; a pinned stop never leaves its route (409 STOP_PINNED); another
   * branch's passenger is a 404 for a branch dispatcher, like every edit. Changed routes are re-timed like any edit, and a
   * new version is recorded (EDITED; the audit names restoredFrom). Vehicles, drivers, locks and pins are not restored.
   */
  async restore(ctx: AuthContext, id: string, dto: RestoreDto): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, dto.expectedVersion, async (plan, view) => {
      const row = await this.prisma.routePlanVersion.findFirst({ where: { planId: id, companyId: ctx.companyId, version: dto.version }, select: { snapshot: true } });
      if (!row) throw notFound('Version not found');
      const snap = row.snapshot as unknown as RoutePlanVersionSnapshot;
      const locks = routePlanLocks(plan.options);
      const fixed = new Set([...locks.lockedAssignmentIds, ...publishedRoutes(plan)]);
      const rule = plan.stops.map(toRuleStop);
      const r = restorePlacements(snap, rule, new Set(plan.assignments.map((a) => a.id)), fixed);
      if (r.conflict) {
        const n = r.conflict.addedStopIds.length + r.conflict.removedStopIds.length;
        throw planError(HttpStatus.CONFLICT, 'PLAN_RESTORE_CONFLICT', `Version ${dto.version} cannot be restored: ${n} stop(s) were added or removed since; edit the plan instead`, r.conflict);
      }
      const byId = new Map(plan.stops.map((s) => [s.id, s]));
      for (const sid of r.placements.keys()) if (outOfScope(byId.get(sid)!, view)) throw notFound('Stop not found');
      const moved = pinnedStopsMoved(locks.pinnedStopIds, rule, r.placements);
      if (moved.size) throw planError(HttpStatus.CONFLICT, 'STOP_PINNED', `Stop ${byId.get([...moved][0])!.ref} is pinned to its route; unpin it first`);
      return {
        placements: r.placements,
        retime: r.changed,
        checked: r.changed,
        changeType: 'EDITED',
        details: { change: 'restore', restoredFrom: dto.version, routes: [...r.changed], stops: r.placements.size, ...(r.skippedRoutes.length ? { skippedRoutes: r.skippedRoutes } : {}) },
      };
    });
  }

  /**
   * WP-B: add an open booking to a draft (its two stops, unassigned: optimise or move it onto a route). Only a booking
   * plan creation would have taken for this plan — same service date and direction, PENDING_ASSIGNMENT, COMMUTE, the
   * plan's site, shift and branch (planSkipReason), a usable point and, for a personal end, the passenger's active
   * routing consent (endProblem) — and only up to ROUTING_LIMITS.planBookings bookings (422 LIMIT_EXCEEDED, the shared
   * message). A booking outside the caller's branches is a 404 (it is invisible to them). Refusals: 409
   * BOOKING_NOT_PLANNABLE with `reason`, 409 BOOKING_ALREADY_ON_PLAN.
   */
  async addBooking(ctx: AuthContext, id: string, dto: AddBookingDto): Promise<RoutePlanEditResult> {
    const b = await this.prisma.transportBooking.findFirst({ where: { id: dto.bookingId, customerCompanyId: ctx.companyId }, include: { profile: { select: { branchId: true } } } });
    if (!b || !inProfileBranch(ctx, b.profile?.branchId)) throw notFound('Booking not found');
    return this.edit(ctx, id, dto.expectedVersion, async (plan) => {
      if (plan.stops.some((s) => s.bookingId === b.id)) throw planError(HttpStatus.CONFLICT, 'BOOKING_ALREADY_ON_PLAN', 'This booking is already on the plan');
      const direction = (plan.direction as TransportDirection | null) ?? null;
      if (!direction || !plan.sitePoiId) throw invalid('Only a plan built for a site and direction takes bookings');
      const refuse = (reason: RoutePlanAddBookingRefusal, message: string) => planError(HttpStatus.CONFLICT, 'BOOKING_NOT_PLANNABLE', message, { reason });
      const day = plan.planDate.toISOString().slice(0, 10);
      if (b.serviceDate.toISOString().slice(0, 10) !== day) throw refuse('other_date', 'The booking is for another date');
      if (b.direction !== direction) throw refuse('other_direction', 'The booking is for the other direction');
      if (!(PLAN_CANDIDATE_STATUSES as readonly string[]).includes(b.status)) throw refuse('not_open', `The booking is ${b.status}, not waiting for a seat`);
      const shift = plan.shiftId ? await this.prisma.transportShift.findFirst({ where: { id: plan.shiftId, companyId: ctx.companyId }, select: { startMin: true, endMin: true, timeZone: true } }) : null;
      const reason = planSkipReason(
        { ...b, journey: b.journey as 'COMMUTE' | 'POINT_TO_POINT', branchId: b.profile?.branchId ?? null },
        { direction, sitePoiId: plan.sitePoiId, shiftId: plan.shiftId, shiftLeg: shift ? legWindow(shift, direction, day) : null, branchId: plan.branchId },
      );
      if (reason) throw refuse(reason, `This booking does not fit the plan (${reason.replace(/_/g, ' ')})`);
      const problem = endProblem(b, direction, await activeRoutingConsents(this.prisma, [b.profileId]));
      if (problem) throw refuse(problem, problem === 'needs_location' ? 'The booking has no pickup or drop point' : 'The passenger has no active routing consent');
      const count = new Set([...plan.stops.flatMap((s) => (s.bookingId ? [s.bookingId] : [])), b.id]).size;
      if (count > ROUTING_LIMITS.planBookings) throw new RoutingHttpError('LIMIT_EXCEEDED', planBookingsLimitMessage(count));
      const site = await this.prisma.poi.findFirst({ where: { id: plan.sitePoiId, companyId: ctx.companyId }, select: { id: true, name: true, lat: true, lng: true } });
      if (!site) throw notFound('Site not found');
      const endPoi = personalEnd(b, direction).poiId;
      const place = endPoi ? await this.prisma.poi.findFirst({ where: { id: endPoi, companyId: ctx.companyId }, select: { name: true } }) : null;
      const startMs = plan.planStartAt?.getTime() ?? Date.parse(`${day}T00:00:00Z`);
      const rows = bookingStopRows(b, { id: plan.id, companyId: ctx.companyId, direction, startMs }, site, () => place?.name ?? null, { passenger: randomUUID(), site: randomUUID() });
      const rule: RuleStop[] = rows.map((r) => ({
        id: r.id!,
        ref: r.ref,
        assignmentId: null,
        sequence: null,
        etaS: null,
        serviceS: r.serviceS ?? 0,
        demand: r.demand ?? 0,
        timeWindows: windowsOf(r.timeWindows),
        stopKind: r.stopKind === 'PICKUP' || r.stopKind === 'DROP' ? r.stopKind : null,
        bookingId: r.bookingId ?? null,
        profileId: r.profileId ?? null,
        poiId: r.poiId ?? null,
        lat: r.lat,
        lng: r.lng,
        name: r.name ?? null,
      }));
      return { placements: new Map(), createStops: { rows, rule }, retime: new Set(), checked: new Set(), changeType: 'EDITED', details: { change: 'add-booking', bookingId: b.id, stops: rows.length } };
    });
  }

  /**
   * WP-B: take a booking's stops off a draft (the booking itself stays open, waiting for a seat). Not from a locked route
   * (409 ROUTE_LOCKED) or a published one (409 ROUTE_ALREADY_PUBLISHED), not while a stop is pinned (409 STOP_PINNED);
   * the route it leaves closes its gap and is re-timed.
   */
  async removeBooking(ctx: AuthContext, id: string, bookingId: string, expectedVersion: number): Promise<RoutePlanEditResult> {
    return this.edit(ctx, id, expectedVersion, async (plan, view) => {
      const ends = plan.stops.filter((s) => s.bookingId === bookingId);
      if (!ends.length || ends.some((s) => outOfScope(s, view))) throw notFound('Booking not found on this plan');
      const locks = routePlanLocks(plan.options);
      const published = publishedRoutes(plan);
      const routes = new Set(ends.flatMap((s) => (s.assignmentId ? [s.assignmentId] : [])));
      for (const r of routes) if (published.has(r)) throw alreadyPublished();
      for (const r of routes) if (locks.lockedAssignmentIds.has(r)) throw planError(HttpStatus.CONFLICT, 'ROUTE_LOCKED', 'The route is locked; unlock it first');
      if (ends.some((s) => locks.pinnedStopIds.has(s.id))) throw planError(HttpStatus.CONFLICT, 'STOP_PINNED', 'A stop of this passenger is pinned; unpin it first');
      const endIds = new Set(ends.map((s) => s.id));
      const rule = plan.stops.map(toRuleStop);
      const placements = new Map<string, { assignmentId: string | null; sequence: number | null }>();
      for (const r of routes) {
        routeStops(rule, r)
          .filter((s) => !endIds.has(s.id))
          .forEach((s, i) => placements.set(s.id, { assignmentId: r, sequence: i }));
      }
      return { placements, removeStopIds: endIds, retime: routes, checked: routes, changeType: 'EDITED', details: { change: 'remove-booking', bookingId, from: [...routes][0] ?? null, stops: endIds.size } };
    });
  }

  /**
   * DRAFT / PLANNED → CANCELLED (history kept; nothing deleted; no trip is touched). WP-B: after a partial publish only
   * the unpublished remainder is dropped — the published routes and their trips stand, so the plan closes as PUBLISHED
   * (read-only) instead of CANCELLED; its unpublished routes simply have no trip.
   */
  async discard(ctx: AuthContext, id: string, dto: DiscardDto): Promise<RoutePlanDetailDto> {
    const plan = await this.find(ctx, id);
    if (!EDITABLE.includes(plan.status)) throw notEditable(plan.status);
    if (plan.version !== dto.expectedVersion) throw stale(plan.version);
    const published = publishedRoutes(plan);
    const to: RoutePlanStatus = published.size ? 'PUBLISHED' : 'CANCELLED';
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.routePlan.updateMany({
        where: { id, companyId: ctx.companyId, version: dto.expectedVersion, status: { in: [...EDITABLE] as RoutePlanStatus[] } },
        data: { status: to, version: { increment: 1 }, ...(to === 'PUBLISHED' && !plan.publishedAt ? { publishedAt: new Date() } : {}) },
      });
      if (!n.count) throw stale(plan.version);
      await this.recordVersion(tx, ctx, plan, plan.version + 1, 'CANCELLED', to, plan.stops.map(toRuleStop));
      const remainder = published.size ? { publishedRoutes: published.size, discardedRoutes: plan.assignments.filter((a) => !published.has(a.id) && plan.stops.some((s) => s.assignmentId === a.id)).length } : {};
      await this.audit.record(ctx, { action: 'DELETE', entity: PLAN_ENTITY, entityId: id, details: { discarded: true, from: plan.status, to, version: plan.version + 1, ...remainder, ...(dto.reason ? { reason: dto.reason } : {}) } }, tx);
    });
    return this.get(ctx, id);
  }

  /**
   * Common path of every manual edit: scope (404), state (DRAFT / PLANNED), the version the client saw, the change
   * computed in memory, pickup-before-drop on one route, a road re-time of the routes whose order changed (outside
   * the transaction; ETAs null with the reason when the engine does not answer — never estimated), then one
   * transaction with a compare-and-set on the version, the rows, a history row (no coordinates) and a CHANGE audit.
   */
  private async edit(ctx: AuthContext, id: string, expectedVersion: number, change: (plan: PlanRow, view: PlanPointView) => Promise<PlanEdit>): Promise<RoutePlanEditResult> {
    const plan = await this.find(ctx, id);
    if (!EDITABLE.includes(plan.status)) throw notEditable(plan.status);
    if (plan.version !== expectedVersion) throw stale(plan.version);
    const view = await this.view(ctx, plan);
    const e = await change(plan, view);
    // WP-B defence in depth: whatever the change, a published route keeps its stops, order, times and vehicle.
    const published = publishedRoutes(plan);
    if (published.size) {
      const byId = new Map(plan.stops.map((s) => [s.id, s]));
      const touches = (sid: string, to: string | null) => [byId.get(sid)?.assignmentId ?? null, to].some((r) => !!r && published.has(r));
      if ([...e.placements].some(([sid, p]) => touches(sid, p.assignmentId)) || [...(e.removeStopIds ?? [])].some((sid) => touches(sid, null)) || [...e.retime, ...(e.assignments?.keys() ?? [])].some((r) => published.has(r))) throw alreadyPublished();
    }
    const stops = [...plan.stops.filter((s) => !e.removeStopIds?.has(s.id)).map(toRuleStop), ...(e.createStops?.rule ?? [])].map((s) => (e.placements.has(s.id) ? { ...s, ...e.placements.get(s.id)! } : s));
    const problem = pairProblem(stops);
    if (problem) throw invalid(problem);
    // The edit's value whenever it sets the key, including null (a vehicle without seats): `?? old` kept the previous
    // route's capacity and hid VEHICLE_NO_SEATS and the capacity checks (E4 re-check R1 / QA B4).
    const edited = (id: string, key: 'capacity' | 'objectId', old: unknown): unknown => {
      const d = e.assignments?.get(id) as Record<string, unknown> | undefined;
      return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : old;
    };
    const capacity = new Map(plan.assignments.map((a) => [a.id, (edited(a.id, 'capacity', a.capacity) as number | null | undefined) ?? null]));
    const seats = seatsLookup(view.bookings);
    const ride = rideRuleOf(plan, await maxRidePolicyOf(this.prisma, ctx.companyId));

    // Re-time routes whose order changed (engine outside the transaction).
    let degraded: RoutingDegradedReason | null = null;
    const assignmentData = new Map(e.assignments ?? []);
    const etas = new Map<string, number | null>();
    for (const aid of e.retime) {
      const a = plan.assignments.find((x) => x.id === aid)!;
      const list = routeStops(stops, aid);
      const t = await this.retimeRoute(plan, a, list);
      if (t.degraded) degraded = t.degraded;
      list.forEach((s, i) => etas.set(s.id, t.etas[i]));
      assignmentData.set(aid, { ...(assignmentData.get(aid) ?? {}), ...t.data });
    }
    // Unassigned stops have no ETA.
    for (const s of stops) if (!s.assignmentId && s.etaS !== null && e.placements.has(s.id)) etas.set(s.id, null);
    const timed = stops.map((s) => (etas.has(s.id) ? { ...s, etaS: etas.get(s.id)! } : s));
    const violations: RoutePlanStopViolation[] = [];
    for (const aid of e.checked) violations.push(...routeViolations(routeStops(timed, aid), capacity.get(aid) ?? null, seats, e.retime.has(aid) && !degraded, ride));
    // QA B4: a route with a vehicle but no seat profile (capacity null) cannot be published; say so now.
    const routeViolationsOut: RoutePlanRouteViolation[] = [];
    for (const aid of e.checked) {
      const a = plan.assignments.find((x) => x.id === aid);
      const objectId = (edited(aid, 'objectId', a?.objectId ?? null) as string | null | undefined) ?? null;
      if (objectId && (capacity.get(aid) ?? null) === null) {
        routeViolationsOut.push({ assignmentId: aid, code: 'VEHICLE_NO_SEATS', message: 'The vehicle has no passenger seats set; set its seats before publishing' });
      }
    }

    const next = plan.version + 1;
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.routePlan.updateMany({
        where: { id, companyId: ctx.companyId, version: expectedVersion, status: { in: [...EDITABLE] as RoutePlanStatus[] } },
        data: { version: { increment: 1 }, ...(e.options !== undefined ? { options: e.options } : {}) },
      });
      if (!n.count) throw stale(plan.version);
      if (e.removeStopIds?.size) await tx.routePlanStop.deleteMany({ where: { planId: id, companyId: ctx.companyId, id: { in: [...e.removeStopIds] } } });
      if (e.createStops?.rows.length) await tx.routePlanStop.createMany({ data: e.createStops.rows });
      const moved = new Set([...e.placements.keys(), ...etas.keys()]);
      for (const sid of moved) {
        const p = e.placements.get(sid);
        await tx.routePlanStop.update({
          where: { id: sid },
          data: { ...(p ? { assignmentId: p.assignmentId, sequence: p.sequence, unassignedReason: null } : {}), ...(etas.has(sid) ? { etaS: etas.get(sid) } : {}) },
        });
      }
      for (const [aid, data] of assignmentData) await tx.routeAssignment.update({ where: { id: aid }, data });
      const assignments = plan.assignments.map((a) => ({ ...a, ...(assignmentData.get(a.id) as Partial<typeof a>) }));
      await this.recordVersion(tx, ctx, { ...plan, assignments }, next, e.changeType, plan.status as RoutePlanStatus, timed);
      await this.audit.record(ctx, { action: 'UPDATE', entity: PLAN_ENTITY, entityId: id, details: { ...e.details, version: next, violations: violations.length, ...(degraded ? { degraded } : {}) } as Prisma.InputJsonValue }, tx);
    });
    return { plan: await this.get(ctx, id), violations, degraded, routeViolations: routeViolationsOut };
  }

  /**
   * Road re-time of one route in its new order through the RoutingProvider (GraphHopper): depot → stops → depot when the
   * plan has a depot, else from the first stop. Legs the engine could not route (estimatedLegs) and a failed engine give
   * null ETAs from there on (never a straight-line or default-speed number).
   */
  private async retimeRoute(plan: PlanRow, a: PlanRow['assignments'][number], list: RuleStop[]): Promise<{ etas: (number | null)[]; data: Prisma.RouteAssignmentUncheckedUpdateInput; degraded: RoutingDegradedReason | null }> {
    if (!list.length) return { etas: [], data: { distanceM: 0, durationS: 0, adjustedDurationS: 0, endS: a.startS ?? 0, geometry: Prisma.DbNull }, degraded: null };
    const depot = (plan.depot as LatLng | null) ?? null;
    const points: LatLng[] = [...(depot ? [depot] : []), ...list.map((s) => ({ lat: s.lat, lng: s.lng })), ...(depot ? [depot] : [])];
    const startS = a.startS ?? list[0].etaS ?? 0;
    const empty = { distanceM: null, durationS: null, adjustedDurationS: null, endS: null, geometry: Prisma.DbNull } satisfies Prisma.RouteAssignmentUncheckedUpdateInput;
    if (points.length < 2) {
      const t = retime(startS, [0], list, 0);
      return { etas: t.etas, data: { ...empty, distanceM: 0, durationS: t.endS === null ? null : t.endS - startS, adjustedDurationS: t.endS === null ? null : t.endS - startS, endS: t.endS }, degraded: null };
    }
    const r = this.routing ? await this.routing.routeVia(points, { profile: 'car' }).catch(() => null) : null;
    if (!r || !r.ok) return { etas: list.map(() => null), data: empty, degraded: r && !r.ok ? r.degraded : 'ENGINE_DISABLED' };
    const legs = r.value.legs.map((l, i) => (r.value.estimatedLegs.includes(i) ? null : l.durationSec));
    const into = depot ? legs.slice(0, list.length) : [0, ...legs];
    const last = depot ? legs[list.length] : 0;
    const t = retime(startS, into, list, last);
    const duration = t.endS === null ? null : t.endS - startS;
    const estimated = r.value.estimatedLegs.length > 0;
    return {
      etas: t.etas,
      data: {
        distanceM: estimated ? null : Math.round(r.value.distanceM),
        durationS: duration,
        adjustedDurationS: duration,
        startS,
        endS: t.endS,
        geometry: r.value.path as unknown as Prisma.InputJsonValue,
        etaModel: { ...uncalibratedEta(r.eta.graphVersion) } as unknown as Prisma.InputJsonValue,
      },
      degraded: estimated ? 'NO_ROUTE' : null,
    };
  }

  // ───────────────────────────── publish ─────────────────────────────

  /** The seats of the plan's vehicles now (objectId → seats or null); a vehicle outside the caller's scope is absent. */
  private async currentSeats(ctx: AuthContext, plan: Pick<PlanRow, 'assignments'>): Promise<Map<string, number | null>> {
    const objectIds = plan.assignments.flatMap((a) => (a.objectId ? [a.objectId] : []));
    const vehicles = objectIds.length ? await this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds }, isActive: true }] }, select: { id: true, companyId: true, transportProfile: { select: { seats: true } } } }) : [];
    return new Map(vehicles.filter((v) => v.companyId === ctx.companyId).map((v) => [v.id, v.transportProfile?.seats ?? null]));
  }

  /**
   * Publish the plan through the E3 publish path (doc 17 P9, 15 §8.4): pre-checks per route (409 PLAN_NOT_PUBLISHABLE,
   * nothing written), then ONE change set — a CREATE_TRIP + ADD_PASSENGERs per route — via DispatchService.publishPrepared
   * (advisory locks, scope, consent, capacity, overlap, ledger, Idempotency-Key). Inside that same transaction the plan
   * version is compare-and-set and each TransportTrip gets routePlanId / routeAssignmentId. Any failure rolls back every
   * route; the error names the route that failed.
   *
   * States (QA B3 decision): a successful optimisation leaves the plan PLANNED; manual edits keep its status (a PLANNED
   * plan stays PLANNED and editable). A never-optimised DRAFT plan may also be published (a dispatcher may build a plan
   * by hand), but only when every route passes the same per-route validation as a PLANNED one (scope, seats, consent,
   * pickup before drop, bookings still open); otherwise 409 PLAN_NOT_PUBLISHABLE and nothing is written.
   *
   * WP-B selected-routes publishing: `assignmentIds` publishes only those routes (default: every unpublished route with
   * stops — the whole-plan publish) through the SAME transaction, ledger, idempotency and audits; it needs the
   * `reviewHash` of GET /:id/review for that selection (409 PLAN_REVIEW_REQUIRED / PLAN_REVIEW_STALE). The whole-plan
   * publish keeps working without a hash (the current web client), and checks one when given. The plan becomes PUBLISHED
   * with its last unpublished route; until then it stays DRAFT / PLANNED and editable, its published routes immutable.
   * Vehicle / driver availability (VEHICLE_BUSY / DRIVER_BUSY, inactive) is checked before anything is written. Of two
   * concurrent publishes of one plan exactly one wins (the plan row is locked and re-checked inside the transaction:
   * the other gets 409 ROUTE_ALREADY_PUBLISHED or PLAN_STALE); TransportTrip.routeAssignmentId UNIQUE stays the backstop.
   */
  async publish(ctx: AuthContext, id: string, dto: PublishDto, headerKey: string | undefined): Promise<Replayable<RoutePlanPublishResult>> {
    // Publishing makes dispatch trips: the caller needs the dispatcher's publish grant too (like a change set).
    if (!can(ctx.permissions, 'etms_dispatch', 'command')) throw new ForbiddenException({ message: 'Publishing a plan needs Dispatch: command', code: 'FORBIDDEN_GRANT' });
    const key = idempotencyKey(headerKey ?? dto.idempotencyKey);
    const plan = await this.find(ctx, id);
    if (dto.assignmentIds && !dto.reviewHash) throw planError(HttpStatus.CONFLICT, 'PLAN_REVIEW_REQUIRED', 'Review the selected routes (GET …/review) and confirm with their reviewHash to publish them');
    // Decision 5: the acknowledgement / override fields are part of the request (bound into the idempotency hash); WP-B:
    // the selection and the review hash too (only when given, so a whole-plan publish hashes exactly as before).
    const overrideReason = dto.override ? normaliseReason(dto.override.reason) : null;
    const acknowledged = dto.acknowledgedWarnings ?? null;
    const selection = dto.assignmentIds ? [...new Set(dto.assignmentIds)].sort() : null;
    const decisionHash = requestHash({ acknowledgedWarnings: acknowledged, override: overrideReason, ...(selection ? { assignmentIds: selection } : {}), ...(dto.reviewHash ? { reviewHash: dto.reviewHash } : {}) });
    // A key already used: the same caller's same request replays (whatever the plan's state now); anything else is refused.
    const ledger = await this.prisma.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key } });
    if (ledger) return this.replayPublished(ctx, plan, ledger, decisionHash);
    if (!EDITABLE.includes(plan.status)) throw notEditable(plan.status);
    if (plan.version !== dto.expectedVersion) throw stale(plan.version);
    if (overrideReason !== null) {
      if (!canOverridePublish(ctx)) throw new ForbiddenException({ message: 'Overriding the publish checks needs a whole-company role with Dispatch: command and Route planning: command', code: 'PUBLISH_OVERRIDE_FORBIDDEN' });
      if (!meaningfulReason(overrideReason)) throw planError(HttpStatus.BAD_REQUEST, 'PUBLISH_OVERRIDE_REASON_REQUIRED', `Give a reason of at least ${ROUTE_PLAN_OVERRIDE_REASON_MIN} characters (two words or more) for the override`);
    }

    const p = await this.preparePublish(ctx, plan, selection ?? undefined);
    // WP-B: the confirmation must be of exactly this content (vehicles, drivers, ordered stops, ETAs, warnings, version).
    if (dto.reviewHash && dto.reviewHash !== p.reviewHash) {
      throw planError(HttpStatus.CONFLICT, 'PLAN_REVIEW_STALE', 'The selected routes changed since you reviewed them; review them again', { reviewHash: p.reviewHash });
    }
    if (p.errors.length) {
      // Availability only: the E3 code itself (VEHICLE_BUSY / DRIVER_BUSY / …), as the E3 publish would have answered.
      const code = p.errors.every((e) => AVAILABILITY_CODES.has(e.code)) ? p.errors[0].code : 'PLAN_NOT_PUBLISHABLE';
      const message = code === 'PLAN_NOT_PUBLISHABLE' ? `The plan cannot be published: ${p.errors[0].message}` : p.errors[0].message;
      throw planError(HttpStatus.CONFLICT, code, `${message}${p.errors.length > 1 ? ` (and ${p.errors.length - 1} more)` : ''}`, { routes: p.errors });
    }

    // Decision 5, recomputed from the stored plan with the vehicles' current seats: hard issues block (only arrival
    // windows may be overridden, by an authorised caller with a reason); soft warnings need this exact set acknowledged.
    const { issues, cs, stops } = p;
    const blocking = issues.hard.filter((i) => !i.overridable);
    if (blocking.length || (issues.hard.length && overrideReason === null)) {
      const overridable = !blocking.length;
      throw planError(HttpStatus.CONFLICT, 'PLAN_HAS_HARD_VIOLATIONS', `The plan has ${issues.hard.length} hard violation(s) (${[...new Set(issues.hard.map((i) => i.kind))].join(', ')}); edit or re-optimise it${overridable ? ', or publish with an authorised override' : ''}`, {
        violations: issues.hard,
        overridable,
        canOverride: canOverridePublish(ctx),
      });
    }
    if (issues.soft.length && acknowledged !== issues.fingerprint) {
      throw planError(HttpStatus.CONFLICT, 'PLAN_WARNINGS_NOT_ACKNOWLEDGED', `Acknowledge the plan's ${issues.soft.length} warning(s) to publish${acknowledged ? ' (the warnings changed since you acknowledged them)' : ''}`, { warnings: issues.soft, fingerprint: issues.fingerprint });
    }

    const now = new Date();
    const next = plan.version + 1;
    const selectedIds = p.selected.map((a) => a.id);
    // The plan is closed (PUBLISHED, read-only) with its last unpublished route; until then it keeps its status.
    const status: RoutePlanStatus = p.remaining.length ? (plan.status as RoutePlanStatus) : 'PUBLISHED';
    const partial = !!selection || p.published.size > 0;
    const decision: RoutePlanPublishDecision = {
      acknowledged: issues.soft.length ? { fingerprint: issues.fingerprint!, count: issues.soft.length } : null,
      override: issues.hard.length && overrideReason !== null ? { reason: overrideReason, byUserId: ctx.userId, at: now.toISOString(), violations: issues.hard } : null,
    };
    const source: PublishSource = {
      ref: { routePlanId: plan.id, expectedVersion: dto.expectedVersion, ...(acknowledged !== null || overrideReason !== null ? { decision: decisionHash } : {}), ...(selection ? { assignmentIds: selection } : {}), ...(dto.reviewHash ? { reviewHash: dto.reviewHash } : {}) },
      // WP-B: under the plan row lock, before any change: the selected routes are still unpublished and the plan is still
      // at the version the caller reviewed. A concurrent publish of an overlapping selection that committed first makes
      // this one a clean 409 ROUTE_ALREADY_PUBLISHED (a disjoint one: PLAN_STALE), never a second trip for a route.
      lock: async (tx) => {
        await tx.$queryRaw`SELECT id FROM "RoutePlan" WHERE id = ${plan.id}::uuid FOR UPDATE`;
        if (await tx.transportTrip.count({ where: { routeAssignmentId: { in: selectedIds } } })) throw alreadyPublished('A selected route was published meanwhile; reload the plan');
        const cur = await tx.routePlan.findFirst({ where: { id: plan.id, companyId: ctx.companyId }, select: { version: true, status: true } });
        if (!cur || cur.version !== dto.expectedVersion || !EDITABLE.includes(cur.status)) throw stale(cur?.version ?? plan.version);
      },
      inTransaction: async (tx, result) => {
        await tx.$queryRaw`SELECT id FROM "RoutePlan" WHERE id = ${plan.id}::uuid FOR UPDATE`;
        const record: PublishRecord = { changeSetId: result.changeSetId, requestHash: decisionHash, assignmentIds: selectedIds, version: next, at: now.toISOString() };
        const base = (plan.options as Record<string, unknown> | null) ?? {};
        const options = { ...base, publishDecision: { ...decision, requestHash: decisionHash }, publishes: [...publishesOf(base), record] } as unknown as Prisma.InputJsonValue;
        const n = await tx.routePlan.updateMany({
          where: { id: plan.id, companyId: ctx.companyId, version: dto.expectedVersion, status: { in: [...EDITABLE] as RoutePlanStatus[] } },
          data: { status, ...(plan.publishedAt ? {} : { publishedAt: now }), version: { increment: 1 }, options },
        });
        if (!n.count) throw stale(plan.version);
        for (const [assignmentId, tempId] of cs.tempIds) {
          const trip = result.trips.find((t) => t.tempId === tempId);
          if (!trip) throw new Error(`publish: no trip for ${tempId}`);
          await tx.transportTrip.update({ where: { id: trip.id }, data: { routePlanId: plan.id, routeAssignmentId: assignmentId } });
        }
        await this.recordVersion(tx, ctx, plan, next, 'PUBLISHED', status, stops);
        const ack = decision.acknowledged ? { acknowledgedWarnings: { ...decision.acknowledged, kinds: [...new Set(issues.soft.map((i) => i.kind))] } } : {};
        const part = partial ? { partial: true, assignmentIds: selectedIds, remainingRoutes: p.remaining.length } : {};
        await this.audit.record(ctx, { action: 'UPDATE', entity: PLAN_ENTITY, entityId: plan.id, details: { published: true, changeSetId: result.changeSetId, trips: cs.tempIds.size, version: next, status, ...part, ...ack, ...(decision.override ? { override: true } : {}) } as Prisma.InputJsonValue }, tx);
        // The override's own audit row: the plan, the violations overridden and the reason (the actor is the row's user).
        if (decision.override) {
          await this.audit.record(ctx, { action: 'UPDATE', entity: PLAN_ENTITY, entityId: plan.id, details: { planId: plan.id, version: next, publishOverride: { reason: decision.override.reason, violations: decision.override.violations } } as unknown as Prisma.InputJsonValue }, tx);
        }
      },
    };
    let r: Replayable<ChangeSetResult>;
    try {
      r = await this.dispatch.publishPrepared(ctx, cs.input, key, source);
    } catch (e) {
      throw routeError(isRouteLinkTaken(e) ? alreadyPublished('A selected route was published meanwhile; reload the plan') : e, source.failedAt ?? 0, cs.opRoute, plan.assignments);
    }
    const trips = [...cs.tempIds].map(([assignmentId, tempId]) => {
      const t = r.value.trips.find((x) => x.tempId === tempId);
      return { assignmentId, transportTripId: t?.id ?? '', plannedTripId: t?.plannedTripId ?? null };
    });
    const version = r.replay ? ((await this.prisma.routePlan.findFirst({ where: { id: plan.id }, select: { version: true } }))?.version ?? next) : next;
    return { value: { planId: plan.id, version, trips, changeSetId: r.value.changeSetId, warnings: [...cs.warnings, ...r.value.warnings] }, replay: r.replay };
  }

  /**
   * A key already used for this company: the same caller's same request replays (from the ledger and the trip links of
   * this plan), whether the plan is PUBLISHED or (after a partial publish) still PLANNED; anything else is refused.
   */
  private async replayPublished(ctx: AuthContext, plan: PlanRow, ledger: { id: string; status: string; createdById: string | null; result: Prisma.JsonValue | null }, decisionHash: string): Promise<Replayable<RoutePlanPublishResult>> {
    const result = ledger.result as unknown as ChangeSetResult | null;
    const linked = new Map(plan.transportTrips.map((t) => [t.id, t]));
    const ours = ledger.status === 'PUBLISHED' && ledger.createdById === ctx.userId && !!result?.trips?.length && result.trips.every((t) => linked.has(t.id));
    if (!ours) throw idempotencyReused();
    // Decision 5 / WP-B: the same key with another acknowledgement / override / selection / review is another request.
    const record = publishesOf(plan.options).find((x) => x.changeSetId === ledger.id);
    const stored = record?.requestHash ?? (plan.options as { publishDecision?: { requestHash?: string } } | null)?.publishDecision?.requestHash;
    if (stored && stored !== decisionHash) throw idempotencyReused();
    return {
      value: {
        planId: plan.id,
        version: record?.version ?? plan.version,
        trips: result!.trips.map((t) => ({ assignmentId: linked.get(t.id)!.routeAssignmentId ?? '', transportTripId: t.id, plannedTripId: t.plannedTripId })),
        changeSetId: ledger.id,
        warnings: result!.warnings ?? [],
      },
      replay: true,
    };
  }

  /**
   * WP-B: everything a publish of `assignmentIds` (default: every unpublished route with stops) would check, computed
   * without writing: the selection (404 unknown route, 409 ROUTE_ALREADY_PUBLISHED, 400 a route without stops), branch
   * scope, the E3 change set and its pre-check errors, availability, the decision 5 classification and the review hash.
   * Shared by publish (which throws on what it finds) and review (which shows it).
   */
  private async preparePublish(ctx: AuthContext, plan: PlanRow, assignmentIds: string[] | undefined) {
    const stops = plan.stops.map(toRuleStop);
    const published = publishedRoutes(plan);
    const open = plan.assignments.filter((a) => !published.has(a.id) && routeStops(stops, a.id).length > 0);
    let selected = open;
    if (assignmentIds) {
      selected = assignmentIds.map((aid) => {
        const a = plan.assignments.find((x) => x.id === aid);
        if (!a) throw notFound('Route not found');
        return a;
      });
      if (selected.some((a) => published.has(a.id))) throw alreadyPublished();
      if (selected.some((a) => !routeStops(stops, a.id).length)) throw invalid('A selected route has no stops');
      selected = [...selected].sort((a, b) => a.seq - b.seq);
    }
    const selectedIds = new Set(selected.map((a) => a.id));
    const bookingIds = [...new Set(stops.flatMap((s) => (s.bookingId ? [s.bookingId] : [])))];
    const bookingRows = bookingIds.length ? await this.prisma.transportBooking.findMany({ where: { id: { in: bookingIds }, customerCompanyId: ctx.companyId }, include: { profile: { select: { branchId: true } } } }) : [];
    const bookings = new Map<string, PublishBooking>(bookingRows.map((b) => [b.id, b as unknown as PublishBooking]));
    const poiIds = [...new Set([...stops.flatMap((s) => (s.poiId ? [s.poiId] : [])), ...bookingRows.flatMap((b) => [b.pickupPoiId, b.dropPoiId].filter((x): x is string => !!x))])];
    const places = new Map<string, PublishPlace>((poiIds.length ? await this.prisma.poi.findMany({ where: { id: { in: poiIds }, companyId: ctx.companyId }, select: { id: true, name: true, lat: true, lng: true } }) : []).map((p) => [p.id, p]));
    const seatsOf = await this.currentSeats(ctx, plan);
    const consents = await activeRoutingConsents(this.prisma, bookingRows.map((b) => b.profileId));
    const availability = await this.availability(ctx, plan, selected, stops);

    // Branch scope first (a branch dispatcher's plan may still carry another branch's passenger or vehicle): 404-class.
    const scopeErrors: RoutePlanRouteError[] = [];
    for (const a of selected) {
      const list = routeStops(stops, a.id);
      if (a.objectId && !seatsOf.has(a.objectId) && !availability.inactiveVehicles.has(a.objectId)) scopeErrors.push({ assignmentId: a.id, vehicleLabel: a.vehicleLabel, code: 'NOT_FOUND', message: `The vehicle of route ${a.vehicleLabel} is not in your scope` });
      const foreign = list.some((s) => {
        const b = s.bookingId ? bookingRows.find((x) => x.id === s.bookingId) : undefined;
        return s.bookingId && (!b || !inProfileBranch(ctx, b.profile?.branchId));
      });
      if (foreign) scopeErrors.push({ assignmentId: a.id, vehicleLabel: a.vehicleLabel, code: 'NOT_FOUND', message: `Route ${a.vehicleLabel} carries a passenger outside your scope` });
    }
    const routes: PublishRoute[] = selected.map((a) => ({ id: a.id, seq: a.seq, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: a.driverId, startS: a.startS, endS: a.endS, seats: a.objectId ? (seatsOf.get(a.objectId) ?? null) : null }));
    const cs = buildPlanChangeSet(
      { id: plan.id, name: plan.name, planDate: plan.planDate, planStartAt: plan.planStartAt, direction: (plan.direction as TransportDirection | null) ?? null, shiftId: plan.shiftId, sitePoiId: plan.sitePoiId },
      routes,
      stops,
      bookings,
      places,
      consents,
    );
    const errors = [...scopeErrors, ...cs.errors, ...availability.errors];
    const ride = rideRuleOf(plan, await maxRidePolicyOf(this.prisma, ctx.companyId));
    const issues = publishIssues(routeCapacities({ assignments: selected }, seatsOf), stops, (b) => bookings.get(b)?.passengerCount, ride);
    const reviewHash = reviewHashOf({
      version: plan.version,
      routes: selected.map((a) => ({ id: a.id, objectId: a.objectId, driverId: a.driverId, stops: routeStops(stops, a.id).map((s) => ({ id: s.id, etaS: s.etaS })) })),
      fingerprint: issues.fingerprint,
    });
    return { stops, published, selected, remaining: open.filter((a) => !selectedIds.has(a.id)), bookings, seatsOf, cs, errors, availability, issues, reviewHash, ride };
  }

  /**
   * WP-B availability before publishing: for each route with stops, its vehicle / driver must be active, and no active
   * planned trip of either may overlap the route's span (routeSpan; the shared overlap rule of the E3 publish,
   * trip-overlap.ts). One query for the candidate trips of the whole plan. The E3 publish re-checks under its locks.
   */
  private async availability(ctx: AuthContext, plan: PlanRow, assignments: PlanRow['assignments'], stops: RuleStop[]): Promise<{ errors: RoutePlanRouteError[]; inactiveVehicles: Set<string> }> {
    const planStartMs = plan.planStartAt?.getTime() ?? null;
    const routes = assignments
      .filter((a) => routeStops(stops, a.id).length > 0)
      .map((a) => ({ id: a.id, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: a.driverId, span: routeSpan(planStartMs, a.startS, routeStops(stops, a.id)) }));
    const objectIds = [...new Set(routes.flatMap((r) => (r.objectId ? [r.objectId] : [])))];
    const driverIds = [...new Set(routes.flatMap((r) => (r.driverId ? [r.driverId] : [])))];
    if (!routes.length || (!objectIds.length && !driverIds.length)) return { errors: [], inactiveVehicles: new Set() };
    const spans = routes.flatMap((r) => (r.span ? [r.span] : []));
    const from = spans.length ? new Date(Math.min(...spans.map((s) => s.start.getTime()))) : null;
    const to = spans.length ? new Date(Math.max(...spans.map((s) => s.end.getTime()))) : null;
    const who: Prisma.PlannedTripWhereInput[] = [...(objectIds.length ? [{ objectId: { in: objectIds } }] : []), ...(driverIds.length ? [{ driverId: { in: driverIds } }] : [])];
    const [trips, vehicles, drivers] = await Promise.all([
      from && to ? this.prisma.plannedTrip.findMany({ where: { AND: [overlapWhere(from, to), { OR: who }] }, select: { id: true, objectId: true, driverId: true, status: true, plannedStart: true, plannedEnd: true, routeName: true } }) : Promise.resolve([]),
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds }, isActive: false }] }, select: { id: true, companyId: true } }) : Promise.resolve([]),
      driverIds.length ? this.prisma.driver.findMany({ where: { AND: [driverScopeWhere(ctx), { id: { in: driverIds }, isActive: false }] }, select: { id: true } }) : Promise.resolve([]),
    ]);
    const inactiveVehicles = new Set(vehicles.filter((v) => v.companyId === ctx.companyId).map((v) => v.id));
    const errors = availabilityErrors(routes, trips, { vehicles: inactiveVehicles, drivers: new Set(drivers.map((d) => d.id)) });
    return { errors, inactiveVehicles };
  }

  /**
   * WP-B GET /:id/review: what publishing the selected routes (default: every unpublished route with stops) would
   * create, for the confirmation step, and the `reviewHash` publish requires for a selection. Points and passenger names
   * follow the plan detail's rules (toPlanDetail: consent, branch, precision, "First L."); a read that returns them is
   * ACCESS-audited like the detail. No coordinates in the manual-change diff (ids only).
   */
  async review(ctx: AuthContext, id: string, q: ReviewQuery): Promise<RoutePlanReviewDto> {
    const plan = await this.find(ctx, id);
    if (!EDITABLE.includes(plan.status)) throw notEditable(plan.status);
    const ids = q.assignmentIds ? [...new Set(q.assignmentIds.split(',').map((s) => s.trim()).filter(Boolean))] : undefined;
    if (ids && (!ids.length || ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x)))) throw invalid('assignmentIds must be route ids');
    const p = await this.preparePublish(ctx, plan, ids);
    const view = await this.view(ctx, plan);
    const { dto } = toPlanDetail(plan, view, p.ride);
    const stopView = new Map(dto.stops.map((s) => [s.id, s]));
    const assignmentView = new Map(dto.assignments.map((a) => [a.id, a]));
    const locks = routePlanLocks(plan.options);
    // WP-B review: the review never shows more than the detail: profile ids exactly as the detail's stop view gives them
    // (a passenger's own stop only; never on a site / company-place stop or an anonymised one). The booking owner is
    // used only for the ACCESS audit of the names shown.
    const nameOwner = (s: RuleStop) => (s.bookingId ? (view.bookings.get(s.bookingId)?.profileId ?? null) : null);
    const shown = new Set<string>();
    const named = new Set<string>();
    const routes = p.selected.map((a) => {
      const av = assignmentView.get(a.id)!;
      return {
        assignmentId: a.id,
        seq: a.seq,
        vehicleLabel: a.vehicleLabel,
        objectId: a.objectId,
        vehicleName: av.vehicleName,
        plateNumber: av.plateNumber,
        driverId: a.driverId,
        driverName: av.driverName,
        seats: a.objectId ? (p.seatsOf.get(a.objectId) ?? null) : null,
        passengers: av.passengers,
        occupancy: av.seats,
        distanceM: a.distanceM,
        durationS: a.durationS,
        startS: a.startS,
        endS: a.endS,
        locked: locks.lockedAssignmentIds.has(a.id),
        stops: routeStops(p.stops, a.id).map((s, i) => {
          const v = stopView.get(s.id)!;
          const profileId = v.profileId ?? null;
          if (v.personal && v.lat !== null && profileId) shown.add(profileId);
          const owner = v.passengerName ? nameOwner(s) : null;
          if (owner) named.add(owner);
          return { stopId: s.id, ref: v.ref, sequence: i, stopKind: v.stopKind, bookingId: v.bookingId, profileId, poiId: v.poiId, name: v.name, lat: v.lat, lng: v.lng, pointHidden: v.pointHidden, passengerName: v.passengerName ?? null, etaS: s.etaS, plannedArrival: v.plannedArrival, seats: v.seats, pinned: v.pinned };
        }),
      };
    });
    // Passengers without a route (by booking; generic stops one by one), with the optimiser's / exclusion reason.
    const groups = new Map<string, RoutePlanReviewUnassigned>();
    for (const s of p.stops.filter((x) => !x.assignmentId)) {
      const v = stopView.get(s.id)!;
      const k = s.bookingId ?? `stop:${s.id}`;
      const g = groups.get(k) ?? { bookingId: v.bookingId, profileId: null, stopIds: [], reason: 'not_assigned' };
      g.stopIds.push(s.id);
      if (!g.profileId && v.profileId) g.profileId = v.profileId;
      if (v.unassignedReason && g.reason === 'not_assigned') g.reason = v.unassignedReason;
      groups.set(k, g);
    }
    const selectedIds = new Set(p.selected.map((a) => a.id));
    const otherRoutes = [...plan.assignments].sort((a, b) => a.seq - b.seq).filter((a) => !selectedIds.has(a.id)).map((a) => ({ assignmentId: a.id, vehicleLabel: a.vehicleLabel, published: p.published.has(a.id), stops: routeStops(p.stops, a.id).length }));
    // Manual changes since the last optimisation (else since the first version), from the version snapshots.
    const baseline =
      (await this.prisma.routePlanVersion.findFirst({ where: { planId: id, companyId: ctx.companyId, changeType: 'OPTIMIZED' }, orderBy: { version: 'desc' }, select: { version: true, changeType: true, snapshot: true } })) ??
      (await this.prisma.routePlanVersion.findFirst({ where: { planId: id, companyId: ctx.companyId }, orderBy: { version: 'asc' }, select: { version: true, changeType: true, snapshot: true } }));
    const current = plan.assignments.map((a) => ({ id: a.id, objectId: a.objectId, driverId: a.driverId, stopIds: routeStops(p.stops, a.id).map((s) => s.id) }));
    const changes = baseline ? manualChanges(snapshotRoutes(baseline.snapshot as unknown as RoutePlanVersionSnapshot), current) : [];
    const refs = new Map(dto.stops.map((s) => [s.id, s.ref]));
    const shownIssue = <T extends { stopId: string; ref: string }>(i: T): T => ({ ...i, ref: refs.get(i.stopId) ?? i.ref });
    await this.dispatch.recordPersonalAccess(ctx, 'plan', [...new Set([...shown, ...named])], dto.precise, { planId: id, review: true, ...(named.size ? { passengerNames: named.size } : {}) });
    return {
      planId: plan.id,
      version: plan.version,
      status: plan.status as RoutePlanStatus,
      planStartAt: plan.planStartAt?.toISOString() ?? null,
      assignmentIds: p.selected.map((a) => a.id),
      routes,
      unassigned: [...groups.values()],
      otherRoutes,
      manualChanges: { baselineVersion: baseline?.version ?? null, baselineChangeType: baseline?.changeType ?? null, routes: changes },
      publishCheck: { hard: p.issues.hard.map(shownIssue), soft: p.issues.soft.map(shownIssue), fingerprint: p.issues.fingerprint, canOverride: canOverridePublish(ctx), routeErrors: p.availability.errors },
      errors: p.errors,
      reviewHash: p.reviewHash,
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async find(ctx: AuthContext, id: string): Promise<PlanRow> {
    const plan = await this.prisma.routePlan.findFirst({ where: { AND: [this.planWhere(ctx), { id }] }, include: PLAN_INCLUDE });
    if (!plan) throw notFound('Plan not found');
    return plan;
  }

  /** Booking seats / owners / labels / branches of the stops, consents of the owners, vehicle and driver names. */
  private async view(ctx: AuthContext, plan: PlanRow): Promise<PlanPointView> {
    const bookings = await this.bookingSeats(plan.stops);
    const owners = personalOwners(plan.stops, bookings);
    const ownerBranch = new Map<string, string | null>([...bookings.values()].map((b) => [b.profileId, b.branchId] as const));
    const missing = owners.filter((o) => !ownerBranch.has(o));
    if (missing.length) for (const p of await this.prisma.employeeTransportProfile.findMany({ where: { id: { in: missing } }, select: { id: true, branchId: true } })) ownerBranch.set(p.id, p.branchId);
    const consents = await activeRoutingConsents(this.prisma, owners);
    const objectIds = [...new Set(plan.assignments.flatMap((a) => (a.objectId ? [a.objectId] : [])))];
    const driverIds = [...new Set(plan.assignments.flatMap((a) => (a.driverId ? [a.driverId] : [])))];
    const [objects, drivers] = await Promise.all([
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { id: { in: objectIds }, companyId: ctx.companyId }, select: { id: true, name: true, plateNumber: true } }) : [],
      driverIds.length ? this.prisma.driver.findMany({ where: { id: { in: driverIds }, companyId: ctx.companyId }, select: { id: true, name: true } }) : [],
    ]);
    return {
      precise: preciseFor(ctx, ctx.companyId),
      consents,
      bookings,
      ownerBranch,
      inBranch: (b) => inProfileBranch(ctx, b),
      // Names: callers who may see passengers on dispatch / bookings / the passenger list (as the E3 board shows them).
      showNames: can(ctx.permissions, 'etms_dispatch', 'view') || can(ctx.permissions, 'etms_bookings', 'view') || can(ctx.permissions, 'etms_passengers', 'view'),
      names: { vehicles: new Map(objects.map((o) => [o.id, { name: o.name, plateNumber: o.plateNumber }])), drivers: new Map(drivers.map((d) => [d.id, d.name])) },
    };
  }

  private async bookingSeats(stops: { bookingId: string | null }[]): Promise<Map<string, ViewBooking>> {
    const ids = [...new Set(stops.flatMap((s) => (s.bookingId ? [s.bookingId] : [])))];
    if (!ids.length) return new Map();
    const rows = await this.prisma.transportBooking.findMany({ where: { id: { in: ids } }, select: { id: true, passengerCount: true, profileId: true, pickupLabel: true, dropLabel: true, profile: { select: { branchId: true, displayName: true } } } });
    return new Map(rows.map((b) => [b.id, { id: b.id, passengerCount: b.passengerCount, profileId: b.profileId, pickupLabel: b.pickupLabel, dropLabel: b.dropLabel, branchId: b.profile?.branchId ?? null, displayName: b.profile?.displayName ?? null }]));
  }

  private async recordVersion(tx: Prisma.TransactionClient, ctx: AuthContext, plan: Pick<PlanRow, 'id' | 'companyId' | 'assignments'>, version: number, changeType: RoutePlanChangeType, status: RoutePlanStatus, stops: RuleStop[]): Promise<void> {
    const snapshot = planSnapshot(status, plan.assignments, stops);
    await tx.routePlanVersion.create({ data: { planId: plan.id, companyId: plan.companyId, version, changeType, snapshot: snapshot as unknown as Prisma.InputJsonValue, changedById: ctx.userId } });
  }
}

/**
 * An E3 publish error, with the route of the change that failed (`routes`, as the pre-checks give them). Status and
 * code stay the E3 ones (VEHICLE_BUSY, CAPACITY_EXCEEDED, CONSENT_REQUIRED, …).
 */
export function routeError(e: unknown, failedAt: number, opRoute: (string | null)[], assignments: { id: string; vehicleLabel: string }[]): unknown {
  if (!(e instanceof HttpException)) return e;
  const routeId = failedAt > 0 ? opRoute[failedAt] : null;
  const a = routeId ? assignments.find((x) => x.id === routeId) : undefined;
  if (!a) return e;
  const body = e.getResponse();
  const res = (typeof body === 'object' && body ? body : { message: String(body) }) as { message?: string; code?: string };
  const message = `Route ${a.vehicleLabel}: ${res.message ?? 'refused'}`;
  return new HttpException({ ...res, message, routes: [{ assignmentId: a.id, vehicleLabel: a.vehicleLabel, code: res.code ?? `HTTP_${e.getStatus()}`, message }] }, e.getStatus());
}

// ───────────────────────────── publish gate helpers (owner decision 5) ─────────────────────────────

/**
 * Who may override overridable hard publish issues (arrival windows): the existing grant model, no new grant — a
 * whole-company role (dataScope COMPANY, e.g. the Transport admin template) holding both publish grants (Route
 * planning: command and Dispatch: command). Branch dispatchers (ASSIGNED) publish, but never override.
 */
export function canOverridePublish(ctx: Pick<AuthContext, 'dataScope' | 'permissions'>): boolean {
  return ctx.dataScope === 'COMPANY' && can(ctx.permissions, 'etms_dispatch', 'command') && can(ctx.permissions, 'etms_planning', 'command');
}

/** D-M1: the max-ride check of a plan: its effective max ride (effectiveMaxRideS) and its direction. */
const rideRuleOf = (plan: Pick<PlanRow, 'options' | 'direction'>, policyS: number | null): RideRule => ({ maxRideS: effectiveMaxRideS(plan.options, policyS), direction: (plan.direction as TransportDirection | null) ?? null });

const normaliseReason = overrideReasonText;

/** A reason worth recording: the shared override rule (meaningfulOverrideReason; D-L4: the max-ride override uses it too). */
export function meaningfulReason(reason: string): boolean {
  return meaningfulOverrideReason(reason);
}

/** The plan detail's publishCheck: the publish classification with the refs as this caller sees them. */
/** The routes as the publish gate checks them: a route's capacity is its vehicle's seats now (null without a vehicle in scope). */
function routeCapacities(plan: Pick<PlanRow, 'assignments'>, seatsOf: Map<string, number | null>): { id: string; vehicleLabel: string; capacity: number | null }[] {
  return plan.assignments.map((a) => ({ id: a.id, vehicleLabel: a.vehicleLabel, capacity: a.objectId ? (seatsOf.get(a.objectId) ?? null) : null }));
}

function publishCheckFor(ctx: AuthContext, routes: { id: string; vehicleLabel: string; capacity: number | null }[], plan: PlanRow, dto: RoutePlanDetailDto, seats: (bookingId: string) => number | undefined, ride: RideRule): RoutePlanPublishCheck {
  const refs = new Map(dto.stops.map((s) => [s.id, s.ref]));
  const r = publishIssues(routes, plan.stops.map(toRuleStop), seats, ride);
  const shown = <T extends { stopId: string; ref: string }>(i: T): T => ({ ...i, ref: refs.get(i.stopId) ?? i.ref });
  return { hard: r.hard.map(shown), soft: r.soft.map(shown), fingerprint: r.fingerprint, canOverride: canOverridePublish(ctx) };
}

/**
 * E4 decisions review D-L2: the stored decision with each overridden violation's ref replaced by the ref this caller's
 * detail shows for that stop (another branch's stop: its anonymised `stop-…` ref, never the stored `d-<booking id>`);
 * a stop no longer on the plan gets an anonymised ref too. `byUserId` stays: it is the PUBLISHED version's
 * `changedById`, which the plan history already shows every viewer of the plan.
 */
export function publishDecisionShown(d: RoutePlanPublishDecision | null, dto: Pick<RoutePlanDetailDto, 'stops'>): RoutePlanPublishDecision | null {
  if (!d?.override) return d;
  const refs = new Map(dto.stops.map((s) => [s.id, s.ref]));
  const violations = (Array.isArray(d.override.violations) ? d.override.violations : []).map((v) => ({ ...v, ref: refs.get(v.stopId) ?? `stop-${String(v.stopId).slice(0, 8)}` }));
  return { ...d, override: { ...d.override, violations } };
}

/** WP-B last line of defence: TransportTrip.routeAssignmentId UNIQUE refused a second trip for one route. */
function isRouteLinkTaken(e: unknown): boolean {
  return isUniqueViolation(e, 'routeAssignmentId');
}

/**
 * Pin / unpin stops (one stop, or both ends of a booking): RoutePlan.options.pinnedStopIds; nothing re-timed. A stop
 * of a published route cannot be (un)pinned: the route is immutable (WP-B).
 */
function pinEdit(plan: PlanRow, stops: PlanRow['stops'], pinnedNow: boolean, details: Record<string, unknown>): PlanEdit {
  const published = publishedRoutes(plan);
  if (stops.some((s) => s.assignmentId && published.has(s.assignmentId))) throw alreadyPublished();
  const pinned = new Set(routePlanLocks(plan.options).pinnedStopIds);
  for (const s of stops) {
    if (pinnedNow) pinned.add(s.id);
    else pinned.delete(s.id);
  }
  return {
    placements: new Map(),
    options: { ...(plan.options as object), pinnedStopIds: [...pinned] } as Prisma.InputJsonValue,
    retime: new Set(),
    checked: new Set(),
    changeType: 'EDITED',
    details,
  };
}

/** RoutePlan.options.publishDecision as the detail shows it (without the request hash). */
export function publishDecisionOf(options: unknown): RoutePlanPublishDecision | null {
  const d = (options as { publishDecision?: RoutePlanPublishDecision & { requestHash?: string } } | null)?.publishDecision;
  if (!d || typeof d !== 'object') return null;
  return { acknowledged: d.acknowledged ?? null, override: d.override ?? null };
}
