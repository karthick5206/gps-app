import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ACTIVE_BOOKING_STATUSES, ROUTE_PLAN_EDITABLE, ROUTING_LIMITS, RoutePlanStatus, RoutePlanVersionSnapshot, RoutingProfile, uncalibratedEta } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { activeRoutingConsents } from '../etms/people/people.service';
import type { JobRecord, StoreTx } from './job-store';
import { JobError } from './job-worker';
import type { BuiltMatrix } from './matrix-port';
import type { PlanInputs, PlanStopInput, PlanWrite, SolverWeights } from './optimize-problem';
import type { OptimizeJobInput, PlanGateway } from './optimize-runner';
import { RoutingHttpError } from './routing-flags';
import type { PlanJobLink } from './routing-jobs.service';

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

/** Reasons a stop is left out before solving (stored in `RoutePlanStop.unassignedReason`). */
export const EXCLUDED_REASONS = { consent: 'consent_withdrawn', booking: 'booking_not_active', location: 'needs_location' } as const;

function windowsOf(raw: Prisma.JsonValue | null): [number, number][] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((w): w is [number, number] => Array.isArray(w) && w.length === 2 && w.every((x) => typeof x === 'number' && Number.isFinite(x)));
  return out.length ? out.map(([a, b]) => [a, b]) : null;
}

function pointOf(raw: Prisma.JsonValue | null): { lat: number; lng: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { lat, lng } = raw as { lat?: unknown; lng?: unknown };
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

const optionsOf = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

/** RoutePlan.options.weights when complete and valid (all four finite, ≥ 0, one of distance / time / routeDuration > 0). */
export function weightsOf(raw: unknown): SolverWeights | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  const keys = ['vehicle', 'distance', 'time', 'routeDuration'] as const;
  if (!keys.every((k) => typeof w[k] === 'number' && Number.isFinite(w[k]) && (w[k] as number) >= 0)) return undefined;
  const out = Object.fromEntries(keys.map((k) => [k, w[k] as number])) as unknown as SolverWeights;
  return out.distance || out.time || out.routeDuration ? out : undefined;
}

/**
 * Lock / pin sets of `RoutePlan.options` (same keys and rules as shared `routePlanLocks` on etms/e4-plans; switch to
 * that helper when the plans branch is merged).
 */
export function planLocks(options: unknown): { lockedAssignmentIds: Set<string>; pinnedStopIds: Set<string> } {
  const o = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
  const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { lockedAssignmentIds: ids(o.lockedAssignmentIds), pinnedStopIds: ids(o.pinnedStopIds) };
}

/** Plan visible to the caller: own company; branch-scoped users only their branches' plans (and branch-less ones). */
export function planVisibleTo(ctx: Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'userId'>, plan: { companyId: string; branchId: string | null; createdById?: string | null }): boolean {
  // Same rule as RoutePlansService.planWhere: own company; ASSIGNED roles their branches' plans and branch-less plans they made.
  if (plan.companyId !== ctx.companyId) return false;
  if (ctx.dataScope === 'COMPANY') return true;
  return plan.branchId ? ctx.branchIds.includes(plan.branchId) : plan.createdById === ctx.userId;
}

/**
 * Prisma side of the optimise job: plan reservation (API), input loading and the DRAFT result write (worker).
 * Privacy (doc 10 §4, doc 17 R2): personal points are used only with active routing consent, read at run time; job
 * input / result and the plan version snapshot never hold coordinates or names; nothing here logs a coordinate.
 */
export class PrismaPlanGateway implements PlanGateway, PlanJobLink {
  private readonly logger = new Logger('RoutingPlanGateway');

  constructor(private readonly db: Db) {}

  // ───────────── API side (PlanJobLink) ─────────────

  async reserve(tx: StoreTx, ctx: AuthContext, planId: string, expectedVersion: number, weights?: SolverWeights): Promise<{ profile: RoutingProfile }> {
    const t = tx as Tx;
    const plan = await t.routePlan.findFirst({ where: { id: planId, companyId: ctx.companyId }, select: { id: true, companyId: true, branchId: true, createdById: true, status: true, version: true, profile: true, options: true } });
    if (!plan || !planVisibleTo(ctx, plan)) throw new RoutingHttpError('JOB_NOT_FOUND', 'Plan not found');
    if (plan.version !== expectedVersion) throw new RoutingHttpError('PLAN_STALE', 'The plan changed meanwhile; reload it and try again', { currentVersion: plan.version });
    if (plan.status === 'OPTIMIZING') throw new RoutingHttpError('PLAN_NOT_EDITABLE', 'An optimisation is already running for this plan');
    if (!(ROUTE_PLAN_EDITABLE as readonly string[]).includes(plan.status)) throw new RoutingHttpError('PLAN_NOT_EDITABLE', `A ${plan.status.toLowerCase()} plan cannot be optimised`);
    const [stops, vehicles] = await Promise.all([t.routePlanStop.count({ where: { planId } }), t.routeAssignment.count({ where: { planId } })]);
    if (!vehicles) throw new RoutingHttpError('LIMIT_EXCEEDED', 'Add at least one vehicle to the plan before optimising');
    if (vehicles > ROUTING_LIMITS.optimizeVehicles) throw new RoutingHttpError('LIMIT_EXCEEDED', `At most ${ROUTING_LIMITS.optimizeVehicles} vehicles per optimisation`);
    if (stops > ROUTING_LIMITS.optimizeStops) throw new RoutingHttpError('LIMIT_EXCEEDED', `At most ${ROUTING_LIMITS.optimizeStops} stops per optimisation`);
    const moved = await t.routePlan.updateMany({ where: { id: planId, companyId: ctx.companyId, version: expectedVersion, status: plan.status }, data: { status: 'OPTIMIZING', ...(weights ? { options: { ...optionsOf(plan.options), weights: { ...weights } } as Prisma.InputJsonValue } : {}) } });
    if (!moved.count) throw new RoutingHttpError('PLAN_STALE', 'The plan changed meanwhile; reload it and try again');
    return { profile: (plan.profile as RoutingProfile) ?? 'car' };
  }

  async release(job: Pick<JobRecord, 'companyId' | 'planId'>): Promise<void> {
    if (!job.planId) return;
    // Only when no other job of the plan is still active (one per plan by construction; defensive).
    const active = await this.db.routingJob.count({ where: { planId: job.planId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (active) return;
    await this.db.routePlan.updateMany({ where: { id: job.planId, companyId: job.companyId, status: 'OPTIMIZING' }, data: { status: 'DRAFT' } });
  }

  async visible(ctx: AuthContext, planId: string): Promise<boolean> {
    const plan = await this.db.routePlan.findFirst({ where: { id: planId, companyId: ctx.companyId }, select: { companyId: true, branchId: true, createdById: true } });
    // A plan purged by retention: its finished jobs stay readable to whole-company users only.
    return plan ? planVisibleTo(ctx, plan) : ctx.dataScope === 'COMPANY';
  }

  // ───────────── worker side (PlanGateway) ─────────────

  async load(job: JobRecord, input: OptimizeJobInput): Promise<PlanInputs> {
    const plan = await this.db.routePlan.findFirst({
      where: { id: input.planId, companyId: job.companyId },
      include: { stops: { orderBy: { ref: 'asc' } }, assignments: { orderBy: { seq: 'asc' } }, sitePoi: { select: { lat: true, lng: true } } },
    });
    if (!plan) throw new JobError('PLAN_STALE', 'The plan no longer exists');
    if (plan.version !== input.planVersion || plan.status !== 'OPTIMIZING') throw new JobError('PLAN_STALE', 'The plan changed while the optimisation was queued; nothing was written');

    const bookingIds = [...new Set(plan.stops.map((s) => s.bookingId).filter((b): b is string => !!b))];
    const bookings = new Map(
      (bookingIds.length
        ? await this.db.transportBooking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, profileId: true, status: true, passengerCount: true, windowStart: true, windowEnd: true } })
        : []
      ).map((b) => [b.id, b]),
    );
    const ownerOf = (s: (typeof plan.stops)[number]) => s.profileId ?? (s.bookingId && !s.poiId ? (bookings.get(s.bookingId)?.profileId ?? null) : null);
    const owners = [...new Set(plan.stops.map(ownerOf).filter((p): p is string => !!p))];
    const consenting = owners.length ? await activeRoutingConsents(this.db, owners) : new Set<string>();
    const seats = new Map(
      (await this.db.transportVehicleProfile.findMany({ where: { objectId: { in: plan.assignments.map((a) => a.objectId).filter((o): o is string => !!o) } }, select: { objectId: true, seats: true, wheelchairSpaces: true, category: true } })).map((v) => [
        v.objectId,
        v,
      ]),
    );
    const startMs = plan.planStartAt?.getTime() ?? null;
    const rel = (d: Date) => Math.max(0, Math.round((d.getTime() - (startMs as number)) / 1000));

    // Locks and pins (RoutePlan.options, written by the plans API): a locked route keeps its stops and order and is
    // not re-solved; a pinned stop stays on its current vehicle (solver pinnedVehicleId).
    const locks = planLocks(plan.options);
    const stops: PlanStopInput[] = [];
    const excluded: PlanInputs['excluded'] = [];
    for (const s of plan.stops) {
      if (s.assignmentId && locks.lockedAssignmentIds.has(s.assignmentId)) continue; // fixed route: untouched
      const owner = ownerOf(s);
      const booking = s.bookingId ? bookings.get(s.bookingId) : undefined;
      if (owner && !consenting.has(owner)) {
        excluded.push({ stopId: s.id, reason: EXCLUDED_REASONS.consent, bookingId: s.bookingId }); // coordinates never leave this function
        continue;
      }
      if (s.bookingId && (!booking || !(ACTIVE_BOOKING_STATUSES as readonly string[]).includes(booking.status))) {
        excluded.push({ stopId: s.id, reason: EXCLUDED_REASONS.booking, bookingId: s.bookingId });
        continue;
      }
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) {
        excluded.push({ stopId: s.id, reason: EXCLUDED_REASONS.location, bookingId: s.bookingId });
        continue;
      }
      const atSite = !!plan.sitePoiId && s.poiId === plan.sitePoiId;
      let tw = windowsOf(s.timeWindows);
      if (!tw && booking && startMs !== null) tw = [[rel(booking.windowStart), rel(booking.windowEnd)]];
      stops.push({
        id: s.id,
        ref: s.ref,
        lat: s.lat,
        lng: s.lng,
        demand: s.demand || (booking && !atSite ? booking.passengerCount : 0),
        serviceS: s.serviceS,
        timeWindows: tw,
        stopKind: s.stopKind === 'PICKUP' || s.stopKind === 'DROP' ? s.stopKind : null,
        bookingId: s.bookingId,
        personal: !!owner,
        atSite,
        customerId: s.customerCompanyId,
        pinnedAssignmentId: locks.pinnedStopIds.has(s.id) && s.assignmentId ? s.assignmentId : null,
      });
    }
    const options = (plan.options && typeof plan.options === 'object' && !Array.isArray(plan.options) ? plan.options : {}) as { maxRideS?: unknown; weights?: unknown; deterministic?: unknown; allowMixedCustomers?: unknown };
    this.logger.log(`job ${job.id}: plan ${plan.id} v${plan.version}: ${stops.length} stop(s), ${excluded.length} left out, ${plan.assignments.length} vehicle(s)`);
    return {
      planId: plan.id,
      companyId: plan.companyId,
      version: plan.version,
      profile: (plan.profile as RoutingProfile) ?? 'car',
      direction: plan.direction ?? null,
      depot: pointOf(plan.depot),
      site: plan.sitePoi ? { lat: plan.sitePoi.lat, lng: plan.sitePoi.lng } : null,
      maxRideS: typeof options.maxRideS === 'number' && options.maxRideS > 0 ? options.maxRideS : null,
      solver: { weights: weightsOf(options.weights), deterministic: options.deterministic === true, allowMixedCustomers: options.allowMixedCustomers === true },
      stops,
      lockedAssignmentIds: [...locks.lockedAssignmentIds],
      vehicles: plan.assignments.filter((a) => !locks.lockedAssignmentIds.has(a.id)).map((a) => {
        const vp = a.objectId ? seats.get(a.objectId) : undefined;
        return { assignmentId: a.id, label: a.vehicleLabel, capacity: a.capacity ?? vp?.seats ?? null, type: vp?.category ?? null, wheelchairSpaces: vp?.wheelchairSpaces ?? 0 };
      }),
      excluded,
    };
  }

  async write(txRaw: StoreTx, job: JobRecord, inputs: PlanInputs, w: PlanWrite, matrix: BuiltMatrix | null, points: { stopId: string; index: number }[], graphVersion: string | null): Promise<void> {
    const tx = txRaw as Tx;
    const next = inputs.version + 1;
    const moved = await tx.routePlan.updateMany({
      where: { id: inputs.planId, companyId: inputs.companyId, version: inputs.version, status: 'OPTIMIZING' },
      data: { status: 'DRAFT' satisfies RoutePlanStatus, version: next, graphVersion },
    });
    // Consent withdrawal / erasure / an edit bumped the version meanwhile: the whole result is discarded (R4: no half plan).
    if (!moved.count) throw new JobError('PLAN_STALE', 'The plan changed while optimising; the result was discarded');
    // Stops of locked routes keep their assignment, order and times.
    const locked = inputs.lockedAssignmentIds ?? [];
    await tx.routePlanStop.updateMany({
      where: { planId: inputs.planId, ...(locked.length ? { OR: [{ assignmentId: null }, { assignmentId: { notIn: locked } }] } : {}) },
      data: { assignmentId: null, sequence: null, etaS: null, unassignedReason: null },
    });
    const eta = uncalibratedEta(graphVersion) as unknown as Prisma.InputJsonValue;
    for (const a of w.assignments) {
      await tx.routeAssignment.updateMany({
        where: { id: a.assignmentId, planId: inputs.planId },
        data: { startS: a.startS, endS: a.endS, durationS: a.durationS, adjustedDurationS: a.durationS, distanceM: a.distanceM, geometry: Prisma.DbNull, etaModel: a.visits.length ? eta : Prisma.DbNull },
      });
      for (const v of a.visits) await tx.routePlanStop.updateMany({ where: { id: v.stopId, planId: inputs.planId }, data: { assignmentId: a.assignmentId, sequence: v.sequence, etaS: v.etaS } });
    }
    for (const u of w.unassigned) await tx.routePlanStop.updateMany({ where: { id: u.stopId, planId: inputs.planId }, data: { unassignedReason: u.reason.slice(0, 64) } });
    if (matrix) {
      for (const p of points) {
        const snap = matrix.snapped[p.index];
        if (snap) await tx.routePlanStop.updateMany({ where: { id: p.stopId, planId: inputs.planId }, data: { ...(snap.lat !== undefined && snap.lng !== undefined ? { snappedLat: snap.lat, snappedLng: snap.lng } : {}), snapDistanceM: Math.round(snap.snapDistanceM), snapGraphVersion: graphVersion } });
      }
    }
    // Version snapshot: ids, sequences and times only (shared RoutePlanVersionSnapshot: no coordinates, no names).
    const [assignments, stops] = await Promise.all([
      tx.routeAssignment.findMany({ where: { planId: inputs.planId }, orderBy: { seq: 'asc' }, select: { id: true, vehicleLabel: true, objectId: true, driverId: true } }),
      tx.routePlanStop.findMany({ where: { planId: inputs.planId }, orderBy: [{ assignmentId: 'asc' }, { sequence: 'asc' }], select: { id: true, ref: true, assignmentId: true, sequence: true, etaS: true, unassignedReason: true } }),
    ]);
    const snapshot: RoutePlanVersionSnapshot = {
      status: 'DRAFT',
      assignments: assignments.map((a) => ({ ...a, stopIds: stops.filter((s) => s.assignmentId === a.id).map((s) => s.id) })),
      stops,
    };
    await tx.routePlanVersion.create({
      data: { planId: inputs.planId, companyId: inputs.companyId, version: next, changeType: 'OPTIMIZED', snapshot: snapshot as unknown as Prisma.InputJsonValue, changedById: job.userId },
    });
  }
}
