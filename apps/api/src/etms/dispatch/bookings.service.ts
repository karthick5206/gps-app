import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TRANSPORT_E3_LIMITS,
  bookingTransition,
  type AuditLogDto,
  type BulkApproveTransportBookingsResult,
  type GeoPoint,
  type TransportBookingCommand,
  type TransportBookingDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { addDays } from '../../summarizer/tz';
import { FixedWindowLimiter } from '../directory/lookup-rate-limit';
import { activeRoutingConsents } from '../people/people.service';
import { UNSEATED_STATUSES } from './booking-generator.service';
import {
  assertBookingAccess,
  bookingReadWhere,
  conflict,
  cutoffMinutes,
  dateOnly,
  e3Error,
  idempotencyKey,
  idempotencyReused,
  inProfileBranch,
  invalid,
  isUniqueViolation,
  notFound,
  parseInstant,
  requestHash,
  serviceDate,
  validPoint,
  versionConflict,
} from './e3-common';
import { BOOKING_INCLUDE, LIST_VIEW, toBookingDto, type BookingRow } from './e3-mapping';
import { BookingCommandDto, BookingListQuery, CreateBookingDto, UpdateBookingDto } from './e3.dto';
import { legWindow, todayIn } from './service-dates';
import { lockBookings, lockTrips, recordTripEvent, releaseSeat } from './trip-ops';

export const BOOKING_ENTITY = 'TransportBooking';

const LIST: ListSpec = {
  search: (q) => ({ OR: [{ profile: { displayName: { contains: q, mode: 'insensitive' } } }, { profile: { employeeCode: { contains: q, mode: 'insensitive' } } }, { pickupLabel: { contains: q, mode: 'insensitive' } }] }),
  sort: { windowStart: 'windowStart', serviceDate: 'serviceDate', createdAt: 'createdAt', status: 'status', passenger: 'profile.displayName' },
  defaultSort: 'windowStart',
  status: null,
};

const CSV: CsvSpec<TransportBookingDto> = {
  name: 'transport-bookings',
  columns: [
    { header: 'Service date', value: (b) => b.serviceDate },
    { header: 'Direction', value: (b) => b.direction },
    { header: 'Employee code', value: (b) => b.passenger.employeeCode },
    { header: 'Name', value: (b) => b.passenger.displayName },
    { header: 'Shift', value: (b) => b.shiftName ?? '' },
    { header: 'Window start', value: (b) => b.windowStart },
    { header: 'Window end', value: (b) => b.windowEnd },
    { header: 'Status', value: (b) => b.status },
    { header: 'Source', value: (b) => b.source },
    // Labels only: no coordinates in an export (E2 security review M3 / M4).
    { header: 'Pickup', value: (b) => b.pickupLabel ?? '' },
    { header: 'Drop', value: (b) => b.dropLabel ?? '' },
    { header: 'Needs location', value: (b) => (b.needsLocation ? 'yes' : 'no') },
    { header: 'Seats', value: (b) => b.passengerCount },
    { header: 'Trip', value: (b) => b.tripId ?? '' },
  ],
};

/** Audit snapshot of a booking: high-class personal data (pickup / drop coordinates, note) never stored in clear. */
function bookingSnapshot(b: Prisma.TransportBookingGetPayload<object>) {
  return {
    status: b.status,
    statusReason: b.statusReason,
    serviceDate: b.serviceDate.toISOString().slice(0, 10),
    direction: b.direction,
    windowStart: b.windowStart.toISOString(),
    windowEnd: b.windowEnd.toISOString(),
    passengerCount: b.passengerCount,
    hasPickup: b.pickupLat !== null,
    hasDrop: b.dropLat !== null,
    pickupPoiId: b.pickupPoiId,
    dropPoiId: b.dropPoiId,
    version: b.version,
  };
}

export interface Replayable<T> {
  value: T;
  replay: boolean;
}

/**
 * Bookings (05 §2.5, 15 §5.4; 12 WP 3.3). Reads: own company (branch-scoped for ASSIGNED users) plus customers whose
 * agreement grants VIEW_BOOKINGS (read-only). Writes (R1): own company only. Create needs an Idempotency-Key (double
 * submit = one booking; same key + other body = 422) and is rate limited per user. The partial unique index refuses a
 * second active booking of a passenger, date and direction (409 BOOKING_DUPLICATE). Commands follow
 * BOOKING_TRANSITIONS; changes need expectedVersion (409 VERSION_CONFLICT) and are refused after the cut-off.
 */
@Injectable()
export class BookingsService {
  private readonly limiter: FixedWindowLimiter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    redis: RedisService,
  ) {
    this.limiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:rl:booking-create', TRANSPORT_E3_LIMITS.bookingCreatesPerMinute, 60_000);
  }

  // ───────────────────────────── reads ─────────────────────────────

  async list(ctx: AuthContext, q: BookingListQuery) {
    const plan = planList<Prisma.TransportBookingWhereInput, Prisma.TransportBookingOrderByWithRelationInput>(q, LIST);
    const filters: Prisma.TransportBookingWhereInput[] = [bookingReadWhere(ctx), plan.where];
    if (q.serviceDate) filters.push({ serviceDate: dateOnly(serviceDate(q.serviceDate)) });
    if (q.from || q.to) filters.push({ serviceDate: { ...(q.from ? { gte: dateOnly(serviceDate(q.from, 'from')) } : {}), ...(q.to ? { lte: dateOnly(serviceDate(q.to, 'to')) } : {}) } });
    if (q.direction) filters.push({ direction: q.direction });
    if (q.shiftId) filters.push({ shiftId: q.shiftId });
    if (q.siteId) filters.push({ OR: [{ pickupPoiId: q.siteId }, { dropPoiId: q.siteId }] });
    if (q.passengerId) filters.push({ profileId: q.passengerId });
    if (q.bookingStatus) filters.push({ status: q.bookingStatus });
    if (q.source) filters.push({ source: q.source });
    if (q.unassigned === 'true') filters.push({ status: { in: [...UNSEATED_STATUSES] } });
    // CSV export (E2 security review M4 applied to E3): only the caller's own company's bookings, never a partner's.
    if (q.format === 'csv') filters.push({ customerCompanyId: ctx.companyId });
    const where: Prisma.TransportBookingWhereInput = { AND: filters };
    const [rows, total] = await Promise.all([
      this.prisma.transportBooking.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: BOOKING_INCLUDE }),
      this.prisma.transportBooking.count({ where }),
    ]);
    const now = Date.now();
    return listResult(plan, rows.map((r) => toBookingDto(r, ctx, LIST_VIEW, now)), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<TransportBookingDto> {
    return this.detail(ctx, await this.find(ctx, id, 'read'));
  }

  /** Timeline: the booking's audit trail (snapshots without personal coordinates) plus its trip-passenger events. */
  async events(ctx: AuthContext, id: string): Promise<AuditLogDto[]> {
    const row = await this.find(ctx, id, 'read');
    if (row.customerCompanyId !== ctx.companyId) return [];
    return this.audit.history(ctx, BOOKING_ENTITY, id);
  }

  // ───────────────────────────── create ─────────────────────────────

  async create(ctx: AuthContext, dto: CreateBookingDto, rawKey: string | undefined): Promise<Replayable<TransportBookingDto>> {
    const key = idempotencyKey(rawKey);
    const hash = requestHash(dto);
    const prior = await this.prisma.transportBooking.findFirst({ where: { customerCompanyId: ctx.companyId, idempotencyKey: key }, include: BOOKING_INCLUDE });
    if (prior) {
      if (prior.idempotencyHash !== hash) throw idempotencyReused();
      return { value: await this.detail(ctx, prior), replay: true };
    }
    const rl = await this.limiter.hit(ctx.userId);
    if (!rl.allowed) throw e3Error(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `Too many bookings; try again in ${rl.retryAfterSec} s`, { retryAfterSec: rl.retryAfterSec });

    const profile = await this.prisma.employeeTransportProfile.findFirst({
      where: { id: dto.passengerId, companyId: ctx.companyId, isActive: true },
      select: { id: true, branchId: true, homeLat: true, homeLng: true, defaultStop: { select: { id: true, name: true, lat: true, lng: true } } },
    });
    if (!profile || !inProfileBranch(ctx, profile.branchId)) throw notFound('Passenger not found');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true, settings: true } });
    const day = serviceDate(dto.serviceDate);

    const shift = dto.shiftId ? await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId, isActive: true }, include: { sitePoi: true } }) : null;
    if (dto.shiftId && !shift) throw invalid('Unknown or archived shift');
    const tz = shift?.timeZone ?? company.timezone;
    const today = todayIn(tz);
    if (day < today) throw invalid('The service date is in the past');
    if (day > addDays(today, TRANSPORT_E3_LIMITS.adhocMaxDaysAhead)) throw invalid(`Book at most ${TRANSPORT_E3_LIMITS.adhocMaxDaysAhead} days ahead`);

    let start: number;
    let end: number;
    if (dto.windowStart || dto.windowEnd) {
      if (!dto.windowStart || !dto.windowEnd) throw invalid('Give both window start and end');
      start = parseInstant(dto.windowStart, 'windowStart');
      end = parseInstant(dto.windowEnd, 'windowEnd');
    } else {
      if (!shift) throw invalid('Choose a shift or give the time window');
      const w = legWindow(shift, dto.direction, day);
      start = w.start;
      end = w.end;
    }
    if (end <= start) throw invalid('The window must end after it starts');
    if (end - start > 12 * 3_600_000) throw invalid('The window can be at most 12 hours');
    if (end < Date.now()) throw invalid('The window has already passed');

    // Passenger end: given point, else the routing pickup (only with an active TRANSPORT_PROFILE consent); site end:
    // given point, else the shift's site.
    const consent = await this.consentActive(profile.id);
    const site: GeoPoint | null = shift?.sitePoi ? { lat: shift.sitePoi.lat, lng: shift.sitePoi.lng, label: shift.sitePoi.name, poiId: shift.sitePoi.id } : null;
    const home: GeoPoint | null = !consent
      ? null
      : profile.defaultStop
        ? { lat: profile.defaultStop.lat, lng: profile.defaultStop.lng, label: profile.defaultStop.name, poiId: profile.defaultStop.id }
        : profile.homeLat !== null && profile.homeLng !== null
          ? { lat: profile.homeLat, lng: profile.homeLng, label: null, poiId: null }
          : null;
    const pickup = await this.point(ctx, dto.pickup ?? (dto.direction === 'IN' ? home : site));
    const drop = await this.point(ctx, dto.drop ?? (dto.direction === 'IN' ? site : home));

    const cutoffMin = cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin);
    const duplicate = await this.prisma.transportBooking.findFirst({
      where: { profileId: profile.id, serviceDate: dateOnly(day), direction: dto.direction, status: { in: ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'WAITLISTED'] } },
      select: { id: true },
    });
    if (duplicate) throw conflict('BOOKING_DUPLICATE', 'The passenger already has an active booking for this date and direction', { bookingId: duplicate.id });

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.transportBooking.create({
          data: {
            customerCompanyId: ctx.companyId,
            profileId: profile.id,
            shiftId: shift?.id ?? null,
            source: 'ADHOC',
            serviceDate: dateOnly(day),
            direction: dto.direction,
            timeZone: tz,
            pickupLabel: pickup?.label ?? null,
            pickupLat: pickup?.lat ?? null,
            pickupLng: pickup?.lng ?? null,
            pickupPoiId: pickup?.poiId ?? null,
            dropLabel: drop?.label ?? null,
            dropLat: drop?.lat ?? null,
            dropLng: drop?.lng ?? null,
            dropPoiId: drop?.poiId ?? null,
            windowStart: new Date(start),
            windowEnd: new Date(end),
            passengerCount: dto.passengerCount ?? 1,
            status: dto.hold ? 'REQUESTED' : 'PENDING_ASSIGNMENT',
            cutoffAt: new Date(start - cutoffMin * 60_000),
            idempotencyKey: key,
            idempotencyHash: hash,
            note: dto.note?.trim() || null,
            createdById: ctx.userId,
          },
          include: BOOKING_INCLUDE,
        });
        await this.audit.record(ctx, { action: 'CREATE', entity: BOOKING_ENTITY, entityId: created.id, after: bookingSnapshot(created) }, tx);
        return created;
      });
      return { value: await this.detail(ctx, row), replay: false };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotencyKey')) {
        // A concurrent request with the same key won the race: answer as its replay.
        const winner = await this.prisma.transportBooking.findFirst({ where: { customerCompanyId: ctx.companyId, idempotencyKey: key }, include: BOOKING_INCLUDE });
        if (winner && winner.idempotencyHash === hash) return { value: await this.detail(ctx, winner), replay: true };
        throw idempotencyReused();
      }
      if (isUniqueViolation(e)) throw conflict('BOOKING_DUPLICATE', 'The passenger already has an active booking for this date and direction');
      throw e;
    }
  }

  // ───────────────────────────── change ─────────────────────────────

  async update(ctx: AuthContext, id: string, dto: UpdateBookingDto): Promise<TransportBookingDto> {
    const before = await this.find(ctx, id, 'write');
    if (!(UNSEATED_STATUSES as readonly string[]).includes(before.status)) throw conflict('INVALID_STATE', 'Only a booking without a seat can be changed; remove it from the trip first');
    if (before.cutoffAt && Date.now() >= before.cutoffAt.getTime()) throw conflict('AFTER_CUTOFF', 'The cut-off for changes has passed');
    if (before.version !== dto.expectedVersion) throw versionConflict(before.version);
    const data: Prisma.TransportBookingUncheckedUpdateManyInput = {};
    if (dto.pickup !== undefined) Object.assign(data, this.columns('pickup', await this.point(ctx, dto.pickup)));
    if (dto.drop !== undefined) Object.assign(data, this.columns('drop', await this.point(ctx, dto.drop)));
    if (dto.passengerCount !== undefined) data.passengerCount = dto.passengerCount;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.windowStart !== undefined || dto.windowEnd !== undefined) {
      const start = dto.windowStart !== undefined ? parseInstant(dto.windowStart, 'windowStart') : before.windowStart.getTime();
      const end = dto.windowEnd !== undefined ? parseInstant(dto.windowEnd, 'windowEnd') : before.windowEnd.getTime();
      if (end <= start) throw invalid('The window must end after it starts');
      if (end - start > 12 * 3_600_000) throw invalid('The window can be at most 12 hours');
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
      data.windowStart = new Date(start);
      data.windowEnd = new Date(end);
      data.cutoffAt = new Date(start - cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin) * 60_000);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.transportBooking.updateMany({ where: { id, version: dto.expectedVersion, status: before.status }, data: { ...data, version: { increment: 1 } } });
      if (!claimed.count) throw versionConflict(before.version);
      const after = await tx.transportBooking.findUniqueOrThrow({ where: { id }, include: BOOKING_INCLUDE });
      await this.audit.record(ctx, { action: 'UPDATE', entity: BOOKING_ENTITY, entityId: id, before: bookingSnapshot(before), after: bookingSnapshot(after) }, tx);
      return after;
    });
    return await this.detail(ctx, row);
  }

  /** approve / reject / cancel (05 §2.5). Cancelling a seated booking takes the passenger off the trip in the same transaction. */
  async command(ctx: AuthContext, id: string, command: Extract<TransportBookingCommand, 'approve' | 'reject' | 'cancel'>, dto: BookingCommandDto): Promise<TransportBookingDto> {
    const before = await this.find(ctx, id, 'write');
    const next = bookingTransition(before.status, command);
    if (!next) throw conflict('INVALID_STATE', `A ${before.status.toLowerCase().replace('_', ' ')} booking cannot be ${command === 'approve' ? 'approved' : command === 'reject' ? 'rejected' : 'cancelled'}`);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== before.version) throw versionConflict(before.version);
    const reason = dto.reason?.trim() || null;
    if ((command === 'reject' || command === 'cancel') && !reason) throw invalid('Give a reason');
    const row = await this.prisma.$transaction(async (tx) => {
      await lockBookings(tx, [id]);
      const seat = command === 'cancel' && (before.status === 'ASSIGNED' || before.status === 'CONFIRMED')
        ? await tx.transportTripPassenger.findFirst({ where: { bookingId: id, status: { not: 'CANCELLED' } }, include: { trip: { select: { id: true, providerCompanyId: true, customerCompanyId: true } } } })
        : null;
      if (seat) {
        await lockTrips(tx, [seat.tripId]);
        if (!(await releaseSeat(tx, seat, reason ?? 'Booking cancelled'))) throw conflict('INVALID_STATE', 'The passenger’s outcome is already recorded; the booking cannot be cancelled now');
        await recordTripEvent(tx, ctx, { tripId: seat.tripId, providerCompanyId: seat.trip.providerCompanyId, customerCompanyId: seat.trip.customerCompanyId, kind: 'PASSENGER_REMOVED', passengerTripId: seat.id, reasonCode: 'BOOKING_CANCELLED', data: { bookingId: id } });
      }
      const claimed = await tx.transportBooking.updateMany({
        where: { id, status: before.status, version: before.version },
        data: { status: next, statusReason: command === 'approve' ? null : reason, version: { increment: 1 } },
      });
      if (!claimed.count) throw versionConflict(before.version);
      const after = await tx.transportBooking.findUniqueOrThrow({ where: { id }, include: BOOKING_INCLUDE });
      await this.audit.record(ctx, { action: 'UPDATE', entity: BOOKING_ENTITY, entityId: id, before: bookingSnapshot(before), after: bookingSnapshot(after), details: { command, reason } }, tx);
      return after;
    });
    return await this.detail(ctx, row);
  }

  async bulkApprove(ctx: AuthContext, ids: string[]): Promise<BulkApproveTransportBookingsResult> {
    const approved: string[] = [];
    const skipped: { id: string; code: string }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        await this.command(ctx, id, 'approve', {});
        approved.push(id);
      } catch (e) {
        const code = ((e as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined)?.code ?? 'ERROR';
        skipped.push({ id, code });
      }
    }
    return { approved, skipped };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async find(ctx: AuthContext, id: string, mode: 'read' | 'write'): Promise<BookingRow> {
    const row = await this.prisma.transportBooking.findFirst({ where: { AND: [bookingReadWhere(ctx), { id }] }, include: BOOKING_INCLUDE });
    assertBookingAccess(ctx, row, mode);
    return row!;
  }

  /** Detail projection: personal points only while the passenger's routing consent is active (E2 M3). */
  private async detail(ctx: AuthContext, row: BookingRow): Promise<TransportBookingDto> {
    return toBookingDto(row, ctx, { view: 'detail', consent: await this.consentActive(row.profileId) });
  }

  /** Routing consent under the E2 final model (activeRoutingConsents). */
  private async consentActive(profileId: string): Promise<boolean> {
    return (await activeRoutingConsents(this.prisma, [profileId])).has(profileId);
  }

  /** A point from the request: range check, and a poiId must be the caller's own place (its coordinates win). */
  private async point(ctx: AuthContext, p: GeoPoint | null | undefined): Promise<GeoPoint | null> {
    if (!p) return null;
    if (p.poiId) {
      const poi = await this.prisma.poi.findFirst({ where: { id: p.poiId, companyId: ctx.companyId, isActive: true }, select: { id: true, name: true, lat: true, lng: true } });
      if (!poi) throw invalid('Unknown place');
      return { lat: poi.lat, lng: poi.lng, label: p.label?.trim() || poi.name, poiId: poi.id };
    }
    if (!validPoint(p)) throw invalid('A point must have a valid latitude and longitude (not 0, 0)');
    return { lat: p.lat, lng: p.lng, label: p.label?.trim() || null, poiId: null };
  }

  private columns(side: 'pickup' | 'drop', p: GeoPoint | null): Record<string, unknown> {
    return { [`${side}Lat`]: p?.lat ?? null, [`${side}Lng`]: p?.lng ?? null, [`${side}Label`]: p?.label ?? null, [`${side}PoiId`]: p?.poiId ?? null };
  }

}
