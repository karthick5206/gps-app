import { Injectable } from '@nestjs/common';
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
import { activeRoutingConsents } from '../people/people.service';
import { UNSEATED_STATUSES } from './booking-generator.service';
import { BOOKING_ENTITY, type Replayable } from './bookings.service';
import { adhocStops, parseChangeOps } from './change-ops';
import { changeSetDetail } from './change-set-detail';
import {
  assertTripWrite,
  bookingReadWhere,
  conflict,
  constraintOf,
  dateOnly,
  dayKeyOf,
  forbidden,
  idempotencyKey,
  idempotencyReused,
  invalid,
  isUniqueViolation,
  notFound,
  parseInstant,
  requestHash,
  serviceDate,
  sqlState,
  tripReadWhere,
  versionConflict,
} from './e3-common';
import { BOOKING_INCLUDE, TRIP_INCLUDE, toBookingDto, toTripSummary, type TripNames } from './e3-mapping';
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
  stops: { seq: number; name: string; lat: number; lng: number; radiusM: number; plannedArrival: Date; plannedDeparture: Date }[];
  plannedStart: Date;
  plannedEnd: Date;
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly routing: RoutingService,
    private readonly live: TripLiveService,
    private readonly redis: RedisService,
  ) {}

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
    return {
      serviceDate: day,
      direction: q.direction ?? null,
      timeZone: company.timezone,
      queue: queue.map((b) => toBookingDto(b, ctx, { view: 'detail', consent: consents.has(b.profileId) }, now)),
      trips: trips.map((t) => toTripSummary(t, names)),
      vehicles,
      drafts: drafts.map(toChangeSetSummary),
      counts: {
        bookings: total,
        queued: queue.length,
        assigned,
        trips: trips.length,
        seats: trips.reduce((s, t) => s + t.seatCapacity, 0),
        occupied: trips.reduce((s, t) => s + t.occupiedSeats, 0),
      },
      routingAvailable: this.routing.enabled,
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

    const routingAvailable = this.routing.enabled;
    let etaBudget = 5;
    for (const c of out) {
      const compute = c.feasible && etaBudget-- > 0;
      c.eta = c.kind === 'TRIP' ? await this.etaFromStop(c.fromStop, pickup, routingAvailable, compute) : await this.etaTo(c.fix, pickup, routingAvailable, compute);
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
  private async etaTo(fix: { lat: number; lng: number } | null, pickup: { lat: number; lng: number } | null, routingAvailable: boolean, compute: boolean): Promise<EtaValue> {
    if (!routingAvailable) return { at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' };
    if (!pickup) return { at: null, model: null, degraded: 'NO_PICKUP' };
    if (!fix) return { at: null, model: null, degraded: 'NO_FIX' };
    if (!compute) return { at: null, model: null };
    const r = await this.routing.route(fix, pickup).catch(() => null);
    if (!r) return { at: null, model: null, degraded: 'NO_ROUTE' };
    return { at: new Date(Date.now() + r.s * 1000).toISOString(), model: 'ROAD', durationSec: Math.round(r.s), from: 'VEHICLE_FIX' };
  }

  /**
   * TRIP candidates (E3 gap 4): road time from the trip's planned stop before the insertion point to the pickup, added
   * to that stop's planned departure (the trip has not started, so the vehicle's live position says nothing). A road
   * estimate without live traffic (RoutingService / GraphHopper); null with the reason when routing does not answer.
   */
  private async etaFromStop(from: FromStop | null, pickup: { lat: number; lng: number } | null, routingAvailable: boolean, compute: boolean): Promise<EtaValue> {
    if (!routingAvailable) return { at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' };
    if (!pickup || !from) return { at: null, model: null, degraded: 'NO_PICKUP' };
    if (!compute) return { at: null, model: null };
    const r = await this.routing.route({ lat: from.lat, lng: from.lng }, pickup).catch(() => null);
    if (!r) return { at: null, model: null, degraded: 'NO_ROUTE' };
    return { at: new Date(from.departure.getTime() + r.s * 1000).toISOString(), model: 'ROAD', durationSec: Math.round(r.s), from: 'TRIP_STOP', fromStopSeq: from.seq };
  }

  // ───────────────────────────── Change sets ─────────────────────────────

  async submit(ctx: AuthContext, dto: ChangeSetDto, rawKey: string | undefined): Promise<Replayable<ChangeSetResult>> {
    const input: DispatchChangeSetInput = { serviceDate: serviceDate(dto.serviceDate), direction: dto.direction, changes: parseChangeOps(dto.changes), expectedVersions: dto.expectedVersions ?? {}, reason: dto.reason };
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
    return rows.map(toChangeSetSummary);
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
    if (row.status === 'PUBLISHED' && row.idempotencyKey === key && row.result) return { value: row.result as unknown as ChangeSetResult, replay: true };
    if (row.status !== 'DRAFT' || !row.draft) throw conflict('INVALID_STATE', 'Only a draft can be published');
    const draft = row.draft as unknown as DispatchChangeSetInput;
    const input: DispatchChangeSetInput = { serviceDate: serviceDate(draft.serviceDate), direction: draft.direction, changes: parseChangeOps(draft.changes as unknown[]), expectedVersions: draft.expectedVersions ?? {}, reason: draft.reason };
    return this.publishWithKey(ctx, input, key, row.id);
  }

  /** Discard a draft (kept in the ledger as REJECTED, its pickup points cleared). */
  async rejectDraft(ctx: AuthContext, id: string): Promise<TransportChangeSetSummaryDto> {
    const row = await this.prisma.transportChangeSet.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw notFound();
    if (row.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Only a draft can be discarded');
    const after = await this.prisma.transportChangeSet.update({ where: { id }, data: { status: 'REJECTED', draft: Prisma.DbNull, result: { discardedBy: ctx.userId, changeCount: draftChanges(row.draft).length } as Prisma.InputJsonValue } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'TransportChangeSet', entityId: id, details: { discarded: true } });
    return toChangeSetSummary(after);
  }

  private async saveDraft(ctx: AuthContext, input: DispatchChangeSetInput, sourceTripId: string | null): Promise<ChangeSetResult> {
    const row = await this.prisma.transportChangeSet.create({
      data: { companyId: ctx.companyId, status: 'DRAFT', serviceDate: dateOnly(input.serviceDate), direction: input.direction, draft: { ...input, sourceTripId } as unknown as Prisma.InputJsonValue, createdById: ctx.userId },
    });
    return { changeSetId: row.id, status: 'DRAFT', trips: [], bookings: [], warnings: [] };
  }

  private async publishWithKey(ctx: AuthContext, input: DispatchChangeSetInput, key: string, draftId: string | null): Promise<Replayable<ChangeSetResult>> {
    const hash = requestHash({ ...input, draftId });
    const prior = await this.prisma.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key } });
    if (prior) {
      if (prior.requestHash !== hash) throw idempotencyReused();
      if (prior.status === 'PUBLISHED' && prior.result) return { value: prior.result as unknown as ChangeSetResult, replay: true };
    }
    try {
      const { result, plannedTripIds } = await this.apply(ctx, input, key, hash, draftId);
      await this.live.changed(ctx.companyId, plannedTripIds);
      return { value: result, replay: false };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotencyKey')) {
        const winner = await this.prisma.transportChangeSet.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key } });
        if (winner?.requestHash === hash && winner.result) return { value: winner.result as unknown as ChangeSetResult, replay: true };
        throw idempotencyReused();
      }
      throw mapDbError(e);
    }
  }

  /** Prepare the CREATE_TRIP ops (route snapshot or ad-hoc stops + optional road path) before taking any lock. */
  private async prepareTrips(ctx: AuthContext, input: DispatchChangeSetInput): Promise<Map<string, PreparedTrip>> {
    const out = new Map<string, PreparedTrip>();
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
        const stops = adhocStops(op.stops as DispatchStopInput[]);
        if (Math.abs(stops[0].plannedArrival.getTime() - startMs) > 60 * MIN) throw invalid('The first stop must be planned within an hour of the trip start');
        if (stops[stops.length - 1].plannedArrival.getTime() - startMs > 24 * 60 * MIN) throw invalid('A trip can last at most 24 hours');
        const road = await this.routing.routeVia(stops.map((s) => ({ lat: s.lat, lng: s.lng }))).catch(() => null);
        p = {
          op,
          name: op.name ?? `Transport ${input.serviceDate} ${input.direction === 'IN' ? 'login' : 'logout'}`,
          routeId: null,
          corridorM: op.corridorM ?? ROUTE_LIMITS.corridorDefaultM,
          path: road?.path ?? null,
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
   * The publish transaction (02 §5.4, 15 §8.4): advisory locks per vehicle / driver (sorted), bookings FOR UPDATE,
   * trips FOR UPDATE + expectedVersion, then each change in order with its rule checks; finally versions, audit and the
   * TransportChangeSet ledger row. The DB constraints (partial uniques, capacity CHECK, ETMS EXCLUDE) back every check.
   */
  private async apply(ctx: AuthContext, input: DispatchChangeSetInput, key: string, hash: string, draftId: string | null): Promise<{ result: ChangeSetResult; plannedTripIds: string[] }> {
    const ops = input.changes;
    const prepared = await this.prepareTrips(ctx, input);
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
    const existingTripIds = [
      ...new Set([
        ...ops.flatMap((o) => ('tripId' in o && !prepared.has(o.tripId) ? [o.tripId] : [])),
        ...removedRows.map((r) => r.tripId),
      ]),
    ];
    const objectIds = await this.scopedObjectIds(ctx);
    const visibleTrips = existingTripIds.length ? await this.prisma.transportTrip.findMany({ where: { AND: [tripReadWhere(ctx, objectIds), { id: { in: existingTripIds } }] }, include: { plannedTrip: { select: { objectId: true, driverId: true } } } }) : [];
    if (visibleTrips.length !== existingTripIds.length) throw notFound('Trip not found');
    for (const t of visibleTrips) assertTripWrite(ctx, t);
    for (const id of existingTripIds) {
      if (input.expectedVersions?.[id] === undefined) throw invalid(`expectedVersions must give the version of trip ${id}`);
    }
    const bookingIds = ops.flatMap((o) => (o.op === 'ADD_PASSENGER' || o.op === 'ADD_STOP' ? [o.bookingId] : []));
    const consents = await this.consents((await this.prisma.transportBooking.findMany({ where: { id: { in: bookingIds } }, select: { profileId: true } })).map((b) => b.profileId));
    // ADD_STOP: the road path through the new stops, computed before any lock (null when routing does not answer).
    const stopPaths = await this.pathsAfterInserts(ctx, ops);
    const now = new Date();

    return this.prisma.$transaction(
      async (tx) => {
        // 1. Advisory locks: new and current vehicles / drivers (sorted inside lockTripResources).
        await lockTripResources(tx, {
          objectIds: [...newObjectIds, ...visibleTrips.map((t) => t.plannedTrip?.objectId)],
          driverIds: [...newDriverIds, ...visibleTrips.map((t) => t.plannedTrip?.driverId)],
        });
        // 2. Bookings (added or freed), then 3. trips — FOR UPDATE, sorted.
        await lockBookings(tx, [...bookingIds, ...removedRows.map((r) => r.bookingId)]);
        await lockTrips(tx, existingTripIds);
        const bookings = new Map(
          (await tx.transportBooking.findMany({ where: { id: { in: [...bookingIds, ...removedRows.map((r) => r.bookingId)] } }, include: { profile: { select: { branchId: true } } } })).map((b) => [b.id, b]),
        );
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
                  stops: { create: p.stops },
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
              await recordTripEvent(tx, ctx, { tripId: header.id, providerCompanyId: ctx.companyId, customerCompanyId: ctx.companyId, kind: 'PUBLISHED', data: { objectId: op.objectId, driverId: op.driverId ?? null, routeId: p.routeId, stops: p.stops.length } });
              break;
            }
            case 'ADD_PASSENGER': {
              const s = trip(op.tripId);
              editable(s);
              const b = bookings.get(op.bookingId);
              if (!b || b.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
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
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'PASSENGER_ADDED', passengerTripId: row.id, stopSeq: op.pickupSeq, data: { bookingId: b.id, seats: b.passengerCount } });
              touched.add(s.id);
              break;
            }
            case 'ADD_STOP': {
              const s = trip(op.tripId);
              editable(s);
              if (s.created) throw invalid(`Change ${n}: give a new trip's stops in its CREATE_TRIP`);
              const b = bookings.get(op.bookingId);
              if (!b || b.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
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
              const created = await tx.plannedTripStop.create({
                data: { tripId: s.plannedTripId, seq: op.afterSeq + 1, name: (point.label ?? '').trim() || (op.end === 'PICKUP' ? 'Pickup' : 'Drop'), lat: point.lat, lng: point.lng, radiusM: ROUTE_LIMITS.radiusDefaultM, plannedArrival: arrival, plannedDeparture: departure },
              });
              s.stops.splice(op.afterSeq + 1, 0, toStopState(created));
              s.stopIds = stopIdMap(s.stops);
              s.stopsAdded += 1;
              // No coordinates in the event (personal point): the stop row holds them.
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'STOP_ADDED', stopSeq: op.afterSeq + 1, data: { bookingId: b.id, end: op.end, plannedArrival: arrival.toISOString() } });
              touched.add(s.id);
              break;
            }
            case 'REMOVE_PASSENGER': {
              const r = removedRows.find((x) => x.id === op.passengerTripId)!;
              const s = trip(r.tripId);
              editable(s);
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
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'PASSENGER_REMOVED', passengerTripId: r.id, reasonCode: 'DISPATCH', data: { bookingId: b.id, reason: op.reason } });
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
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'VEHICLE_CHANGED', data: { from: s.objectId, to: op.objectId, seats } });
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
              await recordTripEvent(tx, ctx, { tripId: s.id, providerCompanyId: s.providerCompanyId, customerCompanyId: s.customerCompanyId, kind: 'DRIVER_CHANGED', data: { from: s.driverId, to: op.driverId } });
              s.driverId = op.driverId;
              touched.add(s.id);
              break;
            }
          }
        }

        // ADD_STOP: the planned path now runs through the new stops (or none when routing did not answer: never a stale one).
        for (const s of state.values()) {
          if (!s.stopsAdded) continue;
          const path = stopPaths.get(s.id) ?? null;
          await tx.plannedTrip.update({ where: { id: s.plannedTripId }, data: { path: path ? (path as Prisma.InputJsonValue) : Prisma.DbNull } });
        }
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
        const changeSetId = draftId ?? undefined;
        const result: ChangeSetResult = { changeSetId: '', status: 'PUBLISHED', trips, bookings: [...bookingOut.values()], warnings };
        const ledger = draftId
          ? await tx.transportChangeSet.update({ where: { id: draftId }, data: { status: 'PUBLISHED', idempotencyKey: key, requestHash: hash, draft: Prisma.DbNull, publishedAt: now } })
          : await tx.transportChangeSet.create({ data: { id: changeSetId, companyId: ctx.companyId, idempotencyKey: key, requestHash: hash, status: 'PUBLISHED', serviceDate: dateOnly(input.serviceDate), direction: input.direction, createdById: ctx.userId, publishedAt: now } });
        result.changeSetId = ledger.id;
        await tx.transportChangeSet.update({ where: { id: ledger.id }, data: { result: result as unknown as Prisma.InputJsonValue } });
        return { result, plannedTripIds: [...state.values()].map((s) => s.plannedTripId) };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  /**
   * ADD_STOP: the stop list each trip will have after its inserts (same order as the transaction applies them), routed
   * through GraphHopper before any lock. Trips / bookings that do not resolve here are refused inside the transaction.
   */
  private async pathsAfterInserts(ctx: AuthContext, ops: DispatchChangeOp[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    const adds = ops.filter((o): o is Extract<DispatchChangeOp, { op: 'ADD_STOP' }> => o.op === 'ADD_STOP');
    if (!adds.length) return out;
    const trips = await this.prisma.transportTrip.findMany({ where: { id: { in: [...new Set(adds.map((a) => a.tripId))] }, providerCompanyId: ctx.companyId }, include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } } } });
    const books = new Map((await this.prisma.transportBooking.findMany({ where: { id: { in: adds.map((a) => a.bookingId) }, customerCompanyId: ctx.companyId } })).map((b) => [b.id, b]));
    for (const t of trips) {
      const points = (t.plannedTrip?.stops ?? []).map((s) => ({ lat: s.lat, lng: s.lng }));
      let ok = points.length > 0;
      for (const a of adds.filter((x) => x.tripId === t.id)) {
        const b = books.get(a.bookingId);
        const p = b ? bookingEnd(b, a.end) : null;
        if (!p || a.afterSeq + 1 > points.length) {
          ok = false;
          break;
        }
        points.splice(a.afterSeq + 1, 0, { lat: p.lat, lng: p.lng });
      }
      if (!ok) continue;
      const road = await this.routing.routeVia(points).catch(() => null);
      out.set(t.id, road?.path ?? null);
    }
    return out;
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
      include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } }, passengers: { where: { status: { not: 'CANCELLED' } }, include: { booking: { select: { profileId: true, timeZone: true } } } } },
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
    for (const d of dayRange(addDays(from, 1), to)) {
      if (days && !days.has(weekdayOf(d))) continue;
      const found = await this.prisma.transportBooking.findMany({
        where: { customerCompanyId: ctx.companyId, profileId: { in: t.passengers.map((p) => p.booking.profileId) }, serviceDate: dateOnly(d), direction: t.direction, status: 'PENDING_ASSIGNMENT' },
        select: { id: true, profileId: true },
      });
      if (!found.length) {
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
              stops: pt.stops.map((s) => ({
                seq: s.seq,
                point: { lat: s.lat, lng: s.lng, label: s.name },
                plannedArrival: move(s.plannedArrival.getTime()),
                radiusM: s.radiusM,
                waitMin: Math.max(0, Math.round((s.plannedDeparture.getTime() - s.plannedArrival.getTime()) / MIN)),
              })),
            }),
      };
      const adds: DispatchChangeOp[] = found.map((b) => {
        const src = t.passengers.find((p) => p.booking.profileId === b.profileId)!;
        return { op: 'ADD_PASSENGER', tripId: 'trip', bookingId: b.id, pickupSeq: src.pickupSeq, dropSeq: src.dropSeq };
      });
      const draft = await this.saveDraft(ctx, { serviceDate: d, direction: t.direction, changes: [create, ...adds], expectedVersions: {}, reason: `Repeat of trip ${t.id}` }, t.id);
      const have = new Set(found.map((b) => b.profileId));
      result.drafts.push({ changeSetId: draft.changeSetId, serviceDate: d, passengers: found.length, missingBookings: t.passengers.map((p) => p.booking.profileId).filter((id) => !have.has(id)) });
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
