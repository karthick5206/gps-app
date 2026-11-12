import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  can,
  ROUTE_PLAN_COMPARE_MAX,
  ROUTE_PLAN_EDITABLE,
  ROUTE_PLAN_OVERRIDE_REASON_MIN,
  routePlanLocks,
  uncalibratedEta,
  type ChangeSetResult,
  type LatLng,
  type RoutePlanChangeType,
  type RoutePlanCompareDto,
  type RoutePlanDetailDto,
  type RoutePlanEditResult,
  type RoutePlanPublishCheck,
  type RoutePlanPublishDecision,
  type RoutePlanPublishResult,
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
import { DispatchService, type PublishSource } from '../dispatch/dispatch.service';
import { idempotencyKey, idempotencyReused, inProfileBranch, invalid, notFound, requestHash } from '../dispatch/e3-common';
import { preciseFor } from '../dispatch/e3-mapping';
import type { Replayable } from '../dispatch/bookings.service';
import { activeRoutingConsents } from '../people/people.service';
import { buildPlanChangeSet, pairProblem, pinnedStopsMoved, planMetrics, publishIssues, retime, routeStops, routeViolations, type PublishBooking, type RideRule, type PublishPlace, type PublishRoute, type RuleStop } from './plan-rules';
import { PLAN_INCLUDE, outOfScope, personalOwners, planSnapshot, seatsLookup, toPlanDetail, toPlanSummary, toRuleStop, type PlanPointView, type PlanRow, type ViewBooking } from './plan-view';
import type { AssignmentUpdateDto, DiscardDto, MovePassengerDto, PlanListQuery, PublishDto, ResequenceDto, StopUpdateDto } from './plans.dto';

export const PLAN_ENTITY = 'RoutePlan';
const EDITABLE = ROUTE_PLAN_EDITABLE as readonly string[];

const planError = (status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}) => new HttpException({ message, code, ...extra }, status);
const stale = (currentVersion: number) => planError(HttpStatus.CONFLICT, 'PLAN_STALE', 'The plan was changed meanwhile; reload it', { currentVersion });
const notEditable = (status: string) => planError(HttpStatus.CONFLICT, 'PLAN_NOT_EDITABLE', `A ${status} plan cannot be changed`);

/** In-memory edit of a plan: new stop placements, assignment changes and options; the routes whose order changed. */
interface PlanEdit {
  /** stop id → new { assignmentId, sequence } (only stops that moved / were renumbered). */
  placements: Map<string, { assignmentId: string | null; sequence: number | null }>;
  assignments?: Map<string, Prisma.RouteAssignmentUncheckedUpdateInput>;
  options?: Prisma.InputJsonValue;
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
    const capacities = dto.editable ? routeCapacities(plan, await this.currentSeats(ctx, plan)) : [];
    dto.publishCheck = dto.editable ? publishCheckFor(ctx, capacities, plan, dto, seatsLookup(view.bookings), ride) : null;
    dto.publishDecision = publishDecisionOf(plan.options);
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
        return planMetrics({ id: p.id, name: p.name, planDate: p.planDate, status: p.status as RoutePlanStatus, version: p.version, graphVersion: p.graphVersion, assignments: p.assignments, stops: p.stops.map(toRuleStop) }, seats);
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
      const locks = routePlanLocks(plan.options);
      const pinned = new Set(locks.pinnedStopIds);
      if (dto.pinned) pinned.add(s.id);
      else pinned.delete(s.id);
      return {
        placements: new Map(),
        options: { ...(plan.options as object), pinnedStopIds: [...pinned] } as Prisma.InputJsonValue,
        retime: new Set(),
        checked: new Set(),
        changeType: 'EDITED',
        details: { change: 'pin', stopId: s.id, pinned: dto.pinned },
      };
    });
  }

  /** DRAFT / PLANNED → CANCELLED (history kept; nothing deleted; no trip is touched). */
  async discard(ctx: AuthContext, id: string, dto: DiscardDto): Promise<RoutePlanDetailDto> {
    const plan = await this.find(ctx, id);
    if (!EDITABLE.includes(plan.status)) throw notEditable(plan.status);
    if (plan.version !== dto.expectedVersion) throw stale(plan.version);
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.routePlan.updateMany({ where: { id, companyId: ctx.companyId, version: dto.expectedVersion, status: { in: [...EDITABLE] as RoutePlanStatus[] } }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      if (!n.count) throw stale(plan.version);
      await this.recordVersion(tx, ctx, plan, plan.version + 1, 'CANCELLED', 'CANCELLED', plan.stops.map(toRuleStop));
      await this.audit.record(ctx, { action: 'DELETE', entity: PLAN_ENTITY, entityId: id, details: { discarded: true, from: plan.status, version: plan.version + 1, ...(dto.reason ? { reason: dto.reason } : {}) } }, tx);
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
    const stops = plan.stops.map(toRuleStop).map((s) => (e.placements.has(s.id) ? { ...s, ...e.placements.get(s.id)! } : s));
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
   * becomes PUBLISHED (version compare-and-set) and each TransportTrip gets routePlanId / routeAssignmentId. Any failure
   * rolls back every route; the error names the route that failed.
   *
   * States (QA B3 decision): a successful optimisation leaves the plan PLANNED; manual edits keep its status (a PLANNED
   * plan stays PLANNED and editable). A never-optimised DRAFT plan may also be published (a dispatcher may build a plan
   * by hand), but only when every route passes the same per-route validation as a PLANNED one (scope, seats, consent,
   * pickup before drop, bookings still open); otherwise 409 PLAN_NOT_PUBLISHABLE and nothing is written.
   */
  async publish(ctx: AuthContext, id: string, dto: PublishDto, headerKey: string | undefined): Promise<Replayable<RoutePlanPublishResult>> {
    // Publishing makes dispatch trips: the caller needs the dispatcher's publish grant too (like a change set).
    if (!can(ctx.permissions, 'etms_dispatch', 'command')) throw new ForbiddenException({ message: 'Publishing a plan needs Dispatch: command', code: 'FORBIDDEN_GRANT' });
    const key = idempotencyKey(headerKey ?? dto.idempotencyKey);
    const plan = await this.find(ctx, id);
    // Decision 5: the acknowledgement / override fields are part of the request (bound into the idempotency hash).
    const overrideReason = dto.override ? normaliseReason(dto.override.reason) : null;
    const acknowledged = dto.acknowledgedWarnings ?? null;
    const decisionHash = requestHash({ acknowledgedWarnings: acknowledged, override: overrideReason });
    if (plan.status === 'PUBLISHED') return this.replayPublished(ctx, plan, key, decisionHash);
    if (!EDITABLE.includes(plan.status)) throw notEditable(plan.status);
    if (plan.version !== dto.expectedVersion) throw stale(plan.version);
    if (overrideReason !== null) {
      if (!canOverridePublish(ctx)) throw new ForbiddenException({ message: 'Overriding the publish checks needs a whole-company role with Dispatch: command and Route planning: command', code: 'PUBLISH_OVERRIDE_FORBIDDEN' });
      if (!meaningfulReason(overrideReason)) throw planError(HttpStatus.BAD_REQUEST, 'PUBLISH_OVERRIDE_REASON_REQUIRED', `Give a reason of at least ${ROUTE_PLAN_OVERRIDE_REASON_MIN} characters (two words or more) for the override`);
    }

    const stops = plan.stops.map(toRuleStop);
    const bookingIds = [...new Set(stops.flatMap((s) => (s.bookingId ? [s.bookingId] : [])))];
    const bookingRows = bookingIds.length ? await this.prisma.transportBooking.findMany({ where: { id: { in: bookingIds }, customerCompanyId: ctx.companyId }, include: { profile: { select: { branchId: true } } } }) : [];
    const bookings = new Map<string, PublishBooking>(bookingRows.map((b) => [b.id, b as unknown as PublishBooking]));
    const poiIds = [...new Set([...stops.flatMap((s) => (s.poiId ? [s.poiId] : [])), ...bookingRows.flatMap((b) => [b.pickupPoiId, b.dropPoiId].filter((x): x is string => !!x))])];
    const places = new Map<string, PublishPlace>((poiIds.length ? await this.prisma.poi.findMany({ where: { id: { in: poiIds }, companyId: ctx.companyId }, select: { id: true, name: true, lat: true, lng: true } }) : []).map((p) => [p.id, p]));
    const seatsOf = await this.currentSeats(ctx, plan);
    const consents = await activeRoutingConsents(this.prisma, bookingRows.map((b) => b.profileId));

    // Branch scope first (a branch dispatcher's plan may still carry another branch's passenger or vehicle): 404-class.
    const scopeErrors: RoutePlanRouteError[] = [];
    for (const a of plan.assignments) {
      const list = routeStops(stops, a.id);
      if (!list.length) continue;
      if (a.objectId && !seatsOf.has(a.objectId)) scopeErrors.push({ assignmentId: a.id, vehicleLabel: a.vehicleLabel, code: 'NOT_FOUND', message: `The vehicle of route ${a.vehicleLabel} is not in your scope` });
      const foreign = list.some((s) => {
        const b = s.bookingId ? bookingRows.find((x) => x.id === s.bookingId) : undefined;
        return s.bookingId && (!b || !inProfileBranch(ctx, b.profile?.branchId));
      });
      if (foreign) scopeErrors.push({ assignmentId: a.id, vehicleLabel: a.vehicleLabel, code: 'NOT_FOUND', message: `Route ${a.vehicleLabel} carries a passenger outside your scope` });
    }
    const routes: PublishRoute[] = plan.assignments.map((a) => ({ id: a.id, seq: a.seq, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: a.driverId, startS: a.startS, endS: a.endS, seats: a.objectId ? (seatsOf.get(a.objectId) ?? null) : null }));
    const cs = buildPlanChangeSet(
      { id: plan.id, name: plan.name, planDate: plan.planDate, planStartAt: plan.planStartAt, direction: (plan.direction as TransportDirection | null) ?? null, shiftId: plan.shiftId, sitePoiId: plan.sitePoiId },
      routes,
      stops,
      bookings,
      places,
      consents,
    );
    const errors = [...scopeErrors, ...cs.errors];
    if (errors.length) throw planError(HttpStatus.CONFLICT, 'PLAN_NOT_PUBLISHABLE', `The plan cannot be published: ${errors[0].message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`, { routes: errors });

    // Decision 5, recomputed from the stored plan with the vehicles' current seats: hard issues block (only arrival
    // windows may be overridden, by an authorised caller with a reason); soft warnings need this exact set acknowledged.
    const ride = rideRuleOf(plan, await maxRidePolicyOf(this.prisma, ctx.companyId));
    const issues = publishIssues(routeCapacities(plan, seatsOf), stops, (b) => bookings.get(b)?.passengerCount, ride);
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
    const decision: RoutePlanPublishDecision = {
      acknowledged: issues.soft.length ? { fingerprint: issues.fingerprint!, count: issues.soft.length } : null,
      override: issues.hard.length && overrideReason !== null ? { reason: overrideReason, byUserId: ctx.userId, at: now.toISOString(), violations: issues.hard } : null,
    };
    const options = { ...((plan.options as Record<string, unknown> | null) ?? {}), publishDecision: { ...decision, requestHash: decisionHash } } as unknown as Prisma.InputJsonValue;
    const source: PublishSource = {
      ref: { routePlanId: plan.id, expectedVersion: dto.expectedVersion, ...(acknowledged !== null || overrideReason !== null ? { decision: decisionHash } : {}) },
      inTransaction: async (tx, result) => {
        await tx.$queryRaw`SELECT id FROM "RoutePlan" WHERE id = ${plan.id}::uuid FOR UPDATE`;
        const n = await tx.routePlan.updateMany({
          where: { id: plan.id, companyId: ctx.companyId, version: dto.expectedVersion, status: { in: [...EDITABLE] as RoutePlanStatus[] } },
          data: { status: 'PUBLISHED', publishedAt: now, version: { increment: 1 }, options },
        });
        if (!n.count) throw stale(plan.version);
        for (const [assignmentId, tempId] of cs.tempIds) {
          const trip = result.trips.find((t) => t.tempId === tempId);
          if (!trip) throw new Error(`publish: no trip for ${tempId}`);
          await tx.transportTrip.update({ where: { id: trip.id }, data: { routePlanId: plan.id, routeAssignmentId: assignmentId } });
        }
        await this.recordVersion(tx, ctx, plan, next, 'PUBLISHED', 'PUBLISHED', stops);
        const ack = decision.acknowledged ? { acknowledgedWarnings: { ...decision.acknowledged, kinds: [...new Set(issues.soft.map((i) => i.kind))] } } : {};
        await this.audit.record(ctx, { action: 'UPDATE', entity: PLAN_ENTITY, entityId: plan.id, details: { published: true, changeSetId: result.changeSetId, trips: cs.tempIds.size, version: next, ...ack, ...(decision.override ? { override: true } : {}) } as Prisma.InputJsonValue }, tx);
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
      throw routeError(e, source.failedAt ?? 0, cs.opRoute, plan.assignments);
    }
    const trips = [...cs.tempIds].map(([assignmentId, tempId]) => {
      const t = r.value.trips.find((x) => x.tempId === tempId);
      return { assignmentId, transportTripId: t?.id ?? '', plannedTripId: t?.plannedTripId ?? null };
    });
    const version = r.replay ? ((await this.prisma.routePlan.findFirst({ where: { id: plan.id }, select: { version: true } }))?.version ?? next) : next;
    return { value: { planId: plan.id, version, trips, changeSetId: r.value.changeSetId, warnings: [...cs.warnings, ...r.value.warnings] }, replay: r.replay };
  }

  /** A PUBLISHED plan: the same caller's same key replays (from the ledger and the trip links); anything else is refused. */
  private async replayPublished(ctx: AuthContext, plan: PlanRow, key: string, decisionHash: string): Promise<Replayable<RoutePlanPublishResult>> {
    const ledger = await this.prisma.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key } });
    if (!ledger) throw notEditable(plan.status);
    const result = ledger.result as unknown as ChangeSetResult | null;
    const linked = new Map(plan.transportTrips.map((t) => [t.id, t]));
    const ours = ledger.status === 'PUBLISHED' && ledger.createdById === ctx.userId && !!result?.trips?.length && result.trips.every((t) => linked.has(t.id));
    if (!ours) throw idempotencyReused();
    // Decision 5: the same key with another acknowledgement / override is another request.
    const stored = (plan.options as { publishDecision?: { requestHash?: string } } | null)?.publishDecision?.requestHash;
    if (stored && stored !== decisionHash) throw idempotencyReused();
    return {
      value: {
        planId: plan.id,
        version: plan.version,
        trips: result!.trips.map((t) => ({ assignmentId: linked.get(t.id)!.routeAssignmentId ?? '', transportTripId: t.id, plannedTripId: t.plannedTripId })),
        changeSetId: ledger.id,
        warnings: result!.warnings ?? [],
      },
      replay: true,
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

const normaliseReason = (raw: unknown): string => (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();

/** A reason worth recording: at least ROUTE_PLAN_OVERRIDE_REASON_MIN characters and two words (letters, with their combining marks: Hindi / Tamil). */
export function meaningfulReason(reason: string): boolean {
  return reason.length >= ROUTE_PLAN_OVERRIDE_REASON_MIN && (reason.match(/\p{L}[\p{L}\p{M}]+/gu) ?? []).length >= 2;
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

/** RoutePlan.options.publishDecision as the detail shows it (without the request hash). */
export function publishDecisionOf(options: unknown): RoutePlanPublishDecision | null {
  const d = (options as { publishDecision?: RoutePlanPublishDecision & { requestHash?: string } } | null)?.publishDecision;
  if (!d || typeof d !== 'object') return null;
  return { acknowledged: d.acknowledged ?? null, override: d.override ?? null };
}
