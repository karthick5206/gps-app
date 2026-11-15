import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  DEFAULT_TURNAROUND_S,
  transportSettingsOf,
  type ChangeSetResult,
  type DispatchChangeOp,
  type DispatchChangeSetInput,
  type DispatchOptionDto,
  type DispatchReasonCode,
  type DispatchRequestDto,
  type DispatchRequestStatus,
  type DispatchTrigger,
  type DriverRouteAckResult,
  type LiveDispatchDecisionDto,
  type RidePreference,
  type TransportBookingStatus,
  type TransportDirection,
} from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { OptimizerClient } from '../../routing/optimizer/optimizer.client';
import type { PdpResult } from '../../routing-jobs/pdp-contract';
import { parseLive } from '../../tracking/live-object';
import { DispatchService, type PublishSource } from '../dispatch/dispatch.service';
import { assertBookingAccess, bookingReadWhere, conflict, dayKeyOf, idempotencyKey, notFound, round, tripReadWhere, versionConflict } from '../dispatch/e3-common';
import { ACTIVE_OVERLAP_STATUSES } from '../dispatch/trip-overlap';
import { recordTripEvent, seenClientEvent } from '../dispatch/trip-ops';
import { resolveDriver } from '../driver/driver-identity';
import { activeRoutingConsents } from '../people/people.service';
import { enqueueDispatch } from './booking-hooks';
import { cheapestInsertion, fallbackTravel, insertionOps, newTripTiming, type InsertionReason, type InsertionRequest, type InsertionTrip, type LatLng } from './insertion';
import { insertOnlyProblem, solverChoice } from './live-solver';
import { limitsOf, partyCount, pickupWindow, reachableFromPosition, servedAs } from './pooling-rules';
import { effectivePreference } from './publish-checks';
import { preciseFor } from '../dispatch/e3-mapping';
import { liveDispatchOn, poolingSettingsOf } from './pooling-settings';
import { vehicleTimelineProblem } from './timeline-rules';

const H = 3_600_000;
const MAX_ATTEMPTS = 3;
/** A new trip costs a whole vehicle: pooling into an existing trip wins unless it is much longer (doc 20 §4.4 "vehicle" weight). */
const NEW_VEHICLE_PENALTY_S = 1800;
/** After the optimiser answered "no pdp mode", it is not asked again for this long (contract v3 not deployed yet). */
const PDP_RETRY_MS = 10 * 60_000;

export const LIVE_DISPATCH_STATE_KEY = 'vt:etms:dispatch:state';
export const LIVE_DISPATCH_HWM_KEY = 'vt:etms:dispatch:hwm';

/** An option plus what applying it needs. */
export interface LiveOption extends DispatchOptionDto {
  expectedVersions: Record<string, number>;
  direction: TransportDirection;
}

type BookingRow = Prisma.TransportBookingGetPayload<{ include: { profile: { select: { branchId: true } } } }>;

/** Context of the system actor (live auto-assign): the company's own scope, no user (audit / events show SYSTEM). */
export function systemContext(companyId: string): AuthContext {
  return { userId: null as unknown as string, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], agreements: [], ip: null };
}

/**
 * Review fix 8: a stable option id — the ops without their times (planned arrivals move with "now" between a decide and
 * its apply; the target trip / vehicle and stop positions do not).
 */
const optionId = (ops: DispatchChangeOp[]) =>
  `opt-${createHash('sha256')
    .update(JSON.stringify(ops.map((o) => (o.op === 'CREATE_TRIP' ? { ...o, plannedStart: undefined, stops: o.stops?.map((s) => ({ ...s, plannedArrival: undefined })) } : o.op === 'ADD_STOP' ? { ...o, plannedArrival: undefined } : o))))
    .digest('hex')
    .slice(0, 16)}`;

/** Stored options of a request (full LiveOption rows written by `stored`; older rows held summaries only). */
function storedOptions(json: Prisma.JsonValue): LiveOption[] {
  return (Array.isArray(json) ? json : []).filter((o): o is Prisma.JsonObject => !!o && typeof o === 'object' && !Array.isArray(o) && Array.isArray((o as { changes?: unknown }).changes)) as unknown as LiveOption[];
}

/** Review fix 2: an unacknowledged live route change older than this becomes a dispatcher proposal. */
export const ACK_OVERDUE_MS = 3 * 60_000;

/**
 * Live dispatch (doc 20 §5, D1; owner defaults P4 / P5 / P8). For one booking waiting for a seat it finds the feasible
 * options — insertion into a published trip (SCHEDULED, or ACTIVE after its last visited stop) or a new trip on an idle
 * vehicle — and applies the chosen one as an ordinary change set through DispatchService (same advisory locks per
 * vehicle / driver, booking + trip row locks, version CAS, consent read, audit, idempotency). Committed pickup windows,
 * onboard drops and accepted limits never get worse: insertion only uses slack (existing stops keep their planned
 * times) and the publish transaction re-checks P1 exclusivity and the new passenger's accepted limits.
 * Auto-assign (worker): unpublished / SCHEDULED targets within limits when the company policy is AUTO; ACTIVE targets
 * are proposals for the dispatcher. Delay / breakdown reports are evaluated per company policy; boarded passengers of a
 * broken-down vehicle are always a dispatcher decision (P8).
 */
@Injectable()
export class LiveDispatchService {
  private readonly logger = new Logger('EtmsLiveDispatch');
  private pdpUnsupportedUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dispatch: DispatchService,
    private readonly redis: RedisService,
    @Optional() private readonly optimizer?: OptimizerClient,
  ) {}

  private async settingsOf(companyId: string) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    return { pooling: poolingSettingsOf(c?.settings), companyMaxRideS: transportSettingsOf(c?.settings).maxRideS ?? null };
  }

  // ───────────────────────────── dispatcher: find a vehicle ─────────────────────────────

  async decide(ctx: AuthContext, dto: { bookingId: string; apply?: boolean; optionId?: string; requestId?: string }, rawKey: string | undefined): Promise<LiveDispatchDecisionDto> {
    // Scope first (another tenant's / branch's booking is a 404 whatever the switches), then the switches.
    const booking = await this.prisma.transportBooking.findFirst({ where: { AND: [bookingReadWhere(ctx), { id: dto.bookingId }] }, include: { profile: { select: { branchId: true } } } });
    if (!booking || booking.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
    assertBookingAccess(ctx, booking, 'write');
    const { pooling } = await this.settingsOf(ctx.companyId);
    if (!liveDispatchOn(pooling)) throw conflict('LIVE_DISPATCH_DISABLED', pooling.killSwitch ? 'Live dispatch is switched off on this server' : 'Live dispatch is switched off for your company (Transport settings → Pooling)');
    const key = dto.apply ? idempotencyKey(rawKey) : null;
    const reqKey = key ? `manual:${booking.id}:${key}` : `manual:${booking.id}:${Date.now()}`;
    const started = Date.now();
    const existing = key ? await this.prisma.transportDispatchRequest.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: reqKey } }) : null;
    if (existing && existing.status === 'APPLIED') return this.decisionOf(ctx, booking, existing, storedOptions(existing.options));
    // Review fix 8: apply exactly the option the dispatcher was shown (stored on its request), not a recomputation whose
    // times moved on; the trip version check (expectedVersions) refuses it if the trip changed meanwhile.
    if (dto.apply && dto.requestId) {
      const shown = await this.prisma.transportDispatchRequest.findFirst({ where: { id: dto.requestId, companyId: ctx.companyId, bookingId: booking.id } });
      if (!shown) throw notFound('Decision not found');
      if (!['DECIDED', 'PROPOSED'].includes(shown.status)) throw conflict('INVALID_STATE', `This decision is ${shown.status.toLowerCase()}; ask for the options again`);
      const opts = storedOptions(shown.options);
      const chosen = dto.optionId ? opts.find((o) => o.optionId === dto.optionId) : opts[0];
      if (!chosen) throw conflict('NO_FEASIBLE_OPTION', 'That option is not part of this decision; ask for the options again');
      const r = await this.applyOption(ctx, shown.id, booking, chosen, `live-${key}`, false);
      const after = await this.prisma.transportDispatchRequest.findUniqueOrThrow({ where: { id: shown.id } });
      return { ...(await this.decisionOf(ctx, booking, after, opts)), changeSetId: r.changeSetId };
    }
    const { options, reasons } = await this.findOptions(ctx, booking);
    let request = existing;
    if (!request) {
      try {
        request = await this.prisma.transportDispatchRequest.create({
          data: { companyId: ctx.companyId, bookingId: booking.id, trigger: 'MANUAL', status: options.length ? 'DECIDED' : 'REJECTED', idempotencyKey: reqKey, options: this.stored(options), reasons: reasons as unknown as Prisma.InputJsonValue, createdById: ctx.userId, decidedAt: new Date(), durationMs: Date.now() - started },
        });
      } catch (e) {
        // Review fix 9: a concurrent decide with the same Idempotency-Key created it first: continue on its row (replay).
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        request = await this.prisma.transportDispatchRequest.findFirstOrThrow({ where: { companyId: ctx.companyId, idempotencyKey: reqKey } });
        if (request.status === 'APPLIED') return this.decisionOf(ctx, booking, request, storedOptions(request.options));
      }
    }
    if (!dto.apply) return this.decisionOf(ctx, booking, request, options);
    const pool = request === existing ? storedOptions(request.options) : options;
    const chosen = dto.optionId ? pool.find((o) => o.optionId === dto.optionId) : pool[0];
    if (!chosen) throw conflict('NO_FEASIBLE_OPTION', dto.optionId ? 'That option is no longer feasible; ask for the options again' : 'No vehicle can take this booking within its limits', { reasons });
    const r = await this.applyOption(ctx, request.id, booking, chosen, `live-${key}`, false);
    const after = await this.prisma.transportDispatchRequest.findUniqueOrThrow({ where: { id: request.id } });
    return { ...(await this.decisionOf(ctx, booking, after, pool)), changeSetId: r.changeSetId };
  }

  async requests(ctx: AuthContext, q: { status?: DispatchRequestStatus; trigger?: DispatchTrigger; bookingId?: string; limit?: number }): Promise<DispatchRequestDto[]> {
    const rows = await this.prisma.transportDispatchRequest.findMany({
      where: { companyId: ctx.companyId, ...(q.status ? { status: q.status } : {}), ...(q.trigger ? { trigger: q.trigger } : {}), ...(q.bookingId ? { bookingId: q.bookingId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, q.limit ?? 50),
      include: { booking: { select: { status: true, customerCompanyId: true, providerCompanyId: true, profile: { select: { branchId: true } } } } },
    });
    // Branch-scoped dispatchers: only requests of bookings in their branches (a trip-only request: whole-company roles).
    const visible = rows.filter((r) => {
      if (ctx.dataScope === 'COMPANY') return true;
      if (!r.booking) return false;
      try {
        assertBookingAccess(ctx, r.booking, 'read');
        return true;
      } catch {
        return false;
      }
    });
    const scoped = await this.dispatch.scopedObjectIds(ctx);
    return visible.map((r) => ({
      id: r.id,
      trigger: r.trigger as DispatchTrigger,
      status: r.status as DispatchRequestStatus,
      bookingId: r.bookingId,
      tripId: r.tripId,
      bookingStatus: (r.booking?.status as TransportBookingStatus | undefined) ?? null,
      chosenOptionId: r.chosenOptionId,
      changeSetId: r.changeSetId,
      reasons: (Array.isArray(r.reasons) ? r.reasons : []) as DispatchReasonCode[],
      // Ids, kinds and costs only (never the stored change ops with their points), and only vehicles in the caller's scope.
      alternatives: this.alternatives(storedOptions(r.options)).filter((a) => scoped === null || scoped.includes(a.objectId)),
      attempts: r.attempts,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      durationMs: r.durationMs,
    }));
  }

  private alternatives(options: LiveOption[]): DispatchRequestDto['alternatives'] {
    return options.slice(0, 10).map((o) => ({ optionId: o.optionId, kind: o.kind, tripId: o.tripId, objectId: o.objectId, addedS: o.addedS, target: o.target }));
  }

  /** Review fix 8: the full options (ops, versions) are stored on the request, so a proposal / shown option can be applied as is. */
  private stored(options: LiveOption[]): Prisma.InputJsonValue {
    return options.slice(0, 20) as unknown as Prisma.InputJsonValue;
  }

  /**
   * Review fix 6: the options as this caller may see them — a passenger's personal point in a NEW_TRIP stop is rounded
   * to 4 decimals unless the caller is a whole-company role of the customer (preciseFor), and the read is ACCESS-audited.
   */
  private async decisionOf(ctx: AuthContext, booking: { id: string; profileId: string; customerCompanyId: string }, r: { id: string; bookingId: string | null; status: string; chosenOptionId: string | null; changeSetId: string | null; reasons: Prisma.JsonValue }, options: LiveOption[]): Promise<LiveDispatchDecisionDto> {
    const precise = preciseFor(ctx, booking.customerCompanyId);
    let personal = false;
    const shown = options.map(({ expectedVersions: _v, direction: _d, ...o }) => ({
      ...o,
      changes: o.changes.map((c) => {
        if (c.op !== 'CREATE_TRIP' || !c.stops) return c;
        return {
          ...c,
          stops: c.stops.map((s) => {
            if (s.point.poiId) return s;
            personal = true;
            return precise ? s : { ...s, point: { ...s.point, lat: round(s.point.lat, 4), lng: round(s.point.lng, 4) } };
          }),
        };
      }),
    }));
    if (personal) await this.dispatch.recordPersonalAccess(ctx, 'candidates', [booking.profileId], precise, { bookingId: booking.id, liveDispatch: true });
    return {
      requestId: r.id,
      bookingId: r.bookingId ?? '',
      status: r.status as DispatchRequestStatus,
      options: shown,
      chosenOptionId: r.chosenOptionId,
      changeSetId: r.changeSetId,
      reasons: (Array.isArray(r.reasons) ? r.reasons : []) as DispatchReasonCode[],
    };
  }

  // ───────────────────────────── options ─────────────────────────────

  /**
   * Feasible options for `booking`, best first. `exceptTripId` (re-dispatch after a delay / breakdown) leaves the
   * passenger's current trip out and does not require the booking to be waiting for a seat.
   */
  async findOptions(ctx: AuthContext, booking: BookingRow, opts: { exceptTripId?: string; reseat?: boolean; now?: number } = {}): Promise<{ options: LiveOption[]; reasons: DispatchReasonCode[] }> {
    const now = opts.now ?? Date.now();
    const reasons = new Set<DispatchReasonCode>();
    if (!opts.reseat && booking.status !== 'PENDING_ASSIGNMENT') reasons.add('NOT_ELIGIBLE');
    if (booking.holdFromPlanning) reasons.add('ON_HOLD');
    if (booking.pickupLat === null || booking.pickupLng === null || booking.dropLat === null || booking.dropLng === null) reasons.add('NEEDS_LOCATION');
    if ((!booking.pickupPoiId || !booking.dropPoiId) && !(await activeRoutingConsents(this.prisma, [booking.profileId])).has(booking.profileId)) reasons.add('CONSENT_REQUIRED');
    if (reasons.size) return { options: [], reasons: [...reasons] };
    const { companyMaxRideS } = await this.settingsOf(ctx.companyId);
    const req: InsertionRequest = {
      bookingId: booking.id,
      seats: booking.passengerCount,
      preference: booking.ridePreference as RidePreference,
      pickup: { lat: booking.pickupLat!, lng: booking.pickupLng!, poiId: booking.pickupPoiId },
      drop: { lat: booking.dropLat!, lng: booking.dropLng!, poiId: booking.dropPoiId },
      windowStartMs: booking.windowStart.getTime(),
      windowEndMs: booking.windowEnd.getTime(),
      limits: limitsOf(booking.limits),
      companyMaxRideS,
    };
    const [, pwEnd] = pickupWindow(req.windowStartMs, req.windowEndMs, req.limits);
    if (pwEnd < now) return { options: [], reasons: ['PICKUP_WINDOW'] };
    const objectIds = await this.dispatch.scopedObjectIds(ctx);
    const trips = await this.prisma.transportTrip.findMany({
      where: {
        AND: [
          tripReadWhere(ctx, objectIds),
          { providerCompanyId: ctx.companyId, serviceDate: booking.serviceDate, cancelledAt: null, publishedAt: { not: null }, plannedTrip: { status: { in: ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] } } },
          ...(booking.journey === 'COMMUTE' && booking.direction ? [{ direction: booking.direction }] : []),
          ...(opts.exceptTripId ? [{ id: { not: opts.exceptTripId } }] : []),
        ],
      },
      include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } }, passengers: { where: { status: { not: 'CANCELLED' } }, select: { bookingId: true, pickupSeq: true, dropSeq: true, seats: true, booking: { select: { ridePreference: true, groupId: true, limits: true } } } } },
      take: 200,
    });
    const vehicleIds = [...new Set(trips.flatMap((t) => (t.plannedTrip ? [t.plannedTrip.objectId] : [])))];
    const objects = await this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { isActive: true }] }, select: { id: true, name: true, companyId: true, maintenanceSince: true, transportProfile: { select: { seats: true, turnaroundS: true } } }, take: 500 });
    const objById = new Map(objects.filter((o) => o.companyId === ctx.companyId).map((o) => [o.id, o]));
    const allIds = [...new Set([...vehicleIds, ...objById.keys()])];
    const dayFrom = new Date(req.windowStartMs - 12 * H);
    const dayTo = new Date(req.windowEndMs + 12 * H);
    const [busyAll, availability, fixes] = await Promise.all([
      this.prisma.plannedTrip.findMany({ where: { objectId: { in: allIds }, status: { in: ACTIVE_OVERLAP_STATUSES }, plannedStart: { lt: dayTo }, plannedEnd: { gt: dayFrom } }, select: { id: true, objectId: true, plannedStart: true, plannedEnd: true } }),
      this.prisma.transportVehicleAvailability.findMany({ where: { objectId: { in: allIds }, startsAt: { lt: new Date(dayTo.getTime() + 24 * H) }, endsAt: { gt: new Date(dayFrom.getTime() - 24 * H) } }, select: { objectId: true, kind: true, startsAt: true, endsAt: true } }),
      this.fixes(allIds),
    ]);
    const options: LiveOption[] = [];
    const candidates: (InsertionTrip & { seated: { bookingId: string; pickupSeq: number; dropSeq: number; seats: number }[] })[] = [];
    const tripMeta = new Map<string, (typeof trips)[number]>();
    for (const t of trips) {
      const pt = t.plannedTrip;
      if (!pt) continue;
      if (objectIds !== null && !objectIds.includes(pt.objectId)) continue;
      // The booking's own group rides as one party (P1): a group member does not count as "someone else".
      const others = t.passengers.filter((p) => !(booking.groupId && p.booking.groupId === booking.groupId));
      const turnaroundS = objById.get(pt.objectId)?.transportProfile?.turnaroundS ?? DEFAULT_TURNAROUND_S;
      const mine = busyAll.filter((b) => b.objectId === pt.objectId && b.id !== pt.id);
      const prevEnd = mine.filter((b) => b.plannedEnd.getTime() <= pt.plannedStart.getTime()).reduce<number | null>((m, b) => Math.max(m ?? 0, b.plannedEnd.getTime()), null);
      const nextStart = mine.filter((b) => b.plannedStart.getTime() >= pt.plannedEnd.getTime()).reduce<number | null>((m, b) => Math.min(m ?? Infinity, b.plannedStart.getTime()), null);
      const active = pt.status !== 'SCHEDULED';
      // Review fix 2: a started trip whose driver has not acknowledged the last live change takes no further insertion.
      if (active && t.liveRouteAckVersion < t.liveRouteVersion) {
        reasons.add('ROUTE_ACK_PENDING');
        continue;
      }
      const fix = fixes.get(pt.objectId);
      // Review fix 1: started (or already late) trips are judged on their live delay.
      const delayMs = (active || pt.plannedStart.getTime() < now) && pt.delaySec && pt.delaySec > 0 ? pt.delaySec * 1000 : 0;
      const trip: InsertionTrip & { seated: { bookingId: string; pickupSeq: number; dropSeq: number; seats: number }[] } = {
        tripId: t.id,
        objectId: pt.objectId,
        status: pt.status,
        seatCapacity: t.seatCapacity,
        occupied: t.occupiedSeats,
        stops: pt.stops.map((s) => ({ seq: s.seq, lat: s.lat, lng: s.lng, poiId: s.poiId, arrivalMs: s.plannedArrival.getTime(), departureMs: s.plannedDeparture.getTime(), visited: s.status !== 'PENDING' })),
        onTrip: others.map((p) => effectivePreference(p.booking.ridePreference as RidePreference, p.booking.limits)),
        delayMs,
        prevEndMs: prevEnd,
        nextStartMs: nextStart,
        turnaroundS,
        live: active && fix ? { pos: fix, atMs: now } : null,
        seated: t.passengers.map((p) => ({ bookingId: p.bookingId, pickupSeq: p.pickupSeq, dropSeq: p.dropSeq, seats: p.seats })),
      };
      tripMeta.set(t.id, t);
      candidates.push(trip);
      const ins = cheapestInsertion(trip, req, fallbackTravel, now);
      if (!ins.feasible) {
        ins.reasons.forEach((r) => reasons.add(r as InsertionReason));
        continue;
      }
      const changes = insertionOps(t.id, booking.id, ins);
      options.push({
        optionId: optionId(changes),
        kind: 'INSERT',
        tripId: t.id,
        objectId: pt.objectId,
        vehicleName: objById.get(pt.objectId)?.name ?? pt.routeName,
        target: active ? 'ACTIVE' : 'SCHEDULED',
        pickupEta: new Date(ins.pickupEtaMs).toISOString(),
        dropEta: new Date(ins.dropEtaMs).toISOString(),
        addedS: ins.addedS,
        affectedPassengers: partyCount(others.map((p) => ({ bookingId: p.bookingId, groupId: p.booking.groupId }))),
        changes,
        autoApplicable: !active,
        servedAs: servedAs(req.preference, partyCount(others.map((p) => ({ bookingId: p.bookingId, groupId: p.booking.groupId }))) + 1),
        engine: 'FALLBACK',
        expectedVersions: { [t.id]: t.version },
        direction: t.direction,
      });
    }
    // Idle vehicles: a new trip (the only way for a PRIVATE ride that finds no empty trip).
    for (const o of objById.values()) {
      const seats = o.transportProfile?.seats ?? null;
      if (seats === null || seats < req.seats) continue;
      const turnaroundS = o.transportProfile?.turnaroundS ?? DEFAULT_TURNAROUND_S;
      const busy = busyAll.filter((b) => b.objectId === o.id).map((b) => ({ start: b.plannedStart.getTime(), end: b.plannedEnd.getTime() }));
      const timing = newTripTiming(req, { pos: fixes.get(o.id) ?? null, busy, turnaroundS }, fallbackTravel, now);
      if (!timing) {
        reasons.add('VEHICLE_BUSY');
        continue;
      }
      const p = vehicleTimelineProblem({ start: timing.startMs, end: timing.endMs }, availability.filter((a) => a.objectId === o.id), o.maintenanceSince, busy, o.transportProfile?.turnaroundS ?? null);
      if (p) {
        reasons.add('VEHICLE_UNAVAILABLE');
        continue;
      }
      const label = (poi: string | null, l: string | null) => (poi ? l : null);
      const changes: DispatchChangeOp[] = [
        {
          op: 'CREATE_TRIP',
          tempId: 'live',
          objectId: o.id,
          driverId: null,
          plannedStart: new Date(timing.startMs).toISOString(),
          routeId: null,
          stops: [
            { seq: 0, point: { lat: req.pickup.lat, lng: req.pickup.lng, label: label(booking.pickupPoiId, booking.pickupLabel), poiId: booking.pickupPoiId }, plannedArrival: new Date(timing.pickupMs).toISOString(), waitMin: 1 },
            { seq: 1, point: { lat: req.drop.lat, lng: req.drop.lng, label: label(booking.dropPoiId, booking.dropLabel), poiId: booking.dropPoiId }, plannedArrival: new Date(timing.dropMs).toISOString() },
          ],
          shiftId: booking.shiftId,
          sitePoiId: null,
          name: `Live ride ${dayKeyOf(booking.serviceDate)}`,
        },
        { op: 'ADD_PASSENGER', tripId: 'live', bookingId: booking.id, pickupSeq: 0, dropSeq: 1 },
      ];
      options.push({
        optionId: optionId(changes),
        kind: 'NEW_TRIP',
        tripId: null,
        objectId: o.id,
        vehicleName: o.name,
        target: 'IDLE',
        pickupEta: new Date(timing.pickupMs).toISOString(),
        dropEta: new Date(timing.dropMs).toISOString(),
        addedS: Math.round((timing.dropMs - timing.pickupMs) / 1000) + NEW_VEHICLE_PENALTY_S,
        affectedPassengers: 0,
        changes,
        autoApplicable: true,
        servedAs: 'PRIVATE',
        engine: 'FALLBACK',
        expectedVersions: {},
        direction: booking.direction ?? 'IN',
      });
    }
    if (!options.length && !reasons.size) reasons.add('NO_CANDIDATE');
    options.sort((a, b) => a.addedS - b.addedS || a.pickupEta.localeCompare(b.pickupEta));
    // The optimiser's insertOnly choice (when it offers contract v3) goes first; its placement is realised above.
    const choice = await this.solverPick(candidates.filter((c) => options.some((o) => o.tripId === c.tripId)), req, now);
    if (choice) {
      const i = options.findIndex((o) => o.tripId === choice);
      if (i >= 0) options.unshift({ ...options.splice(i, 1)[0], engine: 'SOLVER' });
    }
    return { options: options.slice(0, 20), reasons: options.length ? [] : [...reasons] };
  }

  /** Optimiser insertOnly pick, or null (not configured, no contract v3 yet, unavailable, or nothing to choose from). */
  private async solverPick(candidates: Parameters<typeof insertOnlyProblem>[0], req: InsertionRequest, now: number): Promise<string | null> {
    if (!candidates.length || !this.optimizer?.configured || Date.now() < this.pdpUnsupportedUntil || (process.env.ETMS_POOLING_SOLVER ?? 'on').toLowerCase() === 'off') return null;
    try {
      const { problem, tripOfVehicle } = insertOnlyProblem(candidates, req, now);
      const res = await this.optimizer.solvePdp<typeof problem, PdpResult>(problem);
      return solverChoice(res, req.bookingId, tripOfVehicle);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'PDP_UNSUPPORTED') this.pdpUnsupportedUntil = Date.now() + PDP_RETRY_MS;
      this.logger.warn(`live insertion via the optimiser unavailable (${code ?? (e as Error).message}); in-process insertion used`);
      return null;
    }
  }

  private async fixes(objectIds: string[]): Promise<Map<string, LatLng>> {
    const out = new Map<string, LatLng>();
    if (!objectIds.length) return out;
    const raw = await this.redis.client.mget(...objectIds.map((id) => RedisKeys.live(id))).catch(() => [] as (string | null)[]);
    objectIds.forEach((id, i) => {
      const live = parseLive(raw?.[i] ?? null);
      if (live && live.lat !== null && live.lng !== null) out.set(id, { lat: live.lat, lng: live.lng });
    });
    return out;
  }

  // ───────────────────────────── apply ─────────────────────────────

  /** Applies an option as a change set (DispatchService.publishPrepared); the request becomes APPLIED in the same transaction. */
  async applyOption(ctx: AuthContext, requestId: string, booking: Pick<BookingRow, 'id' | 'serviceDate'>, option: LiveOption, key: string, system: boolean, extra: DispatchChangeOp[] = [], extraVersions: Record<string, number> = {}, allowActive = false): Promise<ChangeSetResult> {
    const input: DispatchChangeSetInput = { serviceDate: dayKeyOf(booking.serviceDate), direction: option.direction, changes: [...extra, ...option.changes], expectedVersions: { ...extraVersions, ...option.expectedVersions }, reason: `Live dispatch ${requestId}` };
    const source: PublishSource = {
      ref: { dispatchRequestId: requestId, optionId: option.optionId },
      live: true,
      enforceLimits: true,
      allowActiveTrips: allowActive || option.target === 'ACTIVE',
      systemActor: system,
      reachable: (t) => this.reachable(t.plannedTripId),
      inTransaction: async (tx, result) => {
        await tx.transportDispatchRequest.update({ where: { id: requestId }, data: { status: 'APPLIED', chosenOptionId: option.optionId, changeSetId: result.changeSetId, decidedAt: new Date() } });
        await this.audit.record(ctx, { action: 'UPDATE', entity: 'TransportDispatchRequest', entityId: requestId, details: { applied: true, bookingId: booking.id, optionId: option.optionId, kind: option.kind, tripId: option.tripId, objectId: option.objectId, target: option.target, engine: option.engine, changeSetId: result.changeSetId, system } }, tx);
      },
    };
    const r = await this.dispatch.publishPrepared(ctx, input, key, source);
    return r.value;
  }

  /**
   * Review fix 1 (P5): can the vehicle still make its first pending stop in time (planned + live delay) from its live
   * position? No fix = not judged (the dispatcher applied it knowingly; the driver acknowledges).
   */
  private async reachable(plannedTripId: string, now = Date.now()): Promise<string | null> {
    const pt = await this.prisma.plannedTrip.findUnique({ where: { id: plannedTripId }, select: { objectId: true, delaySec: true, stops: { where: { status: 'PENDING' }, orderBy: { seq: 'asc' }, take: 1, select: { lat: true, lng: true, plannedArrival: true } } } });
    const first = pt?.stops[0];
    if (!pt || !first) return null;
    const fix = (await this.fixes([pt.objectId])).get(pt.objectId);
    if (!fix) return null;
    const due = first.plannedArrival.getTime() + Math.max(0, pt.delaySec ?? 0) * 1000;
    return reachableFromPosition(now, fallbackTravel(fix, first), due) ? null : 'The vehicle can no longer reach its next stop in time from where it is';
  }

  // ───────────────────────────── worker side ─────────────────────────────

  /** One decision per request (the caller holds the company's Valkey lock). Returns the new status. */
  async process(requestId: string): Promise<DispatchRequestStatus> {
    const req = await this.prisma.transportDispatchRequest.findUnique({ where: { id: requestId } });
    if (!req || !['QUEUED', 'FAILED'].includes(req.status)) return (req?.status as DispatchRequestStatus) ?? 'FAILED';
    const started = Date.now();
    const { pooling } = await this.settingsOf(req.companyId);
    if (!liveDispatchOn(pooling)) return this.finish(req.id, 'REJECTED', ['DISABLED'], [], started);
    try {
      // Review fix 3: a child request (one booking) retries its own re-seat; only the trip-level request evaluates the trip.
      if ((req.trigger === 'DELAY' || req.trigger === 'BREAKDOWN') && req.bookingId) return await this.reseatChild(req, pooling.delayPolicy, started);
      if (req.trigger === 'DELAY' || req.trigger === 'BREAKDOWN') return await this.evaluateTrip(req, pooling.delayPolicy, pooling.delayThresholdS, started);
      if (!req.bookingId) return this.finish(req.id, 'REJECTED', ['NOT_ELIGIBLE'], [], started);
      const ctx = systemContext(req.companyId);
      const booking = await this.prisma.transportBooking.findFirst({ where: { id: req.bookingId, customerCompanyId: req.companyId }, include: { profile: { select: { branchId: true } } } });
      if (!booking) return this.finish(req.id, 'REJECTED', ['NOT_ELIGIBLE'], [], started);
      const { options, reasons } = await this.findOptions(ctx, booking);
      if (!options.length) return this.finish(req.id, 'REJECTED', reasons, [], started);
      const auto = pooling.scheduledPolicy === 'AUTO' ? options.find((o) => o.autoApplicable) : undefined;
      if (!auto) return this.finish(req.id, 'PROPOSED', [], options, started);
      await this.prisma.transportDispatchRequest.update({ where: { id: req.id }, data: { options: this.stored(options), durationMs: Date.now() - started } });
      await this.applyOption(ctx, req.id, booking, auto, `live-${req.id}-${req.attempts}`, true);
      return 'APPLIED';
    } catch (e) {
      const code = (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code ?? (e as Error).name;
      await this.prisma.transportDispatchRequest.update({ where: { id: req.id }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: `${code}: ${(e as Error).message}`.slice(0, 300) } });
      if (req.attempts + 1 >= MAX_ATTEMPTS) this.logger.warn(`dispatch request ${req.id} failed ${MAX_ATTEMPTS} times (${code})`);
      return 'FAILED';
    }
  }

  private async finish(id: string, status: DispatchRequestStatus, reasons: DispatchReasonCode[], options: LiveOption[], started: number): Promise<DispatchRequestStatus> {
    await this.prisma.transportDispatchRequest.update({ where: { id }, data: { status, reasons: reasons as unknown as Prisma.InputJsonValue, options: this.stored(options), decidedAt: new Date(), durationMs: Date.now() - started } });
    return status;
  }

  /**
   * REPORT_DELAY / REPORT_BREAKDOWN (doc 20 §5.3). Breakdown: TransportTrip.interruptedAt + TRIP_INTERRUPTED; every
   * pending passenger is re-dispatched (company delay policy: AUTO applies a SCHEDULED / idle option, PROPOSE leaves a
   * proposal); boarded passengers get a dispatcher-only proposal (P8, never automatic). Delay: pending passengers whose
   * committed pickup the delay would break are re-dispatched the same way.
   */
  private async evaluateTrip(req: { id: string; companyId: string; tripId: string | null; trigger: string; idempotencyKey: string; attempts: number; options: Prisma.JsonValue }, policy: 'AUTO' | 'PROPOSE', thresholdS: number, started: number): Promise<DispatchRequestStatus> {
    if (!req.tripId) return this.finish(req.id, 'REJECTED', ['NOT_ELIGIBLE'], [], started);
    const ctx = systemContext(req.companyId);
    const trip = await this.prisma.transportTrip.findFirst({
      where: { id: req.tripId, providerCompanyId: req.companyId },
      include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } }, passengers: { where: { status: { in: ['PENDING', 'BOARDED'] } }, include: { booking: { include: { profile: { select: { branchId: true } } } } } } },
    });
    if (!trip?.plannedTrip) return this.finish(req.id, 'REJECTED', ['NOT_ELIGIBLE'], [], started);
    const pt = trip.plannedTrip;
    const breakdown = req.trigger === 'BREAKDOWN';
    const delayS = breakdown ? Infinity : Math.max((Number((req.options as { delayS?: unknown } | null)?.delayS) || 0), pt.delaySec ?? 0);
    if (!breakdown && delayS < thresholdS) return this.finish(req.id, 'DECIDED', [], [], started);
    if (breakdown && !trip.interruptedAt) {
      await this.prisma.$transaction(async (tx) => {
        const n = await tx.transportTrip.updateMany({ where: { id: trip.id, interruptedAt: null }, data: { interruptedAt: new Date(), interruptReason: 'Vehicle breakdown reported by the driver' } });
        if (n.count) await recordTripEvent(tx, ctx, { tripId: trip.id, providerCompanyId: trip.providerCompanyId, customerCompanyId: trip.customerCompanyId, kind: 'TRIP_INTERRUPTED', actorType: 'SYSTEM', source: 'SYSTEM', reasonCode: 'BREAKDOWN', data: { dispatchRequestId: req.id } });
      });
    }
    for (const p of trip.passengers) {
      const childKey = `${req.idempotencyKey}:${p.bookingId}`;
      if (await this.prisma.transportDispatchRequest.findFirst({ where: { companyId: req.companyId, idempotencyKey: childKey }, select: { id: true } })) continue;
      if (p.status === 'BOARDED') {
        // P8: boarded passengers of a broken-down vehicle are the dispatcher's decision (pickup at the vehicle's position).
        if (breakdown) await enqueueDispatch(this.prisma as unknown as Prisma.TransactionClient, { companyId: req.companyId, bookingId: p.bookingId, tripId: trip.id, trigger: 'BREAKDOWN', key: childKey, userId: null, status: 'PROPOSED', reasons: ['ONBOARD_TRANSFER'] });
        continue;
      }
      if (!breakdown) {
        const pick = pt.stops.find((s) => s.seq === p.pickupSeq);
        const [, latest] = pickupWindow(p.booking.windowStart.getTime(), p.booking.windowEnd.getTime(), limitsOf(p.booking.limits));
        if (!pick || pick.plannedArrival.getTime() + delayS * 1000 <= Math.max(latest, pick.plannedArrival.getTime())) continue;
      }
      const child = await this.prisma.transportDispatchRequest.create({ data: { companyId: req.companyId, bookingId: p.bookingId, tripId: trip.id, trigger: req.trigger, status: 'QUEUED', idempotencyKey: childKey } });
      await this.reseatOne(ctx, { id: child.id, attempts: 0 }, trip.id, p.id, p.booking, breakdown, policy, started);
    }
    return this.finish(req.id, 'DECIDED', [], [], started);
  }

  /** Review fix 3: the worker's retry of one re-seat child (never a new trip evaluation). */
  private async reseatChild(req: { id: string; companyId: string; tripId: string | null; bookingId: string | null; trigger: string; attempts: number }, policy: 'AUTO' | 'PROPOSE', started: number): Promise<DispatchRequestStatus> {
    if (!req.tripId || !req.bookingId) return this.finish(req.id, 'REJECTED', ['NOT_ELIGIBLE'], [], started);
    const seat = await this.prisma.transportTripPassenger.findFirst({ where: { tripId: req.tripId, bookingId: req.bookingId, status: 'PENDING', providerCompanyId: req.companyId }, include: { booking: { include: { profile: { select: { branchId: true } } } } } });
    if (!seat) return this.finish(req.id, 'REJECTED', ['NOT_ELIGIBLE'], [], started);
    return this.reseatOne(systemContext(req.companyId), req, req.tripId, seat.id, seat.booking, req.trigger === 'BREAKDOWN', policy, started);
  }

  /** One pending passenger off a delayed / broken trip: options elsewhere; AUTO applies (one change set), else a proposal. */
  private async reseatOne(ctx: AuthContext, child: { id: string; attempts: number }, tripId: string, passengerTripId: string, booking: BookingRow, breakdown: boolean, policy: 'AUTO' | 'PROPOSE', started: number): Promise<DispatchRequestStatus> {
    const { options, reasons } = await this.findOptions(ctx, booking, { exceptTripId: tripId, reseat: true });
    const auto = policy === 'AUTO' ? options.find((o) => o.autoApplicable) : undefined;
    if (!auto) return this.finish(child.id, options.length ? 'PROPOSED' : 'REJECTED', reasons, options, started);
    // The trip's version as it is now (a previous re-seat or a failed attempt may have changed it).
    const version = (await this.prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId }, select: { version: true } })).version;
    try {
      await this.applyOption(ctx, child.id, booking, auto, `live-${child.id}-${child.attempts}`, true, [{ op: 'REMOVE_PASSENGER', passengerTripId, reason: breakdown ? 'Vehicle breakdown: moved to another vehicle' : 'Delay: moved to another vehicle' }], { [tripId]: version }, true);
      return 'APPLIED';
    } catch (e) {
      const code = (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code ?? (e as Error).name;
      await this.prisma.transportDispatchRequest.update({ where: { id: child.id }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: `${code}: ${(e as Error).message}`.slice(0, 300) } });
      return 'FAILED';
    }
  }

  /**
   * Review fix 2: a live change of a started trip the driver has not acknowledged within ACK_OVERDUE_MS becomes a
   * dispatcher proposal (reason ROUTE_ACK_OVERDUE, once per route version).
   */
  async escalateOverdueAcks(now = Date.now()): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string; providerCompanyId: string; liveRouteVersion: number }[]>`
      SELECT id, "providerCompanyId", "liveRouteVersion" FROM "TransportTrip"
      WHERE "liveRouteVersion" > "liveRouteAckVersion" AND "cancelledAt" IS NULL ORDER BY "updatedAt" DESC LIMIT 100`;
    let n = 0;
    for (const t of rows) {
      const ev = await this.prisma.transportTripEvent.findFirst({ where: { tripId: t.id, kind: 'ROUTE_UPDATED' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } });
      if (!ev || now - ev.receivedAt.getTime() < ACK_OVERDUE_MS) continue;
      const id = await this.prisma.$transaction((tx) => enqueueDispatch(tx, { companyId: t.providerCompanyId, bookingId: null, tripId: t.id, trigger: 'MANUAL', key: `ackoverdue:${t.id}:v${t.liveRouteVersion}`, userId: null, status: 'PROPOSED', reasons: ['ROUTE_ACK_OVERDUE'] }));
      if (id) n++;
    }
    return n;
  }

  /** REPORT_DELAY / REPORT_BREAKDOWN events since the high-water mark → evaluation requests (companies with live dispatch on). */
  async scanReports(now = Date.now()): Promise<number> {
    const raw = await this.redis.client.get(LIVE_DISPATCH_HWM_KEY).catch(() => null);
    const from = Math.max(Number(raw) || 0, now - 24 * H);
    const events = await this.prisma.transportTripEvent.findMany({ where: { kind: { in: ['REPORT_DELAY', 'REPORT_BREAKDOWN'] }, outcome: 'ACCEPTED', receivedAt: { gt: new Date(from) } }, orderBy: { receivedAt: 'asc' }, take: 200, select: { id: true, tripId: true, providerCompanyId: true, kind: true, data: true, receivedAt: true } });
    let n = 0;
    for (const e of events) {
      const etaMin = Number((e.data as { etaMin?: unknown } | null)?.etaMin) || 0;
      const id = await this.prisma.$transaction((tx) => enqueueDispatch(tx, { companyId: e.providerCompanyId, bookingId: null, tripId: e.tripId, trigger: e.kind === 'REPORT_BREAKDOWN' ? 'BREAKDOWN' : 'DELAY', key: `evt:${e.id}`, userId: null }));
      if (id && etaMin) await this.prisma.transportDispatchRequest.updateMany({ where: { id, status: 'QUEUED' }, data: { options: { delayS: etaMin * 60 } as Prisma.InputJsonValue } });
      if (id) n++;
    }
    if (events.length) await this.redis.client.set(LIVE_DISPATCH_HWM_KEY, String(events[events.length - 1].receivedAt.getTime())).catch(() => undefined);
    return n;
  }

  // ───────────────────────────── driver acknowledgement (P5) ─────────────────────────────

  async routeAck(ctx: AuthContext, tripId: string, dto: { routeVersion: number; clientEventId: string }): Promise<DriverRouteAckResult> {
    const me = await resolveDriver(this.prisma, ctx);
    const tt = await this.prisma.transportTrip.findFirst({ where: { id: tripId, providerCompanyId: ctx.companyId }, include: { plannedTrip: { select: { driverId: true, companyId: true } } } });
    if (!tt?.plannedTrip || tt.plannedTrip.driverId !== me.id || tt.plannedTrip.companyId !== ctx.companyId) throw notFound('Trip not found');
    if (dto.routeVersion > tt.liveRouteVersion) throw versionConflict(tt.liveRouteVersion);
    await this.prisma.$transaction(async (tx) => {
      if (await seenClientEvent(tx, tripId, dto.clientEventId, ctx.userId, 'ROUTE_ACK')) return;
      await tx.transportTrip.updateMany({ where: { id: tripId, liveRouteAckVersion: { lt: dto.routeVersion } }, data: { liveRouteAckVersion: dto.routeVersion } });
      await recordTripEvent(tx, ctx, { tripId, providerCompanyId: tt.providerCompanyId, customerCompanyId: tt.customerCompanyId, kind: 'ROUTE_ACK', actorType: 'DRIVER', source: 'DRIVER_APP', clientEventId: dto.clientEventId, data: { routeVersion: dto.routeVersion, driverId: me.id } });
    });
    const after = await this.prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId }, select: { liveRouteVersion: true, liveRouteAckVersion: true } });
    return { tripId, routeVersion: after.liveRouteVersion, acknowledgedVersion: after.liveRouteAckVersion, pending: after.liveRouteAckVersion < after.liveRouteVersion };
  }

  /** System Health: last worker pass, queued / failed requests. */
  async healthState(): Promise<{ lastOkAt: number | null; queued: number; oldestQueuedAt: number | null; failed: number }> {
    const raw = await this.redis.client.get(LIVE_DISPATCH_STATE_KEY).catch(() => null);
    const at = raw ? Number((JSON.parse(raw) as { at?: unknown }).at) || null : null;
    const [queued, oldest, failed] = await Promise.all([
      this.prisma.transportDispatchRequest.count({ where: { status: 'QUEUED' } }),
      this.prisma.transportDispatchRequest.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.transportDispatchRequest.count({ where: { status: 'FAILED', attempts: { gte: MAX_ATTEMPTS }, createdAt: { gt: new Date(Date.now() - 24 * H) } } }),
    ]);
    return { lastOkAt: at, queued, oldestQueuedAt: oldest?.createdAt.getTime() ?? null, failed };
  }
}
