import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  ACTIVE_TRIP_STATUSES_FOR_OVERLAP,
  ROUTE_LIMITS,
  TRANSPORT_E3_LIMITS,
  type ChangeSetResult,
  type DispatchBoardDto,
  type DispatchCandidateDto,
  type DispatchCandidatesDto,
  type DispatchChangeOp,
  type DispatchChangeSetInput,
  type DispatchStopInput,
  type DispatchVehicleDto,
  type EtaValue,
  type PlannedTripOrigin,
  type PlannedTripStatus,
  type RepeatTransportTripResult,
  type TransportBookingStatus,
  type TransportChangeSetDetailDto,
  type TransportChangeSetSummaryDto,
} from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { driverScopeWhere } from '../../drivers/drivers.service';
import { buildTripSnapshot } from '../../planned-trips/snapshot';
import { lockTripResources } from '../../planned-trips/trip-locks';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { RoutingService } from '../../routing/routing.service';
import { haversineMeters } from '../../tracking/geo';
import { parseLive } from '../../tracking/live-object';
import { addDays, localDayRange } from '../../summarizer/tz';
import { FixedWindowLimiter } from '../directory/lookup-rate-limit';
import { activeRoutingConsents } from '../people/people.service';
import { UNSEATED_STATUSES } from './booking-generator.service';
import { BOOKING_ENTITY, type Replayable } from './bookings.service';
import { adhocStops, parseChangeOps } from './change-ops';
import { changeSetDetail } from './change-set-detail';
import {
  assertBookingAccess,
  assertTripWrite,
  bookingReadWhere,
  conflict,
  constraintOf,
  dateOnly,
  dayKeyOf,
  e3Error,
  forbidden,
  inProfileBranch,
  idempotencyKey,
  idempotencyReused,
  invalid,
  isUniqueViolation,
  notFound,
  parseInstant,
  profileBranchWhere,
  requestHash,
  serviceDate,
  sqlState,
  tripReadWhere,
  versionConflict,
} from './e3-common';
import { BOOKING_INCLUDE, TRIP_INCLUDE, preciseFor, toBookingDto, toTripSummary, type TripNames } from './e3-mapping';
import { metres, PERSONAL_STOP_NAME, recordPersonalAccess, stopOwner } from './personal-points';
import { BoardQuery, CandidatesDto, ChangeSetDto, ChangeSetListQuery, RepeatTripDto } from './e3.dto';
import { dayRange, sameWallTime, weekdayOf } from './service-dates';
import { TripLiveService } from './trip-live';
import { lockBookings, lockTrips, recordTripEvent } from './trip-ops';

export const TRIP_ENTITY = 'TransportTrip';
const ACTIVE = [...ACTIVE_TRIP_STATUSES_FOR_OVERLAP] as PlannedTripStatus[];
const MIN = 60_000;

/** Prepared CREATE_TRIP (everything that needs no lock: snapshot / path computed before the transaction). */
interface PreparedTrip {
  op: Extract<DispatchChangeOp, { op: 'CREATE_TRIP' }>;
  name: string;
  routeId: string | null;
  corridorM: number;
  path: unknown;
  stops: { seq: number; name: string; lat: number; lng: number; radiusM: number; plannedArrival: Date; plannedDeparture: Date; poiId?: string | null; profileId?: string | null }[];
  plannedStart: Date;
  plannedEnd: Date;
}

/**
 * Candidates wait at most this long for all their road ETAs together (QA B3 / R1): the ETAs are asked for in parallel
 * and any that has not answered by then is null with "routing unavailable" — a slow engine never holds the search.
 */
export const CANDIDATE_ETA_BUDGET_MS = 2_500;

/**
 * A company place an ad-hoc stop may claim must be within this distance of the place's own point (m), and the place
 * must exist before the change set (security re-check N5): a place created to cover a home cannot be claimed by a draft
 * saved earlier, and the point must essentially be the place (the web sends the place's own coordinates).
 */
const PLACE_MATCH_M = 25;

/** The planned stop a TRIP candidate's road ETA starts from. */
interface FromStop {
  seq: number;
  lat: number;
  lng: number;
  departure: Date;
  d: number;
}

interface StopState {
  id: string;
  seq: number;
  lat: number;
  lng: number;
  plannedArrival: Date;
  plannedDeparture: Date;
}

const stopIdMap = (stops: StopState[]) => new Map(stops.map((s) => [s.seq, { id: s.id, plannedArrival: s.plannedArrival }]));
const toStopState = (s: { id: string; seq: number; lat: number; lng: number; plannedArrival: Date; plannedDeparture: Date }): StopState => ({ id: s.id, seq: s.seq, lat: s.lat, lng: s.lng, plannedArrival: s.plannedArrival, plannedDeparture: s.plannedDeparture });

/** Default planned arrival of an inserted stop: between its neighbours; 10 min before the first / after the last. */
export function insertedArrival(prev: Pick<StopState, 'plannedDeparture'> | undefined, next: Pick<StopState, 'plannedArrival'> | undefined): Date {
  if (prev && next) return new Date(Math.round((prev.plannedDeparture.getTime() + next.plannedArrival.getTime()) / 2 / 1000) * 1000);
  if (prev) return new Date(prev.plannedDeparture.getTime() + 10 * MIN);
  return new Date(next!.plannedArrival.getTime() - 10 * MIN);
}

/** The booking's point for one end of an ADD_STOP (null when it has none). */
function bookingEnd(b: { pickupLat: number | null; pickupLng: number | null; pickupLabel: string | null; dropLat: number | null; dropLng: number | null; dropLabel: string | null }, end: 'PICKUP' | 'DROP') {
  const [lat, lng, label] = end === 'PICKUP' ? [b.pickupLat, b.pickupLng, b.pickupLabel] : [b.dropLat, b.dropLng, b.dropLabel];
  return lat === null || lng === null ? null : { lat, lng, label };
}

/** In-transaction state of one trip touched by the change set. */
interface TripState {
  id: string;
  plannedTripId: string;
  objectId: string;
  driverId: string | null;
  plannedStart: Date;
  plannedEnd: Date;
  status: PlannedTripStatus;
  seatCapacity: number;
  occupied: number;
  stopIds: Map<number, { id: string; plannedArrival: Date }>;
  /** Planned stops in seq order (ADD_STOP inserts here and rebuilds stopIds). */
  stops: StopState[];
  /** ADD_STOP ran on this trip: its path is replaced after the loop. */
  stopsAdded: number;
  version: number;
  created: boolean;
  tempId?: string;
  providerCompanyId: string;
  customerCompanyId: string | null;
}

/**
 * Dispatch (05 §2.6, 02 §5.4, 15 §8; 12 WP 3.4): the board read model, candidates (seats; road ETA only when routing
 * answers, never invented), and change sets published atomically into PlannedTrip (origin ETMS) + TransportTrip +
 * TransportTripPassenger with the integrity rules of 15 §8.1. Repeat-to-date makes server-held DRAFT change sets that
 * are validated again on publish. R1 is corporate-managed: everything happens in the caller's own company.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger('EtmsDispatch');
  private readonly candidateLimiter: FixedWindowLimiter;
  private readonly changeSetLimiter: FixedWindowLimiter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly routing: RoutingService,
    private readonly live: TripLiveService,
    private readonly redis: RedisService,
  ) {
    // L4: GraphHopper amplification — per-user throttles on the two routing entry points.
    this.candidateLimiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:rl:candidates', TRANSPORT_E3_LIMITS.candidatesPerMinute, 60_000);
    this.changeSetLimiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:rl:change-sets', TRANSPORT_E3_LIMITS.changeSetsPerMinute, 60_000);
  }

  /** L1: ACCESS-audit a read that returned passengers' personal points (de-duplicated per user, view and day). */
  recordPersonalAccess(ctx: AuthContext, view: 'board' | 'trip' | 'candidates', profileIds: string[], precise: boolean, extra: Record<string, unknown> = {}): Promise<void> {
    return recordPersonalAccess(this.audit, this.redis, ctx, view, profileIds, precise, extra);
  }

  /**
   * QA B2: routing is "available" only when it is configured AND the engine answers its health probe (GraphHopper
   * /health through map-services: 2 s timeout, result reused 10 s). Otherwise the board and the ETAs say "routing
   * unavailable" instead of "no road route".
   */
  private async routingUp(): Promise<boolean> {
    const r = this.routing as RoutingService & { available?: () => Promise<boolean> };
    if (!r.enabled) return false;
    return typeof r.available === 'function' ? r.available().catch(() => false) : true;
  }

  private async throttle(limiter: FixedWindowLimiter, ctx: AuthContext, what: string): Promise<void> {
    const rl = await limiter.hit(ctx.userId);
    if (!rl.allowed) throw e3Error(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `Too many ${what}; try again in ${rl.retryAfterSec} s`, { retryAfterSec: rl.retryAfterSec });
  }

  // ───────────────────────────── Board ─────────────────────────────

  async board(ctx: AuthContext, q: BoardQuery): Promise<DispatchBoardDto> {
    const day = serviceDate(q.serviceDate);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const bookingFilters: Prisma.TransportBookingWhereInput[] = [bookingReadWhere(ctx), { serviceDate: dateOnly(day) }];
    if (q.direction) bookingFilters.push({ direction: q.direction });
    if (q.shiftId) bookingFilters.push({ shiftId: q.shiftId });
    if (q.siteId) bookingFilters.push({ OR: [{ pickupPoiId: q.siteId }, { dropPoiId: q.siteId }] });
    const objectIds = await this.scopedObjectIds(ctx);
    const tripFilters: Prisma.TransportTripWhereInput[] = [tripReadWhere(ctx, objectIds), { serviceDate: dateOnly(day) }];
    if (q.direction) tripFilters.push({ direction: q.direction });
    if (q.shiftId) tripFilters.push({ shiftId: q.shiftId });
    if (q.siteId) tripFilters.push({ sitePoiId: q.siteId });
    const [queue, assigned, total, trips, drafts] = await Promise.all([
      this.prisma.transportBooking.findMany({ where: { AND: [...bookingFilters, { status: { in: [...UNSEATED_STATUSES] } }] }, orderBy: [{ windowStart: 'asc' }, { id: 'asc' }], take: 1000, include: BOOKING_INCLUDE }),
      this.prisma.transportBooking.count({ where: { AND: [...bookingFilters, { status: { in: ['ASSIGNED', 'CONFIRMED'] } }] } }),
      this.prisma.transportBooking.count({ where: { AND: bookingFilters } }),
      this.prisma.transportTrip.findMany({ where: { AND: tripFilters }, orderBy: [{ createdAt: 'asc' }], take: 500, include: TRIP_INCLUDE }),
      this.prisma.transportChangeSet.findMany({ where: { companyId: ctx.companyId, serviceDate: dateOnly(day), status: 'DRAFT', ...(q.direction ? { direction: q.direction } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    const names = await this.names(trips.map((t) => t.plannedTrip));
    const vehicles = await this.vehicles(ctx, day, company.timezone);
    // The board is the dispatcher's working view: personal pickup / drop points only while the passenger's routing
    // consent is active (E2 M3: dispatcher pickup only with consent); sites always.
    const consents = await this.consents(queue.map((b) => b.profileId));
    const now = Date.now();
    const queueDtos = queue.map((b) => toBookingDto(b, ctx, { view: 'detail', consent: consents.has(b.profileId) }, now));
    // L1: the board returns personal points in bulk (exact for whole-company roles): one ACCESS entry per day and set.
    const shown = queueDtos.filter((b) => (b.pickup && !b.pickup.poiId) || (b.drop && !b.drop.poiId)).map((b) => b.passenger.id);
    await this.recordPersonalAccess(ctx, 'board', shown, preciseFor(ctx, ctx.companyId), { serviceDate: day });
    return {
      serviceDate: day,
      direction: q.direction ?? null,
      timeZone: company.timezone,
      queue: queueDtos,
      trips: trips.map((t) => toTripSummary(t, names)),
      vehicles,
      // M6 / L7: a branch-scoped dispatcher sees only the drafts whose every vehicle, trip and passenger is in scope.
      drafts: (await this.visibleDrafts(ctx, drafts, objectIds)).map(toChangeSetSummary),
      counts: {
        bookings: total,
        queued: queue.length,
        assigned,
        trips: trips.length,
        seats: trips.reduce((s, t) => s + t.seatCapacity, 0),
        occupied: trips.reduce((s, t) => s + t.occupiedSeats, 0),
      },
      routingAvailable: await this.routingUp(),
    };
  }

  /** Vehicles of the caller's scope with seats, busy windows (any origin) on the local service day and last fix. */
  private async vehicles(ctx: AuthContext, day: string, tz: string): Promise<DispatchVehicleDto[]> {
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), { isActive: true }] },
      select: { id: true, name: true, plateNumber: true, transportProfile: { select: { seats: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    if (!objects.length) return [];
    const range = localDayRange(day, tz);
    const [busy, fixes] = await Promise.all([
      this.prisma.plannedTrip.findMany({
        where: { objectId: { in: objects.map((o) => o.id) }, status: { in: ACTIVE }, plannedStart: { lt: new Date(range.end + 6 * 60 * MIN) }, plannedEnd: { gt: new Date(range.start - 6 * 60 * MIN) } },
        select: { id: true, objectId: true, origin: true, plannedStart: true, plannedEnd: true, status: true },
        orderBy: { plannedStart: 'asc' },
      }),
      this.fixes(objects.map((o) => o.id)),
    ]);
    return objects.map((o) => ({
      objectId: o.id,
      name: o.name,
      plateNumber: o.plateNumber,
      seats: o.transportProfile?.seats ?? null,
      busy: busy.filter((b) => b.objectId === o.id).map((b) => ({ plannedTripId: b.id, origin: b.origin as PlannedTripOrigin, plannedStart: b.plannedStart.toISOString(), plannedEnd: b.plannedEnd.toISOString(), status: b.status as PlannedTripStatus })),
      lastFix: fixes.get(o.id) ?? null,
    }));
  }

  /** Last known fixes from the live cache (vt:live:<objectId>). */
  private async fixes(objectIds: string[]): Promise<Map<string, { lat: number; lng: number; at: string }>> {
    const out = new Map<string, { lat: number; lng: number; at: string }>();
    if (!objectIds.length) return out;
    const raw = await this.redis.client.mget(...objectIds.map((id) => RedisKeys.live(id))).catch(() => [] as (string | null)[]);
    objectIds.forEach((id, i) => {
      const live = parseLive(raw?.[i] ?? null);
      if (live && live.lat !== null && live.lng !== null) out.set(id, { lat: live.lat, lng: live.lng, at: live.fixTime ?? live.serverTime ?? new Date(0).toISOString() });
    });
    return out;
  }

  // ───────────────────────────── Candidates ─────────────────────────────

  /**
   * Nearest feasible trips / vehicles for some bookings (assisted assignment). Ranked by feasibility, then straight-line
   * distance to the first pickup. A road ETA (GraphHopper via RoutingService) is attached to the closest few only when
   * routing answers; otherwise `eta.at` is null with the degraded reason and the dispatcher assigns manually.
   */
  async candidates(ctx: AuthContext, dto: CandidatesDto): Promise<DispatchCandidatesDto> {
    await this.throttle(this.candidateLimiter, ctx, 'candidate searches');
    const ids = [...new Set(dto.bookingIds)];
    const bookings = await this.prisma.transportBooking.findMany({ where: { AND: [bookingReadWhere(ctx), { id: { in: ids }, customerCompanyId: ctx.companyId }] }, include: { profile: { select: { branchId: true } } } });
    if (bookings.length !== ids.length) throw notFound('Booking not found');
    const day = dayKeyOf(bookings[0].serviceDate);
    const direction = bookings[0].direction;
    if (bookings.some((b) => dayKeyOf(b.serviceDate) !== day || b.direction !== direction)) throw invalid('Choose bookings of one service date and direction');
    const consents = await this.consents(bookings.map((b) => b.profileId));
    const bookingReasons = new Set<string>();
    for (const b of bookings) {
      if (b.status !== 'PENDING_ASSIGNMENT') bookingReasons.add('INVALID_STATE');
      if (b.pickupLat === null || b.dropLat === null) bookingReasons.add('NEEDS_LOCATION');
      if (!consents.has(b.profileId)) bookingReasons.add('CONSENT_REQUIRED');
    }
    const seatsNeeded = bookings.reduce((s, b) => s + b.passengerCount, 0);
    // A personal pickup is used for distances / routing only with consent (D8; E2 M3); a site pickup always.
    const first = bookings.filter((b) => b.pickupLat !== null && (b.pickupPoiId || consents.has(b.profileId))).sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime())[0];
    const pickup = first ? { lat: first.pickupLat as number, lng: first.pickupLng as number } : null;
    // L1: distances / road ETAs are computed from a consented personal pickup: an ACCESS entry like the board's.
    if (first && !first.pickupPoiId) await this.recordPersonalAccess(ctx, 'candidates', [first.profileId], preciseFor(ctx, ctx.companyId), { bookingIds: ids.slice(0, 50) });
    const winStart = dto.at ? parseInstant(dto.at, 'at') : Math.min(...bookings.map((b) => b.windowStart.getTime()));
    const winEnd = Math.max(winStart + MIN, ...bookings.map((b) => b.windowEnd.getTime()));

    const objectIds = await this.scopedObjectIds(ctx);
    const trips = await this.prisma.transportTrip.findMany({
      where: { AND: [tripReadWhere(ctx, objectIds), { serviceDate: dateOnly(day), direction, providerCompanyId: ctx.companyId, plannedTrip: { status: 'SCHEDULED' } }] },
      include: TRIP_INCLUDE,
      take: 200,
    });
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), { isActive: true }] },
      select: { id: true, name: true, plateNumber: true, transportProfile: { select: { seats: true } } },
      take: 500,
    });
    const busy = await this.prisma.plannedTrip.findMany({
      where: { objectId: { in: objects.map((o) => o.id) }, status: { in: ACTIVE }, plannedStart: { lt: new Date(winEnd) }, plannedEnd: { gt: new Date(winStart) } },
      select: { objectId: true },
    });
    const busyIds = new Set(busy.map((b) => b.objectId));
    const fixes = await this.fixes(objects.map((o) => o.id));
    const objById = new Map(objects.map((o) => [o.id, o]));
    const out: (DispatchCandidateDto & { fix: { lat: number; lng: number } | null; fromStop: FromStop | null })[] = [];

    for (const t of trips) {
      const pt = t.plannedTrip;
      if (!pt || pt.status !== 'SCHEDULED') continue;
      const o = objById.get(pt.objectId);
      const free = t.seatCapacity - t.occupiedSeats;
      const reasons = [...bookingReasons];
      if (free < seatsNeeded) reasons.push('CAPACITY');
      let nearest: DispatchCandidateDto['nearestStop'] = null;
      let fromStop: FromStop | null = null;
      if (pickup) {
        for (const s of pt.stops) {
          const d = Math.round(haversineMeters(pickup.lat, pickup.lng, s.lat, s.lng));
          if (!nearest || d < nearest.straightM) nearest = { seq: s.seq, label: s.name, straightM: d };
        }
        // Road ETA start: the closest stop the vehicle passes before the pickup would be inserted (never the last one).
        const before = pt.stops.length > 1 ? pt.stops.slice(0, -1) : pt.stops;
        for (const s of before) {
          const d = haversineMeters(pickup.lat, pickup.lng, s.lat, s.lng);
          if (!fromStop || d < fromStop.d) fromStop = { seq: s.seq, lat: s.lat, lng: s.lng, departure: s.plannedDeparture, d };
        }
      }
      out.push({
        kind: 'TRIP',
        tripId: t.id,
        objectId: pt.objectId,
        vehicleName: o?.name ?? pt.routeName,
        plateNumber: o?.plateNumber ?? null,
        seatCapacity: t.seatCapacity,
        freeSeats: Math.max(0, free),
        feasible: reasons.length === 0,
        nearestStop: nearest,
        straightM: nearest?.straightM ?? null,
        eta: { at: null, model: null },
        reasons,
        fix: fixes.get(pt.objectId) ?? null,
        fromStop,
      });
    }
    for (const o of objects) {
      if (busyIds.has(o.id)) continue;
      const seats = o.transportProfile?.seats ?? null;
      const reasons = [...bookingReasons];
      if (seats === null) reasons.push('NO_SEATS_SET');
      else if (seats < seatsNeeded) reasons.push('CAPACITY');
      const fix = fixes.get(o.id) ?? null;
      out.push({
        kind: 'VEHICLE',
        tripId: null,
        objectId: o.id,
        vehicleName: o.name,
        plateNumber: o.plateNumber,
        seatCapacity: seats,
        freeSeats: seats ?? 0,
        feasible: reasons.length === 0,
        nearestStop: null,
        straightM: fix && pickup ? Math.round(haversineMeters(pickup.lat, pickup.lng, fix.lat, fix.lng)) : null,
        eta: { at: null, model: null },
        reasons,
        fix,
        fromStop: null,
      });
    }
    out.sort((a, b) => Number(b.feasible) - Number(a.feasible) || (a.straightM ?? Infinity) - (b.straightM ?? Infinity) || b.freeSeats - a.freeSeats);

    const routingAvailable = await this.routingUp();
    // QA R1: the closest feasible few get a road ETA, computed in parallel under one overall budget (an ETA still
    // running when it ends is "routing unavailable"). Which candidates compute is decided in rank order first.
    let etaBudget = 5;
    const plan = out.map((c) => ({ c, compute: c.feasible && etaBudget-- > 0 }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'TIMEOUT'>((resolve) => (timer = setTimeout(() => resolve('TIMEOUT'), CANDIDATE_ETA_BUDGET_MS)));
    try {
      await Promise.all(
        plan.map(async ({ c, compute }) => {
          c.eta = c.kind === 'TRIP' ? await this.etaFromStop(c.fromStop, pickup, routingAvailable, compute, budget) : await this.etaTo(c.fix, pickup, routingAvailable, compute, budget);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    return {
      bookingIds: ids,
      seatsNeeded,
      candidates: out.slice(0, 50).map(({ fix: _fix, fromStop: _from, ...c }) => c),
      routingAvailable,
      degraded: routingAvailable ? null : 'ROUTING_UNAVAILABLE',
    };
  }

  /** Road ETA from the idle vehicle's fix to the pickup, from now, or null with the reason (never a straight-line guess). */
  private async etaTo(fix: { lat: number; lng: number } | null, pickup: { lat: number; lng: number } | null, routingAvailable: boolean, compute: boolean, budget: Promise<'TIMEOUT'>): Promise<EtaValue> {
    if (!routingAvailable) return { at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' };
    if (!pickup) return { at: null, model: null, degraded: 'NO_PICKUP' };
    if (!fix) return { at: null, model: null, degraded: 'NO_FIX' };
    if (!compute) return { at: null, model: null };
    const r = await this.routeQuickly(fix, pickup, budget);
    if (r === 'UNAVAILABLE') return { at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' };
    if (r === 'NO_ROUTE') return { at: null, model: null, degraded: 'NO_ROUTE' };
    return { at: new Date(Date.now() + r.s * 1000).toISOString(), model: 'ROAD', durationSec: Math.round(r.s), from: 'VEHICLE_FIX' };
  }

  /**
   * TRIP candidates (E3 gap 4): road time from the trip's planned stop before the insertion point to the pickup, added
   * to that stop's planned departure (the trip has not started, so the vehicle's live position says nothing). A road
   * estimate without live traffic (RoutingService / GraphHopper); null with the reason when routing does not answer.
   */
  private async etaFromStop(from: FromStop | null, pickup: { lat: number; lng: number } | null, routingAvailable: boolean, compute: boolean, budget: Promise<'TIMEOUT'>): Promise<EtaValue> {
    if (!routingAvailable) return { at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' };
    if (!pickup || !from) return { at: null, model: null, degraded: 'NO_PICKUP' };
    if (!compute) return { at: null, model: null };
    const r = await this.routeQuickly({ lat: from.lat, lng: from.lng }, pickup, budget);
    if (r === 'UNAVAILABLE') return { at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' };
    if (r === 'NO_ROUTE') return { at: null, model: null, degraded: 'NO_ROUTE' };
    return { at: new Date(from.departure.getTime() + r.s * 1000).toISOString(), model: 'ROAD', durationSec: Math.round(r.s), from: 'TRIP_STOP', fromStopSeq: from.seq };
  }

  /**
   * One road route for a candidate ETA, raced against the search's overall budget (QA B3 / R1). 'NO_ROUTE' only when
   * the engine answered that there is none; a timeout, an error or the budget running out is 'UNAVAILABLE' (QA R2).
   */
  private async routeQuickly(from: { lat: number; lng: number }, to: { lat: number; lng: number }, budget: Promise<'TIMEOUT'>): Promise<{ s: number } | 'NO_ROUTE' | 'UNAVAILABLE'> {
    const r = await Promise.race([this.routing.routeStatus(from, to).catch(() => 'UNAVAILABLE' as const), budget]);
    return r === 'TIMEOUT' ? 'UNAVAILABLE' : r;
  }

  // ───────────────────────────── Change sets ─────────────────────────────

  async submit(ctx: AuthContext, dto: ChangeSetDto, rawKey: string | undefined): Promise<Replayable<ChangeSetResult>> {
    const input: DispatchChangeSetInput = { serviceDate: serviceDate(dto.serviceDate), direction: dto.direction, changes: parseChangeOps(dto.changes), expectedVersions: dto.expectedVersions ?? {}, reason: dto.reason };
    await this.throttle(this.changeSetLimiter, ctx, 'change sets');
    if (dto.draft) return { value: await this.saveDraft(ctx, input, null), replay: false };
    const key = idempotencyKey(rawKey);
    return this.publishWithKey(ctx, input, key, null);
  }

  async listChangeSets(ctx: AuthContext, q: ChangeSetListQuery): Promise<TransportChangeSetSummaryDto[]> {
    const rows = await this.prisma.transportChangeSet.findMany({
      where: { companyId: ctx.companyId, ...(q.serviceDate ? { serviceDate: dateOnly(serviceDate(q.serviceDate)) } : {}), status: q.status ?? 'DRAFT' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return (await this.visibleDrafts(ctx, rows, await this.scopedObjectIds(ctx))).map(toChangeSetSummary);
  }

  /** One saved change set with its changes and names (E3 gap 2; dispatcher-scoped, see change-set-detail.ts). */
  async changeSet(ctx: AuthContext, id: string): Promise<TransportChangeSetDetailDto> {
    return changeSetDetail(this.prisma, ctx, id, toChangeSetSummary, await this.scopedObjectIds(ctx));
  }

  /** Publish a server-held DRAFT (repeat-to-date): validated again exactly like a fresh change set. */
  async publishDraft(ctx: AuthContext, id: string, rawKey: string | undefined): Promise<Replayable<ChangeSetResult>> {
    const key = idempotencyKey(rawKey);
    const row = await this.prisma.transportChangeSet.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw notFound();
    // M6 / L3: the caller must be allowed to see this change set before anything (a replay included) is returned.
    await this.assertDraftAccess(ctx, row);
    if (row.status === 'PUBLISHED' && row.idempotencyKey === key && row.result) return { value: row.result as unknown as ChangeSetResult, replay: true };
    if (row.status !== 'DRAFT' || !row.draft) throw conflict('INVALID_STATE', 'Only a draft can be published');
    const draft = row.draft as unknown as DispatchChangeSetInput;
    const input: DispatchChangeSetInput = { serviceDate: serviceDate(draft.serviceDate), direction: draft.direction, changes: parseChangeOps(draft.changes as unknown[]), expectedVersions: draft.expectedVersions ?? {}, reason: draft.reason };
    return this.publishWithKey(ctx, input, key, row.id, row.createdAt);
  }

  /** Discard a draft (kept in the ledger as REJECTED, its pickup points cleared). */
  async rejectDraft(ctx: AuthContext, id: string): Promise<TransportChangeSetSummaryDto> {
    const row = await this.prisma.transportChangeSet.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw notFound();
    await this.assertDraftAccess(ctx, row);
    if (row.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Only a draft can be discarded');
    const after = await this.prisma.transportChangeSet.update({ where: { id }, data: { status: 'REJECTED', draft: Prisma.DbNull, result: { discardedBy: ctx.userId, changeCount: draftChanges(row.draft).length } as Prisma.InputJsonValue } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'TransportChangeSet', entityId: id, details: { discarded: true } });
    return toChangeSetSummary(after);
  }

  /** L6: drafts are capped per company and date and audited (they hold stop coordinates). */
  private async saveDraft(ctx: AuthContext, input: DispatchChangeSetInput, sourceTripId: string | null, audit = true): Promise<ChangeSetResult> {
    // Security re-check N1: a draft is scope-checked like a publish (404, nothing stored) before it is counted or saved.
    await this.assertChangeSetScope(ctx, input.changes);
    const open = await this.prisma.transportChangeSet.count({ where: { companyId: ctx.companyId, serviceDate: dateOnly(input.serviceDate), status: 'DRAFT' } });
    if (open >= TRANSPORT_E3_LIMITS.draftsPerServiceDate) throw conflict('INVALID_STATE', `${input.serviceDate} already has ${open} drafts; publish or discard some first`);
    const row = await this.prisma.transportChangeSet.create({
      data: { companyId: ctx.companyId, status: 'DRAFT', serviceDate: dateOnly(input.serviceDate), direction: input.direction, draft: { ...input, sourceTripId } as unknown as Prisma.InputJsonValue, createdById: ctx.userId },
    });
    // Coordinates are not copied into the audit: the draft row holds them (and is cleared on publish / discard / erasure).
    if (audit) await this.audit.record(ctx, { action: 'CREATE', entity: 'TransportChangeSet', entityId: row.id, details: { draft: true, serviceDate: input.serviceDate, direction: input.direction, changes: input.changes.length, sourceTripId } });
    return { changeSetId: row.id, status: 'DRAFT', trips: [], bookings: [], warnings: [] };
  }

  /**
   * M6 / L7: the change sets a caller may see. Whole-company roles: all of the company's. Branch-scoped dispatchers:
   * their own, and those whose every vehicle, trip and passenger is in their scope (the change-set detail rule).
   */
  private async visibleDrafts<T extends { id: string; draft: Prisma.JsonValue | null; createdById: string | null }>(ctx: AuthContext, rows: T[], objectIds: string[] | null): Promise<T[]> {
    if (ctx.dataScope === 'COMPANY' || objectIds === null || !rows.length) return rows;
    const refs = new Map<string, { objects: string[]; bookings: string[]; trips: string[]; seats: string[] } | null>();
    for (const r of rows) {
      try {
        const ops = parseChangeOps(draftChanges(r.draft));
        refs.set(r.id, {
          objects: ops.flatMap((o) => (o.op === 'CREATE_TRIP' || o.op === 'REASSIGN_VEHICLE' ? [o.objectId] : [])),
          bookings: ops.flatMap((o) => (o.op === 'ADD_PASSENGER' || o.op === 'ADD_STOP' ? [o.bookingId] : [])),
          trips: ops.flatMap((o) => ('tripId' in o && /^[0-9a-f-]{36}$/i.test(o.tripId) ? [o.tripId] : [])),
          seats: ops.flatMap((o) => (o.op === 'REMOVE_PASSENGER' ? [o.passengerTripId] : [])),
        });
      } catch {
        refs.set(r.id, null); // unreadable draft: only its creator sees it
      }
    }
    const all = [...refs.values()].filter((x): x is NonNullable<typeof x> => !!x);
    const bookingIds = [...new Set(all.flatMap((x) => x.bookings))];
    const tripIds = [...new Set(all.flatMap((x) => x.trips))];
    const seatIds = [...new Set(all.flatMap((x) => x.seats))];
    const [bookings, trips, seats] = await Promise.all([
      bookingIds.length ? this.prisma.transportBooking.findMany({ where: { id: { in: bookingIds }, customerCompanyId: ctx.companyId }, select: { id: true, profile: { select: { branchId: true } } } }) : [],
      tripIds.length ? this.prisma.transportTrip.findMany({ where: { id: { in: tripIds }, providerCompanyId: ctx.companyId }, select: { id: true, plannedTrip: { select: { objectId: true } } } }) : [],
      seatIds.length ? this.prisma.transportTripPassenger.findMany({ where: { id: { in: seatIds }, providerCompanyId: ctx.companyId }, select: { id: true, booking: { select: { profile: { select: { branchId: true } } } } } }) : [],
    ]);
    const okBooking = new Set(bookings.filter((b) => inProfileBranch(ctx, b.profile?.branchId)).map((b) => b.id));
    const okTrip = new Set(trips.filter((t) => !!t.plannedTrip && objectIds.includes(t.plannedTrip.objectId)).map((t) => t.id));
    const okSeat = new Set(seats.filter((s) => inProfileBranch(ctx, s.booking?.profile?.branchId)).map((s) => s.id));
    return rows.filter((r) => {
      if (r.createdById && r.createdById === ctx.userId) return true;
      // Security re-check N3: a published / discarded row keeps no changes to judge by: its creator only.
      if (!r.draft) return false;
      const x = refs.get(r.id);
      if (!x) return false;
      return x.objects.every((o) => objectIds.includes(o)) && x.bookings.every((b) => okBooking.has(b)) && x.trips.every((t) => okTrip.has(t)) && x.seats.every((s) => okSeat.has(s));
    });
  }

  /** M6: 404 unless the caller may see this change set (visibleDrafts rule). */
  private async assertDraftAccess(ctx: AuthContext, row: { id: string; draft: Prisma.JsonValue | null; createdById: string | null; status: string }): Promise<void> {
    if (ctx.dataScope === 'COMPANY') return;
    // A published / discarded row has no draft left to judge by: only its creator may act on it.
    if (row.status !== 'DRAFT' || !row.draft) {
      if (row.createdById !== ctx.userId) throw notFound();
      return;
    }
    if (!(await this.visibleDrafts(ctx, [row], await this.scopedObjectIds(ctx))).length) throw notFound();
  }

  private async publishWithKey(ctx: AuthContext, input: DispatchChangeSetInput, key: string, draftId: string | null, draftCreatedAt: Date | null = null): Promise<Replayable<ChangeSetResult>> {
    const hash = requestHash({ ...input, draftId });
    const prior = await this.prisma.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key } });
    if (prior) {
      // L3: a key replays only for the user who used it (another user's key is a reuse, never their result).
      if (prior.requestHash !== hash || (!draftId && prior.createdById !== ctx.userId)) throw idempotencyReused();
      if (prior.status === 'PUBLISHED' && prior.result) return { value: prior.result as unknown as ChangeSetResult, replay: true };
    }
    try {
      const { result, plannedTripIds, toRoute } = await this.apply(ctx, input, key, hash, draftId, draftCreatedAt);
      await this.live.changed(ctx.companyId, plannedTripIds);
      // QA B3 (02 §5.4): publish never waits for routing; road paths are added after the commit.
      this.routeInBackground(ctx.companyId, toRoute);
      return { value: result, replay: false };
    } catch (e) {
      if (e instanceof KeyCommitted || isUniqueViolation(e, 'idempotencyKey')) {
        const winner = await this.prisma.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key } });
        if (winner?.requestHash === hash && winner.result && (draftId || winner.createdById === ctx.userId)) return { value: winner.result as unknown as ChangeSetResult, replay: true };
        throw idempotencyReused();
      }
      throw mapDbError(e);
    }
  }

  /** Prepare the CREATE_TRIP ops (route snapshot or ad-hoc stops + optional road path) before taking any lock. */
  private async prepareTrips(ctx: AuthContext, input: DispatchChangeSetInput, asOf: Date | null = null): Promise<Map<string, PreparedTrip>> {
    const out = new Map<string, PreparedTrip>();
    // Stops that claim a company place: the place must be the company's and the point at it (else it is a personal point).
    const poiIds = [...new Set(input.changes.flatMap((o) => (o.op === 'CREATE_TRIP' && o.stops ? o.stops.flatMap((s) => (s.point.poiId ? [s.point.poiId] : [])) : [])))];
    const places = new Map((poiIds.length ? await this.prisma.poi.findMany({ where: { id: { in: poiIds }, companyId: ctx.companyId }, select: { id: true, lat: true, lng: true, createdAt: true } }) : []).map((p) => [p.id, p]));
    for (const op of input.changes) {
      if (op.op !== 'CREATE_TRIP') continue;
      const startMs = Date.parse(op.plannedStart);
      let p: PreparedTrip;
      if (op.routeId) {
        const route = await this.prisma.route.findFirst({
          where: { id: op.routeId, companyId: ctx.companyId, isActive: true, ...(ctx.dataScope === 'COMPANY' ? {} : { OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] }) },
          include: { stops: { orderBy: { seq: 'asc' } } },
        });
        if (!route) throw notFound('Route not found');
        if (route.stops.length < ROUTE_LIMITS.minStops) throw invalid('The route has fewer than 2 stops');
        const snap = buildTripSnapshot(route, startMs);
        p = { op, name: op.name ?? snap.routeName, routeId: route.id, corridorM: op.corridorM ?? snap.corridorM, path: snap.path, stops: snap.stops, plannedStart: snap.plannedStart, plannedEnd: snap.plannedEnd };
      } else {
        const given = op.stops as DispatchStopInput[];
        const stops = adhocStops(given).map((s, i) => {
          const poiId = given[i].point.poiId ?? null;
          if (!poiId) return { ...s, poiId: null };
          const place = places.get(poiId);
          // Another tenant's (or an unknown) place is a 404 like any foreign id (05 §1); a place far from the point is a 400.
          if (!place) throw notFound('Place not found');
          if (asOf && place.createdAt && place.createdAt.getTime() > asOf.getTime()) throw invalid(`Stop ${s.seq + 1} names a place created after this change set was saved`);
          if (metres(place, s) > PLACE_MATCH_M) throw invalid(`Stop ${s.seq + 1} is not at the company place it names`);
          return { ...s, poiId };
        });
        if (Math.abs(stops[0].plannedArrival.getTime() - startMs) > 60 * MIN) throw invalid('The first stop must be planned within an hour of the trip start');
        if (stops[stops.length - 1].plannedArrival.getTime() - startMs > 24 * 60 * MIN) throw invalid('A trip can last at most 24 hours');
        // The road path is computed after the commit (routeInBackground): publish never waits for routing (QA B3).
        p = {
          op,
          name: op.name ?? `Transport ${input.serviceDate} ${input.direction === 'IN' ? 'login' : 'logout'}`,
          routeId: null,
          corridorM: op.corridorM ?? ROUTE_LIMITS.corridorDefaultM,
          path: null,
          stops,
          plannedStart: new Date(Math.min(startMs, stops[0].plannedArrival.getTime())),
          plannedEnd: stops[stops.length - 1].plannedArrival,
        };
      }
      const day = Date.parse(`${input.serviceDate}T00:00:00Z`);
      if (p.plannedStart.getTime() < day - 36 * 60 * MIN || p.plannedStart.getTime() > day + 60 * 60 * MIN) throw invalid('The trip start must be on (or next to) the service date');
      out.set(op.tempId, p);
    }
    return out;
  }

  /**
   * QA B1 / M6 / N1: the branch-scope checks of a change set, run before anything is written — by publish (then
   * re-checked on the locked rows inside the transaction) and by a draft save, so a draft can never name a vehicle,
   * driver, route, booking, seat or trip outside the caller's scope (404, nothing stored). Returns what publish needs.
   */
  private async assertChangeSetScope(ctx: AuthContext, ops: DispatchChangeOp[]) {
    const tempIds = new Set(ops.flatMap((o) => (o.op === 'CREATE_TRIP' ? [o.tempId] : [])));
    // A shuttle route of another branch is a 404 (prepareTrips repeats this for publish).
    const routeIds = [...new Set(ops.flatMap((o) => (o.op === 'CREATE_TRIP' && o.routeId ? [o.routeId] : [])))];
    if (routeIds.length) {
      const routes = await this.prisma.route.findMany({
        where: { id: { in: routeIds }, companyId: ctx.companyId, isActive: true, ...(ctx.dataScope === 'COMPANY' ? {} : { OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] }) },
        select: { id: true },
      });
      if (routes.length !== routeIds.length) throw notFound('Route not found');
    }
    const newObjectIds = ops.flatMap((o) => (o.op === 'CREATE_TRIP' || o.op === 'REASSIGN_VEHICLE' ? [o.objectId] : []));
    const newDriverIds = ops.flatMap((o) => ((o.op === 'CREATE_TRIP' || o.op === 'REASSIGN_DRIVER') && o.driverId ? [o.driverId] : []));
    const vehicles = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), { id: { in: newObjectIds }, isActive: true }] },
      select: { id: true, branchId: true, companyId: true, transportProfile: { select: { seats: true } } },
    });
    const vehicleById = new Map(vehicles.filter((v) => v.companyId === ctx.companyId).map((v) => [v.id, v]));
    // Other tenants' (or out-of-scope) ids are 404, never a hint that they exist (05 §1).
    for (const id of newObjectIds) if (!vehicleById.has(id)) throw notFound('Vehicle not found');
    const drivers = newDriverIds.length ? await this.prisma.driver.findMany({ where: { AND: [driverScopeWhere(ctx), { id: { in: newDriverIds }, isActive: true }] }, select: { id: true } }) : [];
    const driverOk = new Set(drivers.map((d) => d.id));
    for (const id of newDriverIds) if (!driverOk.has(id)) throw notFound('Driver not found');

    // Existing trips touched: by id, or through a passenger row.
    const removeIds = ops.flatMap((o) => (o.op === 'REMOVE_PASSENGER' ? [o.passengerTripId] : []));
    const removedRows = removeIds.length ? await this.prisma.transportTripPassenger.findMany({ where: { id: { in: removeIds }, providerCompanyId: ctx.companyId } }) : [];
    if (removedRows.length !== new Set(removeIds).size) throw notFound('Passenger not found on a trip');
    // QA B1 / M6: every booking the change set names (ADD_PASSENGER, ADD_STOP, and the seats REMOVE_PASSENGER frees)
    // must be the caller's own company's and in the caller's branches — checked first, so an out-of-scope id is a 404
    // before any other rule could answer about it (re-checked on the locked rows inside the transaction).
    const namedBookingIds = [...new Set([...ops.flatMap((o) => (o.op === 'ADD_PASSENGER' || o.op === 'ADD_STOP' ? [o.bookingId] : [])), ...removedRows.map((r) => r.bookingId)])];
    const named = namedBookingIds.length ? await this.prisma.transportBooking.findMany({ where: { id: { in: namedBookingIds } }, select: { id: true, customerCompanyId: true, providerCompanyId: true, profile: { select: { branchId: true } } } }) : [];
    for (const id of namedBookingIds) {
      const b = named.find((x) => x.id === id);
      if (!b || b.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
      assertBookingAccess(ctx, b, 'write');
    }
    const existingTripIds = [
      ...new Set([
        ...ops.flatMap((o) => ('tripId' in o && !tempIds.has(o.tripId) ? [o.tripId] : [])),
        ...removedRows.map((r) => r.tripId),
      ]),
    ];
    const objectIds = await this.scopedObjectIds(ctx);
    const visibleTrips = existingTripIds.length ? await this.prisma.transportTrip.findMany({ where: { AND: [tripReadWhere(ctx, objectIds), { id: { in: existingTripIds } }] }, include: { plannedTrip: { select: { objectId: true, driverId: true } } } }) : [];
    if (visibleTrips.length !== existingTripIds.length) throw notFound('Trip not found');
    // The vehicle scope repeated in code (never only through a relation filter): a trip of another branch's van is a 404.
    for (const t of visibleTrips) if (objectIds !== null && (!t.plannedTrip || !objectIds.includes(t.plannedTrip.objectId))) throw notFound('Trip not found');
    for (const t of visibleTrips) assertTripWrite(ctx, t);
    return { newObjectIds, newDriverIds, vehicleById, removedRows, existingTripIds, visibleTrips };
  }

  /**
   * The publish transaction (02 §5.4, 15 §8.4): advisory locks per vehicle / driver (sorted), bookings FOR UPDATE,
   * trips FOR UPDATE + expectedVersion, then each change in order with its rule checks; finally versions, audit and the
   * TransportChangeSet ledger row. The DB constraints (partial uniques, capacity CHECK, ETMS EXCLUDE) back every check.
   */
  private async apply(ctx: AuthContext, input: DispatchChangeSetInput, key: string, hash: string, draftId: string | null, draftCreatedAt: Date | null = null): Promise<{ result: ChangeSetResult; plannedTripIds: string[]; toRoute: string[] }> {
    const ops = input.changes;
    const prepared = await this.prepareTrips(ctx, input, draftCreatedAt);
    const { newObjectIds, newDriverIds, vehicleById, removedRows, existingTripIds, visibleTrips } = await this.assertChangeSetScope(ctx, ops);
    for (const id of existingTripIds) {
      if (input.expectedVersions?.[id] === undefined) throw invalid(`expectedVersions must give the version of trip ${id}`);
    }
    const bookingIds = ops.flatMap((o) => (o.op === 'ADD_PASSENGER' || o.op === 'ADD_STOP' ? [o.bookingId] : []));
    const now = new Date();
    // QA B1: the change set's id, known up front, on every trip event of this publish so the notification relay can
    // group one change set (receivedAt differs per row by a few ms).
    const changeSetId = draftId ?? randomUUID();

    return this.prisma.$transaction(
      async (tx) => {
        // 1. Advisory locks: new and current vehicles / drivers (sorted inside lockTripResources).
        await lockTripResources(tx, {
          objectIds: [...newObjectIds, ...visibleTrips.map((t) => t.plannedTrip?.objectId)],
          driverIds: [...newDriverIds, ...visibleTrips.map((t) => t.plannedTrip?.driverId)],
        });
        // Harness HD2: a parallel request with the same Idempotency-Key that committed while this one waited for the locks
        // is replayed (publishWithKey), never answered with the 409 its own trips now cause.
        const committed = await tx.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key }, select: { id: true } });
        if (committed) throw new KeyCommitted();
        // 2. Bookings (added or freed), then 3. trips — FOR UPDATE, sorted.
        await lockBookings(tx, [...bookingIds, ...removedRows.map((r) => r.bookingId)]);
        await lockTrips(tx, existingTripIds);
        const bookings = new Map(
          (await tx.transportBooking.findMany({ where: { id: { in: [...bookingIds, ...removedRows.map((r) => r.bookingId)] } }, include: { profile: { select: { branchId: true } } } })).map((b) => [b.id, b]),
        );
        // L9: consent read after the bookings are locked, inside the transaction: a withdrawal that commits first is seen.
        const consents = await activeRoutingConsents(tx, [...bookings.values()].map((b) => b.profileId));
        const state = new Map<string, TripState>();
        for (const id of existingTripIds) {
          const t = await tx.transportTrip.findUniqueOrThrow({ where: { id }, include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } } } });
          if (t.version !== input.expectedVersions![id]) throw versionConflict(t.version);
          if (!t.plannedTrip) throw conflict('TRIP_CLOSED', 'This trip lost its planned trip (vehicle removed)');
          state.set(id, {
            id,
            plannedTripId: t.plannedTrip.id,
            objectId: t.plannedTrip.objectId,
            driverId: t.plannedTrip.driverId,
            plannedStart: t.plannedTrip.plannedStart,
            plannedEnd: t.plannedTrip.plannedEnd,
            status: t.plannedTrip.status as PlannedTripStatus,
            seatCapacity: t.seatCapacity,
            occupied: t.occupiedSeats,
            stopIds: new Map(t.plannedTrip.stops.map((s) => [s.seq, { id: s.id, plannedArrival: s.plannedArrival }])),
            stops: t.plannedTrip.stops.map(toStopState),
            stopsAdded: 0,
            version: t.version,
            created: false,
            providerCompanyId: t.providerCompanyId,
            customerCompanyId: t.customerCompanyId,
          });
        }
        const touched = new Set<string>();
        const bookingOut = new Map<string, { id: string; status: TransportBookingStatus; version: number }>();
        const warnings: string[] = [];
        const trip = (ref: string) => {
          const s = prepared.has(ref) ? [...state.values()].find((x) => x.tempId === ref) : state.get(ref);
          if (!s) throw notFound('Trip not found');
          return s;
        };
        const editable = (s: TripState) => {
          if (s.status !== 'SCHEDULED') throw conflict('TRIP_CLOSED', 'Only a trip that has not started can be changed');
        };

        for (const [i, op] of ops.entries()) {
          const n = i + 1;
          switch (op.op) {
            case 'CREATE_TRIP': {
              const p = prepared.get(op.tempId)!;
              const v = vehicleById.get(op.objectId)!;
              const seats = v.transportProfile?.seats ?? null;
              if (seats === null) throw conflict('NO_SEATS_SET', `Change ${n}: set the vehicle's passenger seats first`);
              const tripStops = op.routeId ? p.stops : this.linkPersonalStops(ctx, n, op.tempId, p.stops, ops, bookings, consents);
              await this.assertFree(tx, op.objectId, op.driverId ?? null, p.plannedStart, p.plannedEnd, null);
              const pt = await tx.plannedTrip.create({
                data: {
                  companyId: ctx.companyId,
                  branchId: v.branchId,
                  routeId: p.routeId,
                  origin: 'ETMS' satisfies PlannedTripOrigin,
                  objectId: op.objectId,
                  driverId: op.driverId ?? null,
                  routeName: p.name,
                  corridorM: p.corridorM,
                  path: p.path ? (p.path as Prisma.InputJsonValue) : Prisma.DbNull,
                  plannedStart: p.plannedStart,
                  plannedEnd: p.plannedEnd,
                  nextStopSeq: 0,
                  createdById: ctx.userId,
                  stops: { create: tripStops },
                },
                include: { stops: true },
              });
              const header = await tx.transportTrip.create({
                data: {
                  plannedTripId: pt.id,
                  providerCompanyId: ctx.companyId,
                  customerCompanyId: ctx.companyId,
                  serviceDate: dateOnly(input.serviceDate),
                  direction: input.direction,
                  shiftId: op.shiftId ? await this.ownShift(tx, ctx, op.shiftId) : null,
                  sitePoiId: op.sitePoiId ? await this.ownPlace(tx, ctx, op.sitePoiId) : null,
                  seatCapacity: seats,
                  publishedAt: now,
                  createdById: ctx.userId,
                },
              });
              state.set(header.id, {
                id: header.id,
                plannedTripId: pt.id,
                objectId: op.objectId,
                driverId: op.driverId ?? null,
                plannedStart: p.plannedStart,
                plannedEnd: p.plannedEnd,
                status: 'SCHEDULED',
                seatCapacity: seats,
                occupied: 0,
                stopIds: new Map(pt.stops.map((s) => [s.seq, { id: s.id, plannedArrival: s.plannedArrival }])),
                stops: [...pt.stops].sort((a, b) => a.seq - b.seq).map(toStopState),
                stopsAdded: 0,
                version: 1,
                created: true,
                tempId: op.tempId,
                providerCompanyId: ctx.companyId,
                customerCompanyId: ctx.companyId,
              });
              await recordTripEvent(tx, ctx, { tripId: header.id, providerCompanyId: ctx.companyId, customerCompanyId: ctx.companyId, kind: 'PUBLISHED', data: { changeSetId, objectId: op.objectId, driverId: op.driverId ?? null, routeId: p.routeId, stops: p.stops.length } });
              break;
            }
            case 'ADD_PASSENGER': {
              const s = trip(op.tripId);
              editable(s);
              const b = bookings.get(op.bookingId);
              // M6: own company and the caller's branches (a branch-B booking is a 404 for a branch-A dispatcher).
              if (!b || b.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
              assertBookingAccess(ctx, b, 'write');
              if (b.status !== 'PENDING_ASSIGNMENT') throw conflict('INVALID_STATE', `Change ${n}: only a booking waiting for a seat can be assigned (it is ${b.status})`);
              if (dayKeyOf(b.serviceDate) !== input.serviceDate || b.direction !== input.direction) throw invalid(`Change ${n}: the booking is for another date or direction`);
              if (b.pickupLat === null || b.dropLat === null) throw conflict('NEEDS_LOCATION', `Change ${n}: the booking has no pickup or drop point`);
              // No pickup without consent (D8, 10 §4.2): the TRANSPORT_PROFILE consent must be active now.
              if (!consents.has(b.profileId)) throw forbidden('CONSENT_REQUIRED', `Change ${n}: the passenger has not consented to transport data use`);
              const pick = s.stopIds.get(op.pickupSeq);
              const drop = s.stopIds.get(op.dropSeq);
              if (!pick || !drop) throw invalid(`Change ${n}: pickup / drop stop not on the trip`);
              if (s.occupied + b.passengerCount > s.seatCapacity) throw conflict('CAPACITY_EXCEEDED', `Change ${n}: not enough free seats (${s.seatCapacity - s.occupied} left)`);
              const row = await tx.transportTripPassenger.create({
                data: { tripId: s.id, bookingId: b.id, customerCompanyId: b.customerCompanyId, providerCompanyId: s.providerCompanyId, pickupStopId: pick.id, dropStopId: drop.id, pickupSeq: op.pickupSeq, dropSeq: op.dropSeq, seats: b.passengerCount },
              });
              await tx.transportTrip.update({ where: { id: s.id }, data: { occupiedSeats: { increment: b.passengerCount } } });
              s.occupied += b.passengerCount;
              const claimed = await tx.transportBooking.updateMany({ where: { id: b.id, status: 'PENDING_ASSIGNMENT' }, data: { status: 'ASSIGNED', providerCompanyId: s.providerCompanyId, statusReason: null, version: { increment: 1 } } });
              if (!claimed.count) throw conflict('INVALID_STATE', `Change ${n}: the booking changed meanwhile`);
              b.status = 'ASSIGNED';
              b.version += 1;
              bookingOut.set(b.id, { id: b.id, status: 'ASSIGNED', version: b.version });
              const at = pick.plannedArrival.getTime();
              if (input.direction === 'IN' ? drop.plannedArrival.getTime() > b.windowEnd.getTime() : at < b.windowStart.getTime()) {
                warnings.push(`Booking ${b.id}: the planned ${input.direction === 'IN' ? 'arrival' : 'pickup'} is outside its window`);
              }
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'PASSENGER_ADDED', passengerTripId: row.id, stopSeq: op.pickupSeq, data: { changeSetId, bookingId: b.id, seats: b.passengerCount } });
              touched.add(s.id);
              break;
            }
            case 'ADD_STOP': {
              const s = trip(op.tripId);
              editable(s);
              if (s.created) throw invalid(`Change ${n}: give a new trip's stops in its CREATE_TRIP`);
              const b = bookings.get(op.bookingId);
              if (!b || b.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
              assertBookingAccess(ctx, b, 'write');
              if (b.status !== 'PENDING_ASSIGNMENT') throw conflict('INVALID_STATE', `Change ${n}: only a booking waiting for a seat gets a new stop (it is ${b.status})`);
              if (dayKeyOf(b.serviceDate) !== input.serviceDate || b.direction !== input.direction) throw invalid(`Change ${n}: the booking is for another date or direction`);
              const point = bookingEnd(b, op.end);
              if (!point) throw conflict('NEEDS_LOCATION', `Change ${n}: the booking has no ${op.end === 'PICKUP' ? 'pickup' : 'drop'} point`);
              // No pickup without consent (D8, 10 §4.2; E2 final consent model).
              if (!consents.has(b.profileId)) throw forbidden('CONSENT_REQUIRED', `Change ${n}: the passenger has not consented to transport data use`);
              // Capacity: a stop is only worth adding when the booking still fits (the ADD_PASSENGER after it takes the seat).
              if (s.occupied + b.passengerCount > s.seatCapacity) throw conflict('CAPACITY_EXCEEDED', `Change ${n}: not enough free seats (${s.seatCapacity - s.occupied} left)`);
              if (s.stops.length >= TRANSPORT_E3_LIMITS.maxStops) throw conflict('INVALID_STATE', `Change ${n}: the trip has the maximum of ${TRANSPORT_E3_LIMITS.maxStops} stops`);
              const last = s.stops.length - 1;
              if (op.afterSeq > last) throw invalid(`Change ${n}: afterSeq must be -1..${last}`);
              const prev = op.afterSeq >= 0 ? s.stops[op.afterSeq] : undefined;
              const next = s.stops[op.afterSeq + 1];
              const arrival = op.plannedArrival ? new Date(op.plannedArrival) : insertedArrival(prev, next);
              const departure = new Date(arrival.getTime() + (op.waitMin ?? 0) * MIN);
              if ((prev && arrival < prev.plannedArrival) || (next && departure > next.plannedArrival)) throw invalid(`Change ${n}: the new stop must be planned between its neighbouring stops`);
              // Overlap: a trip that now starts earlier / ends later must still be free for its vehicle and driver.
              const start = new Date(Math.min(s.plannedStart.getTime(), arrival.getTime()));
              const end = new Date(Math.max(s.plannedEnd.getTime(), arrival.getTime()));
              if (start < s.plannedStart || end > s.plannedEnd) {
                await this.assertFree(tx, s.objectId, s.driverId, start, end, s.plannedTripId);
                await tx.plannedTrip.update({ where: { id: s.plannedTripId }, data: { plannedStart: start, plannedEnd: end } });
                s.plannedStart = start;
                s.plannedEnd = end;
              }
              // Make room: later stops (highest first: unique tripId + seq), then seated passengers (drop before pickup: dropSeq > pickupSeq CHECK).
              for (const st of [...s.stops].filter((x) => x.seq > op.afterSeq).sort((a, b2) => b2.seq - a.seq)) {
                await tx.plannedTripStop.update({ where: { id: st.id }, data: { seq: st.seq + 1 } });
                st.seq += 1;
              }
              await tx.transportTripPassenger.updateMany({ where: { tripId: s.id, dropSeq: { gt: op.afterSeq } }, data: { dropSeq: { increment: 1 } } });
              await tx.transportTripPassenger.updateMany({ where: { tripId: s.id, pickupSeq: { gt: op.afterSeq } }, data: { pickupSeq: { increment: 1 } } });
              // A site end keeps the place's name; a personal end gets a neutral name and its owner (the v1.8 tracker, alerts
              // and reports read the name; the passenger's own label is shown only in the consent-checked transport views).
              const sitePoi = op.end === 'PICKUP' ? b.pickupPoiId : b.dropPoiId;
              const created = await tx.plannedTripStop.create({
                data: {
                  tripId: s.plannedTripId,
                  seq: op.afterSeq + 1,
                  name: sitePoi ? (point.label ?? '').trim() || 'Site' : PERSONAL_STOP_NAME[op.end],
                  lat: point.lat,
                  lng: point.lng,
                  radiusM: ROUTE_LIMITS.radiusDefaultM,
                  plannedArrival: arrival,
                  plannedDeparture: departure,
                  poiId: sitePoi ?? null,
                  profileId: sitePoi ? null : b.profileId,
                },
              });
              s.stops.splice(op.afterSeq + 1, 0, toStopState(created));
              s.stopIds = stopIdMap(s.stops);
              s.stopsAdded += 1;
              // No coordinates in the event (personal point): the stop row holds them.
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'STOP_ADDED', stopSeq: op.afterSeq + 1, data: { changeSetId, bookingId: b.id, end: op.end, plannedArrival: arrival.toISOString() } });
              touched.add(s.id);
              break;
            }
            case 'REMOVE_PASSENGER': {
              const r = removedRows.find((x) => x.id === op.passengerTripId)!;
              const s = trip(r.tripId);
              editable(s);
              assertBookingAccess(ctx, bookings.get(r.bookingId) ?? null, 'write');
              const done = await tx.transportTripPassenger.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelReason: op.reason } });
              if (!done.count) throw conflict('INVALID_STATE', `Change ${n}: the passenger's outcome is recorded or they were removed already`);
              await tx.transportTrip.update({ where: { id: s.id }, data: { occupiedSeats: { decrement: r.seats } } });
              s.occupied -= r.seats;
              const b = bookings.get(r.bookingId)!;
              const claimed = await tx.transportBooking.updateMany({ where: { id: b.id, status: { in: ['ASSIGNED', 'CONFIRMED'] } }, data: { status: 'PENDING_ASSIGNMENT', version: { increment: 1 } } });
              if (claimed.count) {
                b.status = 'PENDING_ASSIGNMENT';
                b.version += 1;
                bookingOut.set(b.id, { id: b.id, status: 'PENDING_ASSIGNMENT', version: b.version });
              }
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'PASSENGER_REMOVED', passengerTripId: r.id, reasonCode: 'DISPATCH', data: { changeSetId, bookingId: b.id, reason: op.reason } });
              touched.add(s.id);
              break;
            }
            case 'REASSIGN_VEHICLE': {
              const s = trip(op.tripId);
              editable(s);
              const v = vehicleById.get(op.objectId)!;
              const seats = v.transportProfile?.seats ?? null;
              if (seats === null) throw conflict('NO_SEATS_SET', `Change ${n}: set the vehicle's passenger seats first`);
              if (seats < s.occupied) throw conflict('CAPACITY_EXCEEDED', `Change ${n}: the vehicle has ${seats} seats for ${s.occupied} passengers`);
              await this.assertFree(tx, op.objectId, null, s.plannedStart, s.plannedEnd, s.plannedTripId);
              await tx.plannedTrip.update({ where: { id: s.plannedTripId }, data: { objectId: op.objectId, branchId: v.branchId } });
              await tx.transportTrip.update({ where: { id: s.id }, data: { seatCapacity: seats } });
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'VEHICLE_CHANGED', data: { changeSetId, from: s.objectId, to: op.objectId, seats } });
              s.objectId = op.objectId;
              s.seatCapacity = seats;
              touched.add(s.id);
              break;
            }
            case 'REASSIGN_DRIVER': {
              const s = trip(op.tripId);
              editable(s);
              if (op.driverId) await this.assertFree(tx, null, op.driverId, s.plannedStart, s.plannedEnd, s.plannedTripId);
              await tx.plannedTrip.update({ where: { id: s.plannedTripId }, data: { driverId: op.driverId } });
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'DRIVER_CHANGED', data: { changeSetId, from: s.driverId, to: op.driverId } });
              s.driverId = op.driverId;
              touched.add(s.id);
              break;
            }
          }
        }

        // ADD_STOP: the old path no longer runs through every stop: cleared now (never a stale one), re-routed after commit.
        for (const s of state.values()) {
          if (!s.stopsAdded) continue;
          await tx.plannedTrip.update({ where: { id: s.plannedTripId }, data: { path: Prisma.DbNull } });
        }
        // Trips that need a road path (new door-to-door trips, trips with new stops), within the routing budget (L4).
        const wanted = [...state.values()].filter((s) => (s.created && prepared.get(s.tempId!)?.routeId === null) || s.stopsAdded).map((s) => s.plannedTripId);
        const routed = this.routingBudget(wanted, warnings);
        // Versions: every existing trip touched + 1 (re-publish, 02 §5.4); new trips stay at 1.
        for (const id of touched) {
          const s = state.get(id)!;
          if (s.created) continue;
          await tx.transportTrip.update({ where: { id }, data: { version: { increment: 1 }, publishedAt: now } });
          s.version += 1;
        }
        for (const s of state.values()) {
          if (s.created) await this.audit.record(ctx, { action: 'CREATE', entity: TRIP_ENTITY, entityId: s.id, after: { plannedTripId: s.plannedTripId, objectId: s.objectId, driverId: s.driverId, seatCapacity: s.seatCapacity, occupiedSeats: s.occupied, serviceDate: input.serviceDate, direction: input.direction } }, tx);
          else if (touched.has(s.id)) await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: s.id, after: { objectId: s.objectId, driverId: s.driverId, seatCapacity: s.seatCapacity, occupiedSeats: s.occupied, version: s.version, ...(s.stopsAdded ? { stops: s.stops.length, stopsAdded: s.stopsAdded, plannedStart: s.plannedStart.toISOString(), plannedEnd: s.plannedEnd.toISOString() } : {}) } }, tx);
        }
        for (const b of bookingOut.values()) {
          await this.audit.record(ctx, { action: 'UPDATE', entity: BOOKING_ENTITY, entityId: b.id, details: { dispatch: true, status: b.status, version: b.version } }, tx);
        }
        const trips = [...state.values()].filter((s) => s.created || touched.has(s.id)).map((s) => ({ id: s.id, plannedTripId: s.plannedTripId, version: s.version, ...(s.tempId ? { tempId: s.tempId } : {}) }));
        const result: ChangeSetResult = { changeSetId: '', status: 'PUBLISHED', trips, bookings: [...bookingOut.values()], warnings };
        const ledger = draftId
          ? await tx.transportChangeSet.update({ where: { id: draftId }, data: { status: 'PUBLISHED', idempotencyKey: key, requestHash: hash, draft: Prisma.DbNull, publishedAt: now } })
          : await tx.transportChangeSet.create({ data: { id: changeSetId, companyId: ctx.companyId, idempotencyKey: key, requestHash: hash, status: 'PUBLISHED', serviceDate: dateOnly(input.serviceDate), direction: input.direction, createdById: ctx.userId, publishedAt: now } });
        result.changeSetId = ledger.id;
        await tx.transportChangeSet.update({ where: { id: ledger.id }, data: { result: result as unknown as Prisma.InputJsonValue } });
        return { result, plannedTripIds: [...state.values()].map((s) => s.plannedTripId), toRoute: routed };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  /**
   * L4: at most routingCallsPerChangeSet trips of one change set are road-routed; the others are saved without a path
   * and a warning says so. Returns the planned-trip ids to route.
   */
  private routingBudget(plannedTripIds: string[], warnings: string[]): string[] {
    if (!this.routing.enabled) return [];
    const max = TRANSPORT_E3_LIMITS.routingCallsPerChangeSet;
    if (plannedTripIds.length > max) warnings.push(`${plannedTripIds.length - max} trip(s) saved without a road path (at most ${max} routed trips per change set)`);
    return plannedTripIds.slice(0, max);
  }

  /**
   * QA B3 (02 §5.4): road paths of just-published trips, after the commit (publish never waits for routing). Each trip
   * is routed through its stops as they are now; the path is written only if the stops did not change meanwhile and
   * the trip has not started. Best effort: a slow or failed engine leaves the path empty (never a stale one).
   */
  routeInBackground(companyId: string, plannedTripIds: string[]): Promise<void> {
    if (!plannedTripIds.length || !this.routing.enabled) return Promise.resolve();
    const sig = (stops: { id: string; seq: number; lat: number; lng: number }[]) => stops.map((s) => `${s.id}:${s.seq}:${s.lat},${s.lng}`).join('|');
    return (async () => {
      const done: string[] = [];
      for (const id of plannedTripIds) {
        try {
          const pt = await this.prisma.plannedTrip.findFirst({ where: { id, companyId, status: 'SCHEDULED' }, include: { stops: { orderBy: { seq: 'asc' } } } });
          if (!pt || pt.stops.length < 2) continue;
          const stops = [...pt.stops].sort((a, b) => a.seq - b.seq);
          const before = sig(stops);
          const road = await this.routing.routeVia(stops.map((s) => ({ lat: s.lat, lng: s.lng }))).catch(() => null);
          if (!road?.path) continue;
          // Re-check and write in ONE transaction under the trip locks (security re-check N1): the header FOR UPDATE (as a
          // publish / consent withdrawal takes it) and the PlannedTrip row FOR UPDATE (as erasure's path clear takes it).
          // A withdrawal or erasure still open makes this wait; afterwards the stops differ and the path is not written,
          // so a path through a withdrawn / erased home can never come back.
          const written = await this.prisma.$transaction(async (tx) => {
            const header = await tx.transportTrip.findFirst({ where: { plannedTripId: id }, select: { id: true } });
            if (header) await lockTrips(tx, [header.id]);
            await tx.$queryRaw`SELECT id FROM "PlannedTrip" WHERE id = ${id}::uuid FOR UPDATE`;
            const now = await tx.plannedTripStop.findMany({ where: { tripId: id }, orderBy: { seq: 'asc' } });
            if (sig([...now].sort((a, b) => a.seq - b.seq)) !== before) return false; // changed meanwhile: its own change re-routes
            const w = await tx.plannedTrip.updateMany({ where: { id, status: 'SCHEDULED' }, data: { path: road.path as unknown as Prisma.InputJsonValue } });
            return w.count > 0;
          });
          if (written) done.push(id);
        } catch (error) {
          this.logger.warn(`Road path of planned trip ${id} not computed: ${(error as Error).message}`);
        }
      }
      if (done.length) await this.live.changed(companyId, done);
    })();
  }

  /**
   * M2 (E3 security review): the stops of a new door-to-door trip that are not company places are personal points.
   * Each must be the pickup / drop of a passenger seated by this change set (ADD_PASSENGER on this trip at that seq, or
   * a booking end within personalStopMatchM of it) whose routing consent is active now; otherwise 403 CONSENT_REQUIRED
   * (e.g. a repeat draft still carrying the home of someone who withdrew). The stop is stored with its owner and a
   * neutral name.
   */
  private linkPersonalStops(
    ctx: AuthContext,
    n: number,
    tempId: string,
    stops: PreparedTrip['stops'],
    ops: DispatchChangeOp[],
    bookings: Map<string, { id: string; profileId: string; customerCompanyId: string; pickupLat: number | null; pickupLng: number | null; pickupPoiId: string | null; dropLat: number | null; dropLng: number | null; dropPoiId: string | null }>,
    consents: Set<string>,
  ): PreparedTrip['stops'] {
    const adds = ops.filter((o): o is Extract<DispatchChangeOp, { op: 'ADD_PASSENGER' }> => o.op === 'ADD_PASSENGER' && o.tripId === tempId);
    const ends = adds.flatMap((a) => {
      const b = bookings.get(a.bookingId);
      if (!b || b.customerCompanyId !== ctx.companyId || !consents.has(b.profileId)) return [];
      const out: { seq: number; end: 'PICKUP' | 'DROP'; profileId: string; lat: number; lng: number }[] = [];
      if (b.pickupLat !== null && b.pickupLng !== null && !b.pickupPoiId) out.push({ seq: a.pickupSeq, end: 'PICKUP', profileId: b.profileId, lat: b.pickupLat, lng: b.pickupLng });
      if (b.dropLat !== null && b.dropLng !== null && !b.dropPoiId) out.push({ seq: a.dropSeq, end: 'DROP', profileId: b.profileId, lat: b.dropLat, lng: b.dropLng });
      return out;
    });
    return stops.map((s) => {
      if (s.poiId) return { ...s, profileId: null };
      const near = ends.filter((e) => metres(e, s) <= TRANSPORT_E3_LIMITS.personalStopMatchM);
      const match = near.find((e) => e.seq === s.seq) ?? near[0];
      if (!match) {
        // The passenger seated at this seq has no point here: the ADD_PASSENGER's own refusal is the clearer answer.
        const seated = adds.map((a) => ({ a, b: bookings.get(a.bookingId) })).find(({ a, b }) => b && (a.pickupSeq === s.seq ? b.pickupLat === null : a.dropSeq === s.seq ? b.dropLat === null : false));
        if (seated) throw conflict('NEEDS_LOCATION', `Change ${n}: the booking seated at stop ${s.seq + 1} has no pickup or drop point`);
      }
      if (!match) throw forbidden('CONSENT_REQUIRED', `Change ${n}: stop ${s.seq + 1} is not a company place and is not the pickup or drop of a consenting passenger added in this change set`);
      return { ...s, name: PERSONAL_STOP_NAME[match.end], profileId: match.profileId, poiId: null };
    });
  }

  /** No overlapping active planned trip (any origin) for the vehicle / driver in [start, end) (409 VEHICLE_BUSY / DRIVER_BUSY). */
  private async assertFree(tx: Prisma.TransactionClient, objectId: string | null, driverId: string | null, start: Date, end: Date, exceptPlannedTripId: string | null): Promise<void> {
    const base = { status: { in: ACTIVE }, plannedStart: { lt: end }, plannedEnd: { gt: start }, ...(exceptPlannedTripId ? { id: { not: exceptPlannedTripId } } : {}) };
    if (objectId) {
      const hit = await tx.plannedTrip.findFirst({ where: { ...base, objectId }, select: { routeName: true, plannedStart: true } });
      if (hit) throw conflict('VEHICLE_BUSY', `The vehicle is already planned on "${hit.routeName}" at that time`);
    }
    if (driverId) {
      const hit = await tx.plannedTrip.findFirst({ where: { ...base, driverId }, select: { routeName: true } });
      if (hit) throw conflict('DRIVER_BUSY', `The driver is already planned on "${hit.routeName}" at that time`);
    }
  }

  // ───────────────────────────── Repeat to date ─────────────────────────────

  /**
   * Copy a trip's assignment to later service dates as DRAFT change sets (P2 "repeat to date"): same vehicle, driver
   * and stops at the same local wall time, and the same passengers where they have an unseated booking that day.
   * Nothing is published: each draft is validated again when the dispatcher publishes it.
   */
  async repeat(ctx: AuthContext, tripId: string, dto: RepeatTripDto): Promise<RepeatTransportTripResult> {
    const objectIds = await this.scopedObjectIds(ctx);
    const t = await this.prisma.transportTrip.findFirst({
      where: { AND: [tripReadWhere(ctx, objectIds), { id: tripId }] },
      include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } }, passengers: { where: { status: { not: 'CANCELLED' } }, include: { booking: { select: { profileId: true, timeZone: true, pickupPoiId: true, dropPoiId: true } } } } },
    });
    if (!t) throw notFound();
    assertTripWrite(ctx, t);
    if (!t.plannedTrip) throw conflict('TRIP_CLOSED', 'This trip lost its planned trip (vehicle removed)');
    const from = dayKeyOf(t.serviceDate);
    const to = serviceDate(dto.toDate, 'toDate');
    if (to <= from || to > addDays(from, TRANSPORT_E3_LIMITS.repeatMaxDays)) throw invalid(`Repeat to a date after the trip, at most ${TRANSPORT_E3_LIMITS.repeatMaxDays} days ahead`);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const tz = t.passengers[0]?.booking.timeZone ?? company.timezone;
    const pt = t.plannedTrip;
    const days = dto.days ? new Set(dto.days) : null;
    const result: RepeatTransportTripResult = { drafts: [], skippedDates: [] };
    const branch = profileBranchWhere(ctx);
    for (const d of dayRange(addDays(from, 1), to)) {
      if (days && !days.has(weekdayOf(d))) continue;
      const found = await this.prisma.transportBooking.findMany({
        // N1: only bookings in the caller's branches are carried (the draft save below is scope-checked like a publish).
        where: { customerCompanyId: ctx.companyId, profileId: { in: t.passengers.map((p) => p.booking.profileId) }, serviceDate: dateOnly(d), direction: t.direction, status: 'PENDING_ASSIGNMENT', ...(branch ? { profile: branch } : {}) },
        select: { id: true, profileId: true, profile: { select: { branchId: true } } },
      });
      // M2: only passengers whose routing consent is active now are carried over; a personal stop nobody carried over
      // rides along is left out (never a home of someone who is not on the draft), and seqs are renumbered.
      const consenting = await this.consents(found.map((b) => b.profileId));
      // N1: the branch filter repeated in code (never only through a relation filter).
      const riders = found.filter((b) => consenting.has(b.profileId) && inProfileBranch(ctx, b.profile?.branchId));
      const routeTrip = !!pt.routeId;
      const keep = pt.stops.filter((s) => {
        const owner = stopOwner(s, t.passengers, routeTrip);
        return owner === null || (owner !== 'UNKNOWN' && riders.some((b) => b.profileId === owner));
      });
      const newSeq = new Map(keep.map((s, i) => [s.seq, i] as const));
      const carried = riders.filter((b) => {
        const src = t.passengers.find((p) => p.booking.profileId === b.profileId)!;
        return routeTrip || (newSeq.has(src.pickupSeq) && newSeq.has(src.dropSeq));
      });
      if (!carried.length || (!routeTrip && keep.length < ROUTE_LIMITS.minStops)) {
        result.skippedDates.push(d);
        continue;
      }
      const move = (ms: number) => new Date(sameWallTime(ms, tz, from, d)).toISOString();
      const create: DispatchChangeOp = {
        op: 'CREATE_TRIP',
        tempId: 'trip',
        objectId: pt.objectId,
        driverId: pt.driverId,
        plannedStart: move(pt.plannedStart.getTime()),
        shiftId: t.shiftId,
        sitePoiId: t.sitePoiId,
        corridorM: pt.corridorM,
        name: pt.routeName,
        ...(pt.routeId
          ? { routeId: pt.routeId }
          : {
              routeId: null,
              stops: keep.map((s) => ({
                seq: newSeq.get(s.seq)!,
                point: { lat: s.lat, lng: s.lng, label: s.name, poiId: s.poiId ?? null },
                plannedArrival: move(s.plannedArrival.getTime()),
                radiusM: s.radiusM,
                waitMin: Math.max(0, Math.round((s.plannedDeparture.getTime() - s.plannedArrival.getTime()) / MIN)),
              })),
            }),
      };
      const adds: DispatchChangeOp[] = carried.map((b) => {
        const src = t.passengers.find((p) => p.booking.profileId === b.profileId)!;
        return routeTrip
          ? { op: 'ADD_PASSENGER', tripId: 'trip', bookingId: b.id, pickupSeq: src.pickupSeq, dropSeq: src.dropSeq }
          : { op: 'ADD_PASSENGER', tripId: 'trip', bookingId: b.id, pickupSeq: newSeq.get(src.pickupSeq)!, dropSeq: newSeq.get(src.dropSeq)! };
      });
      const draft = await this.saveDraft(ctx, { serviceDate: d, direction: t.direction, changes: [create, ...adds], expectedVersions: {}, reason: `Repeat of trip ${t.id}` }, t.id, false);
      const have = new Set(carried.map((b) => b.profileId));
      result.drafts.push({ changeSetId: draft.changeSetId, serviceDate: d, passengers: carried.length, missingBookings: t.passengers.map((p) => p.booking.profileId).filter((id) => !have.has(id)) });
    }
    await this.audit.record(ctx, { action: 'CREATE', entity: 'TransportChangeSet', entityId: tripId, details: { repeat: { toDate: to, drafts: result.drafts.length, skippedDates: result.skippedDates.length } } });
    return result;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Vehicle ids an ASSIGNED user may dispatch (null = whole company). */
  async scopedObjectIds(ctx: AuthContext): Promise<string[] | null> {
    if (ctx.dataScope === 'COMPANY') return null;
    return (await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } })).map((o) => o.id);
  }

  async names(pts: ({ objectId: string; driverId: string | null } | null)[]): Promise<TripNames> {
    const objectIds = [...new Set(pts.flatMap((p) => (p ? [p.objectId] : [])))];
    const driverIds = [...new Set(pts.flatMap((p) => (p?.driverId ? [p.driverId] : [])))];
    const [objects, drivers] = await Promise.all([
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true, plateNumber: true } }) : [],
      driverIds.length ? this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true } }) : [],
    ]);
    return { vehicles: new Map(objects.map((o) => [o.id, { name: o.name, plateNumber: o.plateNumber }])), drivers: new Map(drivers.map((d) => [d.id, d.name])) };
  }

  /** Profiles whose routing consent is effective under the E2 final model (own channel or recorded offline consent). */
  private async consents(profileIds: string[]): Promise<Set<string>> {
    return activeRoutingConsents(this.prisma, profileIds);
  }

  private async ownShift(tx: Prisma.TransactionClient, ctx: AuthContext, id: string): Promise<string> {
    const s = await tx.transportShift.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true } });
    if (!s) throw invalid('Unknown shift');
    return s.id;
  }

  private async ownPlace(tx: Prisma.TransactionClient, ctx: AuthContext, id: string): Promise<string> {
    const p = await tx.poi.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true } });
    if (!p) throw invalid('Unknown place');
    return p.id;
  }
}

/** Thrown inside the publish transaction when the same Idempotency-Key committed meanwhile (HD2): replayed by the caller. */
class KeyCommitted extends Error {}

function draftChanges(json: Prisma.JsonValue | null): unknown[] {
  const c = (json as { changes?: unknown } | null)?.changes;
  return Array.isArray(c) ? c : [];
}

export function toChangeSetSummary(r: Prisma.TransportChangeSetGetPayload<object>): TransportChangeSetSummaryDto {
  const changes = draftChanges(r.draft) as { op?: string }[];
  const result = (r.result ?? null) as { trips?: unknown[]; bookings?: unknown[]; changeCount?: number } | null;
  return {
    id: r.id,
    status: r.status,
    serviceDate: dayKeyOf(r.serviceDate),
    direction: r.direction,
    changeCount: changes.length || (result?.changeCount ?? (result?.trips?.length ?? 0) + (result?.bookings?.length ?? 0)),
    passengerCount: changes.length ? changes.filter((c) => c.op === 'ADD_PASSENGER').length : (result?.bookings?.length ?? 0),
    sourceTripId: ((r.draft as { sourceTripId?: string } | null)?.sourceTripId as string | undefined) ?? null,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  };
}

/** Database backstops → the documented 409s (15 §8.1), when a race passes the transactional checks. */
export function mapDbError(e: unknown): unknown {
  const state = sqlState(e);
  const name = constraintOf(e) ?? '';
  if (state === '23P01' || name.includes('overlap_excl')) {
    return name.includes('driver') ? conflict('DRIVER_BUSY', 'The driver is already planned at that time') : conflict('VEHICLE_BUSY', 'The vehicle is already planned at that time');
  }
  if (name === 'TransportTrip_occupied_seats_check') return conflict('CAPACITY_EXCEEDED', 'Not enough free seats');
  if (isUniqueViolation(e, 'active_booking') || isUniqueViolation(e, 'bookingId')) return conflict('INVALID_STATE', 'The booking already has a seat');
  return e;
}
