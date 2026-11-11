import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { passengerOutcomeAllowed, type PlannedTripClosedBy, type TransportTripDto, type TransportTripSummaryDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DispatchService, TRIP_ENTITY } from './dispatch.service';
import { BOOKING_ENTITY } from './bookings.service';
import { assertTripWrite, conflict, dateOnly, invalid, isUniqueViolation, notFound, parseInstant, serviceDate, tripReadWhere, versionConflict } from './e3-common';
import { PASSENGER_DETAIL_INCLUDE, TRIP_INCLUDE, toTripDetail, toTripSummary, type TripRow } from './e3-mapping';
import { PassengerOutcomeDto, TripArriveDto, TripCancelDto, TripCommandDto, TripListQuery } from './e3.dto';
import { TripLiveService } from './trip-live';
import { lockBookings, lockTrips, recordTripEvent, seenClientEvent } from './trip-ops';

const LIST: ListSpec = {
  search: (q) => ({ plannedTrip: { routeName: { contains: q, mode: 'insensitive' } } }),
  sort: { plannedStart: 'plannedTrip.plannedStart', serviceDate: 'serviceDate', createdAt: 'createdAt' },
  defaultSort: 'serviceDate',
  status: null,
};

const CSV: CsvSpec<TransportTripSummaryDto> = {
  name: 'transport-trips',
  columns: [
    { header: 'Service date', value: (t) => t.serviceDate },
    { header: 'Direction', value: (t) => t.direction },
    { header: 'Trip', value: (t) => t.name },
    { header: 'Vehicle', value: (t) => t.vehicleName ?? '' },
    { header: 'Driver', value: (t) => t.driverName ?? '' },
    { header: 'State', value: (t) => t.derivedState },
    { header: 'Planned start', value: (t) => t.plannedStart ?? '' },
    { header: 'Actual start', value: (t) => t.actualStart ?? '' },
    { header: 'Seats', value: (t) => t.seatCapacity },
    { header: 'Occupied', value: (t) => t.occupiedSeats },
    { header: 'Boarded', value: (t) => t.passengerCounts.boarded },
    { header: 'No-show', value: (t) => t.passengerCounts.noShow },
    { header: 'Outcome not recorded', value: (t) => t.passengerCounts.pending },
  ],
};

/** derivedState filter → where (02 §5.2; AT_STOP / EN_ROUTE / IN_PROGRESS all match running trips). */
function derivedWhere(state: string): Prisma.TransportTripWhereInput {
  switch (state) {
    case 'PLANNED':
      return { publishedAt: null, plannedTrip: { status: 'SCHEDULED' } };
    case 'PUBLISHED':
      return { publishedAt: { not: null }, acknowledgedAt: null, plannedTrip: { status: 'SCHEDULED' } };
    case 'DRIVER_ACKNOWLEDGED':
      return { acknowledgedAt: { not: null }, plannedTrip: { status: 'SCHEDULED' } };
    case 'EN_ROUTE':
    case 'AT_STOP':
    case 'IN_PROGRESS':
      return { plannedTrip: { status: { in: ['STARTED', 'IN_PROGRESS'] } } };
    case 'DETACHED':
      return { plannedTripId: null };
    default:
      return { plannedTrip: { status: state as 'COMPLETED' | 'INCOMPLETE' | 'CANCELLED' } };
  }
}

/**
 * Transport trips and dispatcher progression without a driver app (05 §2.6, 02 §5.3; condition A). start / complete
 * wrap the v1.8 PlannedTripsService compare-and-set commands (status semantics unchanged, D2); cancel closes the
 * PlannedTrip the same way and takes the pending passengers off in one transaction; arrive records a
 * dispatcher-reported stop arrival. Passenger outcomes (BOARDED / NO_SHOW / DROPPED) are recorded only here, by the
 * dispatcher (outcomeSource WEB): a GPS stop arrival never changes a passenger (DB CHECK on outcomeSource). Every
 * command is audited, writes a TransportTripEvent, and a repeated clientEventId is a no-op.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plannedTrips: PlannedTripsService,
    private readonly dispatch: DispatchService,
    private readonly live: TripLiveService,
  ) {}

  async list(ctx: AuthContext, q: TripListQuery) {
    const plan = planList<Prisma.TransportTripWhereInput, Prisma.TransportTripOrderByWithRelationInput>(q, LIST);
    const filters: Prisma.TransportTripWhereInput[] = [tripReadWhere(ctx, await this.dispatch.scopedObjectIds(ctx)), plan.where];
    if (q.serviceDate) filters.push({ serviceDate: dateOnly(serviceDate(q.serviceDate)) });
    if (q.from || q.to) filters.push({ serviceDate: { ...(q.from ? { gte: dateOnly(serviceDate(q.from, 'from')) } : {}), ...(q.to ? { lte: dateOnly(serviceDate(q.to, 'to')) } : {}) } });
    if (q.direction) filters.push({ direction: q.direction });
    if (q.shiftId) filters.push({ shiftId: q.shiftId });
    if (q.siteId) filters.push({ sitePoiId: q.siteId });
    if (q.vehicleId) filters.push({ plannedTrip: { objectId: q.vehicleId } });
    if (q.driverId) filters.push({ plannedTrip: { driverId: q.driverId } });
    if (q.derivedState) filters.push(derivedWhere(q.derivedState));
    const where: Prisma.TransportTripWhereInput = { AND: filters };
    const [rows, total] = await Promise.all([
      this.prisma.transportTrip.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: TRIP_INCLUDE }),
      this.prisma.transportTrip.count({ where }),
    ]);
    const names = await this.dispatch.names(rows.map((r) => r.plannedTrip));
    let items = rows.map((r) => toTripSummary(r, names));
    if (q.derivedState) items = items.filter((t) => t.derivedState === q.derivedState);
    return listResult(plan, items, total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<TransportTripDto> {
    const t = await this.find(ctx, id);
    const [names, passengers, events] = await Promise.all([
      this.dispatch.names([t.plannedTrip]),
      this.prisma.transportTripPassenger.findMany({ where: { tripId: id }, include: PASSENGER_DETAIL_INCLUDE }),
      this.prisma.transportTripEvent.findMany({ where: { tripId: id }, orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }], take: 500 }),
    ]);
    // The manifest (names, outcomes) is a sensitive read for whoever is not the dispatching company itself (05 §1).
    const writable = t.providerCompanyId === ctx.companyId && (t.customerCompanyId === null || t.customerCompanyId === ctx.companyId);
    return toTripDetail(t, names, passengers, events, writable);
  }

  // ───────────────────────────── Progression ─────────────────────────────

  /** Start on the dispatcher's word (v1.8 manual start): SCHEDULED → IN_PROGRESS. Already started (GPS) = 200, no change. */
  async start(ctx: AuthContext, id: string, dto: TripCommandDto): Promise<TransportTripDto> {
    const t = await this.writable(ctx, id, dto);
    if (await seenClientEvent(this.prisma, id, dto.clientEventId)) return this.get(ctx, id);
    const pt = t.plannedTrip!;
    if (pt.status === 'STARTED' || pt.status === 'IN_PROGRESS') return this.get(ctx, id); // ALREADY_STARTED (GPS or a colleague)
    if (pt.status !== 'SCHEDULED') throw conflict('TRIP_CLOSED', 'This trip is closed');
    await this.plannedTrips.start(ctx, pt.id, { note: dto.note });
    await this.event(ctx, t, 'STARTED', dto.clientEventId, {}, { note: dto.note ?? null });
    await this.live.changed(ctx.companyId, [pt.id]);
    return this.get(ctx, id);
  }

  /**
   * Complete on the dispatcher's word (v1.8 manual complete, closedBy MANUAL). Passengers still PENDING stay PENDING
   * ("outcome not recorded", flagged for review) — never auto-dropped (02 §5.3).
   */
  async complete(ctx: AuthContext, id: string, dto: TripCommandDto): Promise<TransportTripDto> {
    const t = await this.writable(ctx, id, dto);
    if (await seenClientEvent(this.prisma, id, dto.clientEventId)) return this.get(ctx, id);
    const pt = t.plannedTrip!;
    if (pt.status === 'COMPLETED') return this.get(ctx, id);
    if (pt.status !== 'STARTED' && pt.status !== 'IN_PROGRESS') throw conflict('INVALID_STATE', 'Only a started trip can be completed');
    await this.plannedTrips.complete(ctx, pt.id, { note: dto.note });
    const pending = t.passengers.filter((p) => p.status === 'PENDING').length;
    await this.event(ctx, t, 'COMPLETED', dto.clientEventId, {}, { note: dto.note ?? null, pendingOutcomes: pending });
    await this.live.changed(ctx.companyId, [pt.id]);
    return this.get(ctx, id);
  }

  /**
   * Cancel (reason required): PlannedTrip → CANCELLED (closedBy MANUAL, PENDING stops SKIPPED) by compare-and-set, the
   * pending passengers → CANCELLED and their bookings back to the queue (or cancelled with `cancelBookings`), header
   * cancelledAt + reason, version + 1 — one transaction. Passengers with a recorded outcome keep it.
   */
  async cancel(ctx: AuthContext, id: string, dto: TripCancelDto): Promise<TransportTripDto> {
    const t = await this.writable(ctx, id, dto);
    if (await seenClientEvent(this.prisma, id, dto.clientEventId)) return this.get(ctx, id);
    const pt = t.plannedTrip!;
    if (!['SCHEDULED', 'STARTED', 'IN_PROGRESS'].includes(pt.status)) throw conflict('TRIP_CLOSED', 'This trip is already closed');
    const reason = dto.reason.trim();
    if (!reason) throw invalid('Give a reason');
    await this.prisma.$transaction(async (tx) => {
      const pending = await tx.transportTripPassenger.findMany({ where: { tripId: id, status: 'PENDING' } });
      await lockBookings(tx, pending.map((p) => p.bookingId));
      await lockTrips(tx, [id]);
      const claimed = await tx.plannedTrip.updateMany({ where: { id: pt.id, status: pt.status }, data: { status: 'CANCELLED', closedBy: 'MANUAL' satisfies PlannedTripClosedBy, cancelReason: reason, nextStopSeq: null } });
      if (!claimed.count) throw conflict('INVALID_STATE', 'The trip changed meanwhile; reload it');
      await tx.plannedTripStop.updateMany({ where: { tripId: pt.id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
      let freed = 0;
      for (const p of pending) {
        const done = await tx.transportTripPassenger.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelReason: `Trip cancelled: ${reason}` } });
        if (!done.count) continue;
        freed += p.seats;
        await tx.transportBooking.updateMany({
          where: { id: p.bookingId, status: { in: ['ASSIGNED', 'CONFIRMED'] } },
          data: dto.cancelBookings ? { status: 'CANCELLED', statusReason: `Trip cancelled: ${reason}`, version: { increment: 1 } } : { status: 'PENDING_ASSIGNMENT', version: { increment: 1 } },
        });
        await this.audit.record(ctx, { action: 'UPDATE', entity: BOOKING_ENTITY, entityId: p.bookingId, details: { tripCancelled: id, status: dto.cancelBookings ? 'CANCELLED' : 'PENDING_ASSIGNMENT' } }, tx);
      }
      await tx.transportTrip.update({ where: { id }, data: { cancelledAt: new Date(), cancelReason: reason, occupiedSeats: { decrement: freed }, version: { increment: 1 } } });
      await recordTripEvent(tx, ctx, { tripId: id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'CANCELLED', clientEventId: dto.clientEventId, reasonCode: 'DISPATCHER', data: { reason, passengersReleased: pending.length, cancelBookings: !!dto.cancelBookings } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: id, before: { status: pt.status, version: t.version }, after: { status: 'CANCELLED', reason, version: t.version + 1 } }, tx);
    });
    await this.live.changed(ctx.companyId, [pt.id]);
    return this.get(ctx, id);
  }

  /** Driver acknowledgement recorded by the dispatcher on the driver's behalf (R1, source WEB). */
  async acknowledge(ctx: AuthContext, id: string, dto: TripCommandDto): Promise<TransportTripDto> {
    const t = await this.writable(ctx, id, dto);
    if (t.acknowledgedAt || (await seenClientEvent(this.prisma, id, dto.clientEventId))) return this.get(ctx, id);
    if (!t.publishedAt || !['SCHEDULED', 'STARTED', 'IN_PROGRESS'].includes(t.plannedTrip!.status)) throw conflict('INVALID_STATE', 'Only a published, open trip can be acknowledged');
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.transportTrip.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedAt: new Date(), acknowledgedByUserId: ctx.userId, acknowledgedSource: 'WEB' } });
      if (!done.count) return;
      await recordTripEvent(tx, ctx, { tripId: id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'ACKNOWLEDGE', clientEventId: dto.clientEventId, data: { onBehalfOfDriver: t.plannedTrip!.driverId } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: id, details: { acknowledge: 'on behalf of the driver' } }, tx);
    });
    return this.get(ctx, id);
  }

  /**
   * Dispatcher-reported arrival at a stop (e.g. after a call with the driver): the PlannedTripStop goes PENDING →
   * ARRIVED by compare-and-set (a stop the GPS tracker already reached is left as it is) and an ARRIVED event is
   * written. Passenger outcomes are NOT touched: arriving is not boarding.
   */
  async arrive(ctx: AuthContext, id: string, dto: TripArriveDto): Promise<TransportTripDto> {
    const t = await this.writable(ctx, id, dto);
    if (await seenClientEvent(this.prisma, id, dto.clientEventId)) return this.get(ctx, id);
    const pt = t.plannedTrip!;
    if (pt.status !== 'STARTED' && pt.status !== 'IN_PROGRESS') throw conflict('INVALID_STATE', 'Start the trip first');
    const stop = pt.stops.find((s) => s.seq === dto.stopSeq);
    if (!stop) throw invalid('No such stop on this trip');
    const at = this.occurredAt(dto.occurredAt);
    await this.prisma.$transaction(async (tx) => {
      await tx.plannedTripStop.updateMany({ where: { id: stop.id, status: 'PENDING' }, data: { status: 'ARRIVED', actualArrival: at, delaySec: Math.round((at.getTime() - stop.plannedArrival.getTime()) / 1000) } });
      await recordTripEvent(tx, ctx, { tripId: id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'ARRIVED', stopSeq: stop.seq, clientEventId: dto.clientEventId, occurredAt: at, data: { reported: 'DISPATCHER', gpsStatusBefore: stop.status } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: id, details: { arrive: stop.seq, at: at.toISOString() } }, tx);
    });
    await this.live.changed(ctx.companyId, [pt.id]);
    return this.get(ctx, id);
  }

  /**
   * Passenger outcome recorded by the dispatcher (05 §2.6; 02 §5.3): PENDING → BOARDED | NO_SHOW, BOARDED → DROPPED,
   * corrections BOARDED ↔ NO_SHOW. Only once the trip has started (or after it closed by GPS / timeout, to fill in what
   * happened); never on a cancelled trip. outcomeSource = WEB, actor DISPATCHER — the DB refuses any other source.
   */
  async outcome(ctx: AuthContext, id: string, passengerTripId: string, dto: PassengerOutcomeDto): Promise<TransportTripDto> {
    const t = await this.writable(ctx, id, {});
    if (await seenClientEvent(this.prisma, id, dto.clientEventId)) return this.get(ctx, id);
    const pt = t.plannedTrip!;
    if (pt.status === 'SCHEDULED') throw conflict('INVALID_STATE', 'Start the trip before recording boarding');
    if (pt.status === 'CANCELLED') throw conflict('TRIP_CLOSED', 'This trip was cancelled');
    const p = await this.prisma.transportTripPassenger.findFirst({ where: { id: passengerTripId, tripId: id } });
    if (!p) throw notFound('Passenger not found on this trip');
    if (!passengerOutcomeAllowed(p.status, dto.outcome)) throw conflict('INVALID_STATE', `A ${p.status.toLowerCase().replace('_', '-')} passenger cannot be marked ${dto.outcome.toLowerCase().replace('_', '-')}`);
    const at = this.occurredAt(dto.occurredAt);
    const data: Prisma.TransportTripPassengerUpdateManyMutationInput = { status: dto.outcome, outcomeSource: 'WEB', outcomeByUserId: ctx.userId, outcomeAt: new Date() };
    if (dto.outcome === 'BOARDED') data.boardedAt = at;
    if (dto.outcome === 'DROPPED') data.droppedAt = at;
    if (dto.outcome === 'NO_SHOW') {
      data.noShowAt = at;
      data.noShowReason = dto.reasonCode?.trim() || null;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const done = await tx.transportTripPassenger.updateMany({ where: { id: p.id, status: p.status }, data });
        if (!done.count) throw conflict('INVALID_STATE', 'The passenger changed meanwhile; reload the trip');
        await recordTripEvent(tx, ctx, {
          tripId: id,
          providerCompanyId: t.providerCompanyId,
          customerCompanyId: t.customerCompanyId,
          kind: dto.outcome,
          passengerTripId: p.id,
          stopSeq: dto.outcome === 'DROPPED' ? p.dropSeq : p.pickupSeq,
          reasonCode: dto.reasonCode ?? null,
          clientEventId: dto.clientEventId,
          occurredAt: at,
          data: { from: p.status, note: dto.note ?? null },
        });
        await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: id, details: { passengerTripId: p.id, outcome: dto.outcome, from: p.status, source: 'WEB' } }, tx);
      });
    } catch (e) {
      if (isUniqueViolation(e, 'clientEventId')) return this.get(ctx, id);
      throw e;
    }
    await this.live.changed(ctx.companyId, [pt.id]);
    return this.get(ctx, id);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private occurredAt(raw: string | undefined): Date {
    if (!raw) return new Date();
    const ms = parseInstant(raw, 'occurredAt');
    if (ms > Date.now() + 2 * 60_000) throw invalid('occurredAt cannot be in the future');
    if (ms < Date.now() - 48 * 3_600_000) throw invalid('occurredAt is too far in the past');
    return new Date(ms);
  }

  private async find(ctx: AuthContext, id: string): Promise<TripRow> {
    const row = await this.prisma.transportTrip.findFirst({ where: { AND: [tripReadWhere(ctx, await this.dispatch.scopedObjectIds(ctx)), { id }] }, include: TRIP_INCLUDE });
    if (!row) throw notFound();
    return row;
  }

  private async writable(ctx: AuthContext, id: string, dto: { expectedVersion?: number }): Promise<TripRow> {
    const t = await this.find(ctx, id);
    assertTripWrite(ctx, t);
    if (!t.plannedTrip) throw conflict('TRIP_CLOSED', 'This trip lost its planned trip (vehicle removed)');
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== t.version) throw versionConflict(t.version);
    return t;
  }

  private async event(ctx: AuthContext, t: TripRow, kind: 'STARTED' | 'COMPLETED', clientEventId: string | undefined, _extra: object, data: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await recordTripEvent(tx, ctx, { tripId: t.id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind, clientEventId, data });
        await tx.transportTrip.update({ where: { id: t.id }, data: { version: { increment: 1 } } });
      });
    } catch (e) {
      if (!isUniqueViolation(e, 'clientEventId')) throw e;
    }
  }
}
