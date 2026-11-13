import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  TRANSPORT_ADHOC_LIMITS,
  TRANSPORT_E3_LIMITS,
  bookingTransition,
  passengerPushAllowed,
  type AuditLogDto,
  type BulkApproveTransportBookingsResult,
  type GeoPoint,
  type TransportBookingCommand,
  type TransportBookingDto,
  type TransportBookingJourney,
  type TransportDirection,
  type TransportBookingPolicyDto,
  type TransportGroupBookingResult,
  type TransportGroupFailure,
  type TransportPlaceOptionDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { addDays } from '../../summarizer/tz';
import { FixedWindowLimiter } from '../directory/lookup-rate-limit';
import { TransportNotificationsService, type NotifyItem } from '../notifications/transport-notifications.service';
import { activeRoutingConsents } from '../people/people.service';
import { UNSEATED_STATUSES } from './booking-generator.service';
import {
  ACTIVE_BOOKING_STATUSES,
  assertEligible,
  ineligibility,
  isLate,
  isOverlapExclusion,
  notEligible,
  overlapConflict,
  overlapWhere,
  personalPointConsentRequired,
  requireLateReason,
  type BookingActor,
} from './booking-rules';
import {
  assertBookingAccess,
  bookingReadWhere,
  conflict,
  cutoffMinutes,
  dateOnly,
  dayKeyOf,
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
import { BOOKING_INCLUDE, LIST_VIEW, toBookingDto, withGroupSizes, type BookingRow } from './e3-mapping';
import { BookingCommandDto, BookingListQuery, CreateBookingDto, CreateGroupBookingDto, UpdateBookingDto } from './e3.dto';
import { legWindow, todayIn, weekdayOf } from './service-dates';
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
    { header: 'Journey', value: (b) => b.journey },
    { header: 'After cut-off', value: (b) => (b.afterCutoff ? 'yes' : 'no') },
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
    journey: b.journey,
    windowStart: b.windowStart.toISOString(),
    windowEnd: b.windowEnd.toISOString(),
    passengerCount: b.passengerCount,
    hasPickup: b.pickupLat !== null,
    hasDrop: b.dropLat !== null,
    pickupPoiId: b.pickupPoiId,
    dropPoiId: b.dropPoiId,
    ...(b.groupId ? { groupId: b.groupId } : {}),
    version: b.version,
  };
}

/** Window rules of create and PATCH: ends after it starts, at most 12 h. */
function checkWindow(start: number, end: number): void {
  if (end <= start) throw invalid('The window must end after it starts');
  if (end - start > 12 * 3_600_000) throw invalid('The window can be at most 12 hours');
}

/** D-A1 audit record of a late create / edit: the cut-off, when it happened, who did it and why. */
function lateAudit(cutoffAt: number, at: Date, userId: string, reason: string, field: 'createdAt' | 'editedAt') {
  return { cutoffAt: new Date(cutoffAt).toISOString(), [field]: at.toISOString(), dispatcherUserId: userId, reason };
}

/** D-A8: 422 GROUP_INVALID with the per-passenger failures (nothing was written). */
const groupInvalid = (failures: TransportGroupFailure[]) =>
  e3Error(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_INVALID', 'Some passengers cannot be booked; nothing was booked', { failures });

/** Coded error of a thrown E3 HttpException (null for anything else). */
const codeOf = (e: unknown): string | null => ((e as { getResponse?: () => unknown })?.getResponse?.() as { code?: string } | undefined)?.code ?? null;

/** Serialises the bookings of one passenger (create / edit overlap check) until the transaction ends. */
async function lockPassenger(tx: Prisma.TransactionClient, profileId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'etms:booking:' + profileId}, 0))`;
}

export interface Replayable<T> {
  value: T;
  replay: boolean;
}

/** Options of BookingsService.create beyond the request body. */
export interface CreateOptions {
  /** DESK (default) or PASSENGER (self-service limits: refused after the cut-off). */
  actor?: BookingActor;
  /** Initial status chosen by the caller (D-A5: self-service REQUESTED while approval is on); else from `hold`. */
  status?: 'REQUESTED' | 'PENDING_ASSIGNMENT';
  /** WP 3.9 wave 2: why the ride is needed (≤ TRANSPORT_ADHOC_LIMITS.purposeMax, trimmed; empty = none). */
  purpose?: string | null;
}

/** Trimmed purpose text (single spaces), null when empty; longer than purposeMax → 400. */
export function cleanPurpose(raw: string | null | undefined): string | null {
  const p = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!p) return null;
  if (p.length > TRANSPORT_ADHOC_LIMITS.purposeMax) throw invalid(`The purpose can be at most ${TRANSPORT_ADHOC_LIMITS.purposeMax} characters`);
  return p;
}

/** D-A5: the passenger notification of a desk decision on a booking (approve of a waiting booking / reject), else null. */
export function decisionKind(command: 'approve' | 'reject' | 'cancel', from: string): 'BOOKING_APPROVED' | 'BOOKING_REJECTED' | null {
  if (command === 'reject') return 'BOOKING_REJECTED';
  if (command === 'approve' && (from === 'REQUESTED' || from === 'WAITLISTED')) return 'BOOKING_APPROVED';
  return null;
}

/**
 * Bookings (05 §2.5, 15 §5.4; 12 WP 3.3). Reads: own company (branch-scoped for ASSIGNED users) plus customers whose
 * agreement grants VIEW_BOOKINGS (read-only). Writes (R1): own company only. Create needs an Idempotency-Key (double
 * submit = one booking; same key + other body = 422) and is rate limited per user. The partial unique index refuses a
 * second active booking of a passenger, date and direction (409 BOOKING_DUPLICATE). Commands follow
 * BOOKING_TRANSITIONS; changes need expectedVersion (409 VERSION_CONFLICT). WP 3.9: journeys (COMMUTE /
 * POINT_TO_POINT), the shared eligibility / consent rules, late bookings with a reason (D-A1), BOOKING_CREATED (D-A4).
 */
@Injectable()
export class BookingsService {
  private readonly limiter: FixedWindowLimiter;
  private readonly bulkLimiter: FixedWindowLimiter;
  private readonly notifications: TransportNotificationsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    redis: RedisService,
    @Optional() notifications?: TransportNotificationsService,
  ) {
    // Stateless (Prisma + Valkey): built here when the module does not inject one (tests, other modules).
    this.notifications = notifications ?? new TransportNotificationsService(prisma, redis);
    this.limiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:rl:booking-create', TRANSPORT_E3_LIMITS.bookingCreatesPerMinute, 60_000);
    // L6: bulk approve runs up to maxBulk transactions per request.
    this.bulkLimiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:rl:booking-bulk', TRANSPORT_E3_LIMITS.bulkApprovesPerMinute, 60_000);
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
    if (q.journey) filters.push({ journey: q.journey });
    // afterCutoff ⇔ a dispatcher's late reason is stored (see toBookingDto).
    if (q.afterCutoff === 'true') filters.push({ lateReason: { not: null } });
    if (q.afterCutoff === 'false') filters.push({ lateReason: null });
    if (q.groupId) filters.push({ groupId: q.groupId });
    // CSV export (E2 security review M4 applied to E3): only the caller's own company's bookings, never a partner's.
    if (q.format === 'csv') filters.push({ customerCompanyId: ctx.companyId });
    const where: Prisma.TransportBookingWhereInput = { AND: filters };
    const [rows, total] = await Promise.all([
      this.prisma.transportBooking.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: BOOKING_INCLUDE }),
      this.prisma.transportBooking.count({ where }),
    ]);
    const now = Date.now();
    return listResult(plan, await withGroupSizes(this.prisma, rows.map((r) => toBookingDto(r, ctx, LIST_VIEW, now))), total, CSV);
  }

  /** The desk's booking-form policy (WP 3.9): company cut-off, days ahead, late-reason limits. */
  async policy(ctx: AuthContext): Promise<TransportBookingPolicyDto> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
    return {
      cutoffMin: cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin),
      maxDaysAhead: TRANSPORT_E3_LIMITS.adhocMaxDaysAhead,
      lateReasonMin: TRANSPORT_E3_LIMITS.lateReasonMin,
      lateReasonMax: TRANSPORT_E3_LIMITS.lateReasonMax,
    };
  }

  /** Company places a booking may use (WP 3.9, D-A2): active Pois of the caller's company, name search, at most 50. */
  async places(ctx: AuthContext, q: string | undefined): Promise<TransportPlaceOptionDto[]> {
    const term = (q ?? '').trim().slice(0, 100);
    const rows = await this.prisma.poi.findMany({
      where: { companyId: ctx.companyId, isActive: true, ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}) },
      select: { id: true, name: true, category: true, lat: true, lng: true, companyId: true },
      orderBy: { name: 'asc' },
      take: 50,
    });
    return rows.filter((r) => r.companyId === ctx.companyId).map((r) => ({ id: r.id, name: r.name, category: r.category ?? null, lat: r.lat, lng: r.lng }));
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

  /**
   * Ad-hoc booking (05 §2.5; WP 3.9). `actor` = DESK (dispatcher, default) or PASSENGER (self-service, which calls this
   * with its own limits on top). Rules, in order: idempotent replay (same user + body) → rate limit → passenger in the
   * caller's branches (404) → eligibility (422 NOT_ELIGIBLE) → dates / window → points (company place or a consented
   * personal point, 409 CONSENT_REQUIRED) → cut-off (DESK: 409 LATE_REASON_REQUIRED without a reason; PASSENGER: 409
   * AFTER_CUTOFF) → COMMUTE duplicate (409 BOOKING_DUPLICATE) → in the transaction, under a per-passenger lock, the
   * time overlap (409 BOOKING_OVERLAP) → row + audit (+ BOOKING_CREATED for the passenger when someone else booked, in
   * the same transaction; the push job is queued after commit).
   */
  async create(ctx: AuthContext, dto: CreateBookingDto, rawKey: string | undefined, opts: CreateOptions = {}): Promise<Replayable<TransportBookingDto>> {
    const actor = opts.actor ?? 'DESK';
    const key = idempotencyKey(rawKey);
    const purpose = cleanPurpose(opts.purpose);
    // The purpose is part of the request (a replay with another purpose is another request); the approval status is not
    // (it follows the company setting at creation time, a replay answers what was stored).
    const hash = requestHash(purpose ? { ...dto, purpose } : dto);
    const prior = await this.prisma.transportBooking.findFirst({ where: { customerCompanyId: ctx.companyId, idempotencyKey: key }, include: BOOKING_INCLUDE });
    if (prior) {
      // L3: a key replays only for the user who used it, and only after the same read check as GET /bookings/:id.
      if (prior.idempotencyHash !== hash || prior.createdById !== ctx.userId) throw idempotencyReused();
      assertBookingAccess(ctx, prior, 'read');
      return { value: await this.detail(ctx, prior), replay: true };
    }
    const rl = await this.limiter.hit(ctx.userId);
    if (!rl.allowed) throw e3Error(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `Too many bookings; try again in ${rl.retryAfterSec} s`, { retryAfterSec: rl.retryAfterSec });

    const journey: TransportBookingJourney = dto.journey ?? 'COMMUTE';
    const day = serviceDate(dto.serviceDate);
    const seats = dto.passengerCount ?? 1;
    const { profile, shift } = await this.eligible(ctx, dto.passengerId, dto.shiftId ?? null, day, seats);
    let direction: TransportDirection;
    if (journey === 'POINT_TO_POINT') {
      if (!dto.pickup || !dto.drop) throw invalid('A point-to-point booking needs a pickup and a destination');
      if (!dto.windowStart || !dto.windowEnd) throw invalid('A point-to-point booking needs the time window');
      direction = 'IN'; // contract: pickups before drops on the trip
    } else {
      if (!dto.direction) throw invalid('Choose the direction (to or from the office)');
      direction = dto.direction;
    }
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true, settings: true } });
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
      const w = legWindow(shift, direction, day);
      start = w.start;
      end = w.end;
    }
    checkWindow(start, end);
    if (end < Date.now()) throw invalid('The window has already passed');

    // Points (D-A3): a given point is a company place (poiId) or a personal point that needs the active consent. The
    // COMMUTE defaults: the passenger end = the routing pickup (only with consent, else "needs location", nothing
    // stored); the office end = the shift's site.
    const consent = await this.consentActive(profile.id);
    const site: GeoPoint | null = journey === 'COMMUTE' && shift?.sitePoi ? { lat: shift.sitePoi.lat, lng: shift.sitePoi.lng, label: shift.sitePoi.name, poiId: shift.sitePoi.id } : null;
    const home: GeoPoint | null =
      journey !== 'COMMUTE' || !consent
        ? null
        : profile.defaultStop
          ? { lat: profile.defaultStop.lat, lng: profile.defaultStop.lng, label: profile.defaultStop.name, poiId: profile.defaultStop.id }
          : profile.homeLat !== null && profile.homeLng !== null
            ? { lat: profile.homeLat, lng: profile.homeLng, label: null, poiId: null }
            : null;
    const pickup = dto.pickup ? await this.point(ctx, dto.pickup, consent) : direction === 'IN' ? home : site;
    const drop = dto.drop ? await this.point(ctx, dto.drop, consent) : direction === 'IN' ? site : home;

    // Cut-off (D-A1).
    const cutoffAt = start - cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin) * 60_000;
    const now = Date.now();
    let lateReason: string | null = null;
    if (isLate(cutoffAt, now)) {
      if (actor === 'PASSENGER') throw conflict('AFTER_CUTOFF', 'The booking cut-off for this trip has passed; contact the transport desk');
      lateReason = requireLateReason(dto.lateReason);
    }

    if (journey === 'COMMUTE') {
      const duplicate = await this.prisma.transportBooking.findFirst({
        where: { profileId: profile.id, serviceDate: dateOnly(day), direction, journey: 'COMMUTE', status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        select: { id: true },
      });
      if (duplicate) {
        // Harness HD1: the "duplicate" may be this very request's twin (same Idempotency-Key, sent in parallel): replay it.
        const twin = await this.replayOf(ctx, key, hash);
        if (twin) return twin;
        throw conflict('BOOKING_DUPLICATE', 'The passenger already has an active booking for this date and direction', { bookingId: duplicate.id });
      }
    }

    // D-A4: someone else (the desk) booked for the passenger. Self-service books with the passenger's own login.
    const notifyUser = profile.userId && profile.userId !== ctx.userId ? profile.userId : null;
    try {
      const { row, push } = await this.prisma.$transaction(async (tx) => {
        await lockPassenger(tx, profile.id);
        const clash = await tx.transportBooking.findFirst({ where: overlapWhere(profile.id, journey, start, end), select: { id: true } });
        if (clash) throw overlapConflict(clash.id);
        const created = await tx.transportBooking.create({
          data: {
            customerCompanyId: ctx.companyId,
            profileId: profile.id,
            shiftId: shift?.id ?? null,
            source: 'ADHOC',
            journey,
            serviceDate: dateOnly(day),
            direction,
            timeZone: tz,
            ...this.columns('pickup', pickup),
            ...this.columns('drop', drop),
            windowStart: new Date(start),
            windowEnd: new Date(end),
            passengerCount: seats,
            status: opts.status ?? (dto.hold ? 'REQUESTED' : 'PENDING_ASSIGNMENT'),
            cutoffAt: new Date(cutoffAt),
            lateReason,
            purpose,
            idempotencyKey: key,
            idempotencyHash: hash,
            note: dto.note?.trim() || null,
            createdById: ctx.userId,
          },
          include: BOOKING_INCLUDE,
        });
        const notified = notifyUser
          ? await this.notifications.write(tx, [
              {
                companyId: ctx.companyId,
                userId: notifyUser,
                audience: 'PASSENGER',
                kind: 'BOOKING_CREATED',
                tripId: null,
                bookingId: created.id,
                dedupeKey: `bkc:${created.id}:${notifyUser}`,
                push: passengerPushAllowed(profile.preferences, 'BOOKING_CREATED'),
              },
            ])
          : { ids: [], push: [] };
        await this.audit.record(
          ctx,
          {
            action: 'CREATE',
            entity: BOOKING_ENTITY,
            entityId: created.id,
            // AuditService keeps only the snapshot diff when one is given, so the WP 3.9 facts ride on the snapshot.
            after: {
              ...bookingSnapshot(created),
              actor,
              ...(lateReason ? { late: lateAudit(cutoffAt, created.createdAt, ctx.userId, lateReason, 'createdAt') } : {}),
              ...(notified.ids.length ? { passengerNotified: 'BOOKING_CREATED' } : {}),
            },
          },
          tx,
        );
        return { row: created, push: notified.push };
      });
      await this.notifications.enqueue(push);
      return { value: await this.detail(ctx, row), replay: false };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotencyKey')) {
        // A concurrent request with the same key won the race: answer as its replay.
        const winner = await this.prisma.transportBooking.findFirst({ where: { customerCompanyId: ctx.companyId, idempotencyKey: key }, include: BOOKING_INCLUDE });
        if (winner && winner.idempotencyHash === hash && winner.createdById === ctx.userId) return { value: await this.detail(ctx, winner), replay: true };
        throw idempotencyReused();
      }
      if (codeOf(e) === 'BOOKING_OVERLAP' || isOverlapExclusion(e)) {
        const twin = await this.replayOf(ctx, key, hash); // HD1: the key's own twin committed first
        if (twin) return twin;
        if (codeOf(e) === 'BOOKING_OVERLAP') throw e;
        throw overlapConflict(await this.overlapping(profile.id, journey, start, end));
      }
      if (isUniqueViolation(e)) {
        const twin = await this.replayOf(ctx, key, hash); // HD1: the active-booking index fired for the key's own twin
        if (twin) return twin;
        throw conflict('BOOKING_DUPLICATE', 'The passenger already has an active booking for this date and direction');
      }
      throw e;
    }
  }

  /** The committed booking of this Idempotency-Key, replayed when the body and the user match (HD1), else null. */
  private async replayOf(ctx: AuthContext, key: string, hash: string): Promise<Replayable<TransportBookingDto> | null> {
    const prior = await this.prisma.transportBooking.findFirst({ where: { customerCompanyId: ctx.companyId, idempotencyKey: key }, include: BOOKING_INCLUDE });
    if (!prior) return null;
    if (prior.idempotencyHash !== hash || prior.createdById !== ctx.userId) throw idempotencyReused();
    assertBookingAccess(ctx, prior, 'read');
    return { value: await this.detail(ctx, prior), replay: true };
  }

  // ───────────────────────────── group booking (WP 3.9 wave 2, D-A8) ─────────────────────────────

  /**
   * POST /transport/bookings/group: one booking per passenger sharing `groupId` and `purpose`, all or nothing in ONE
   * transaction. Order: idempotent replay (per-passenger keys `<key>/<passengerId>`, same user + body) → rate limit →
   * every passenger in the caller's scope (one out of scope: 404 for the whole request) → shared checks (shift, dates,
   * window, cut-off / late reason) → per-passenger checks collected (NOT_ELIGIBLE, CONSENT_REQUIRED, NEEDS_LOCATION,
   * BOOKING_DUPLICATE, BOOKING_OVERLAP) → 422 GROUP_INVALID { failures } → in the transaction, under every passenger's
   * lock (sorted), duplicates / overlaps again (a concurrent booking: GROUP_INVALID, nothing written) → rows + audit +
   * BOOKING_CREATED per passenger with a login other than the caller (push queued after commit).
   * Points: COMMON = one company place, or a one-time point that (D-A3) needs each passenger's consent; OWN = each
   * passenger's routing pickup: their default stop (a company place) or, with consent, their home point.
   */
  async createGroup(ctx: AuthContext, dto: CreateGroupBookingDto, rawKey: string | undefined): Promise<Replayable<TransportGroupBookingResult>> {
    const key = idempotencyKey(rawKey);
    const ids = dto.passengerIds;
    if (new Set(ids).size !== ids.length) throw invalid('Each passenger can be in the group only once');
    if (ids.length < TRANSPORT_ADHOC_LIMITS.groupMin || ids.length > TRANSPORT_ADHOC_LIMITS.groupMax) throw invalid(`A group has ${TRANSPORT_ADHOC_LIMITS.groupMin} to ${TRANSPORT_ADHOC_LIMITS.groupMax} passengers`);
    const purpose = cleanPurpose(dto.purpose);
    if (!purpose) throw invalid('Give the purpose of the group ride');
    const hash = requestHash(dto);
    const keys = new Map(ids.map((id) => [id, `${key}/${id}`]));
    const prior = await this.groupReplay(ctx, [...keys.values()], hash);
    if (prior) return prior;
    const rl = await this.limiter.hit(ctx.userId);
    if (!rl.allowed) throw e3Error(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `Too many bookings; try again in ${rl.retryAfterSec} s`, { retryAfterSec: rl.retryAfterSec });

    // Scope: the whole request is 404 when any passenger is not the caller's to book (no partial answer, no hint which).
    const profiles = await this.prisma.employeeTransportProfile.findMany({
      where: { id: { in: ids }, companyId: ctx.companyId },
      select: { id: true, companyId: true, branchId: true, userId: true, isActive: true, anonymisedAt: true, preferences: true, homeLat: true, homeLng: true, defaultStop: { select: { id: true, name: true, lat: true, lng: true, isActive: true } } },
    });
    const byId = new Map(profiles.filter((p) => p.companyId === ctx.companyId && inProfileBranch(ctx, p.branchId)).map((p) => [p.id, p]));
    if (ids.some((id) => !byId.has(id))) throw notFound('Passenger not found');

    const journey: TransportBookingJourney = dto.journey ?? 'COMMUTE';
    const day = serviceDate(dto.serviceDate);
    const shift = dto.shiftId ? await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId }, include: { sitePoi: true } }) : null;
    if (dto.shiftId && (!shift || shift.companyId !== ctx.companyId)) throw invalid('Unknown shift');
    let direction: TransportDirection;
    if (journey === 'POINT_TO_POINT') {
      if (!dto.windowStart || !dto.windowEnd) throw invalid('A point-to-point booking needs the time window');
      direction = 'IN';
    } else {
      if (!dto.direction) throw invalid('Choose the direction (to or from the office)');
      direction = dto.direction;
    }
    if (dto.pickup.mode === 'COMMON' && !dto.pickup.point) throw invalid('Give the common pickup point');
    if (dto.pickup.mode === 'OWN' && direction === 'OUT') throw invalid('Own home pickup is for rides to the office or point-to-point rides');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true, settings: true } });
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
      const w = legWindow(shift, direction, day);
      start = w.start;
      end = w.end;
    }
    checkWindow(start, end);
    if (end < Date.now()) throw invalid('The window has already passed');
    const cutoffAt = start - cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin) * 60_000;
    const lateReason = isLate(cutoffAt, Date.now()) ? requireLateReason(dto.lateReason) : null;

    // Shared points: a company place is checked once (422 PLACE_NOT_ALLOWED for the request); a one-time point is
    // validated once and needs each passenger's consent (collected below).
    const drop = await this.point(ctx, dto.drop, true);
    const common = dto.pickup.mode === 'COMMON' ? await this.point(ctx, dto.pickup.point!, true) : null;
    const consents = await activeRoutingConsents(this.prisma, ids);

    const failures: TransportGroupFailure[] = [];
    const pickups = new Map<string, GeoPoint>();
    for (const id of ids) {
      const p = byId.get(id)!;
      const bad = ineligibility({ profile: { isActive: p.isActive !== false, anonymisedAt: p.anonymisedAt ?? null }, shift: shift ? { isActive: shift.isActive !== false, days: shift.days } : null, weekday: weekdayOf(day), passengerCount: 1 });
      if (bad) {
        failures.push({ passengerId: id, code: 'NOT_ELIGIBLE', reason: bad.reason });
        continue;
      }
      const consent = consents.has(id);
      if ((!drop.poiId || (common && !common.poiId)) && !consent) {
        failures.push({ passengerId: id, code: 'CONSENT_REQUIRED' });
        continue;
      }
      if (common) pickups.set(id, common);
      else if (p.defaultStop && p.defaultStop.isActive !== false) pickups.set(id, { lat: p.defaultStop.lat, lng: p.defaultStop.lng, label: p.defaultStop.name, poiId: p.defaultStop.id });
      else if (!consent) failures.push({ passengerId: id, code: 'CONSENT_REQUIRED' });
      else if (p.homeLat === null || p.homeLng === null) failures.push({ passengerId: id, code: 'NEEDS_LOCATION' });
      else pickups.set(id, { lat: p.homeLat, lng: p.homeLng, label: null, poiId: null });
    }
    const conflicts = (db: Pick<Prisma.TransactionClient, 'transportBooking'>, only: string[]) => this.groupConflicts(db, only, journey, day, direction, start, end);
    failures.push(...(await conflicts(this.prisma, ids.filter((id) => !failures.some((f) => f.passengerId === id)))));
    if (failures.length) throw groupInvalid(failures);

    const groupId = randomUUID();
    const status = dto.hold ? 'REQUESTED' : 'PENDING_ASSIGNMENT';
    try {
      const { rows, push } = await this.prisma.$transaction(async (tx) => {
        for (const id of [...ids].sort()) await lockPassenger(tx, id);
        const late = await conflicts(tx, ids);
        if (late.length) throw groupInvalid(late);
        const rows: BookingRow[] = [];
        const notify: NotifyItem[] = [];
        for (const id of ids) {
          const p = byId.get(id)!;
          const pickup = pickups.get(id)!;
          const created = await tx.transportBooking.create({
            data: {
              customerCompanyId: ctx.companyId,
              profileId: id,
              shiftId: shift?.id ?? null,
              source: 'ADHOC',
              journey,
              serviceDate: dateOnly(day),
              direction,
              timeZone: tz,
              ...this.columns('pickup', pickup),
              ...this.columns('drop', drop),
              windowStart: new Date(start),
              windowEnd: new Date(end),
              passengerCount: 1,
              status,
              cutoffAt: new Date(cutoffAt),
              lateReason,
              groupId,
              purpose,
              idempotencyKey: keys.get(id)!,
              idempotencyHash: hash,
              note: dto.note?.trim() || null,
              createdById: ctx.userId,
            },
            include: BOOKING_INCLUDE,
          });
          rows.push(created);
          if (p.userId && p.userId !== ctx.userId) {
            notify.push({ companyId: ctx.companyId, userId: p.userId, audience: 'PASSENGER', kind: 'BOOKING_CREATED', tripId: null, bookingId: created.id, dedupeKey: `bkc:${created.id}:${p.userId}`, push: passengerPushAllowed(p.preferences, 'BOOKING_CREATED') });
          }
        }
        const notified = await this.notifications.write(tx, notify);
        // Fresh booking ids: every dedupe key is new, so each item is written.
        const notifiedBookings = new Set(notify.map((n) => n.bookingId));
        for (const created of rows) {
          await this.audit.record(
            ctx,
            {
              action: 'CREATE',
              entity: BOOKING_ENTITY,
              entityId: created.id,
              after: {
                ...bookingSnapshot(created),
                actor: 'DESK',
                groupSize: ids.length,
                ...(lateReason ? { late: lateAudit(cutoffAt, created.createdAt, ctx.userId, lateReason, 'createdAt') } : {}),
                ...(notifiedBookings.has(created.id) ? { passengerNotified: 'BOOKING_CREATED' } : {}),
              },
            },
            tx,
          );
        }
        return { rows, push: notified.push };
      });
      await this.notifications.enqueue(push);
      return { value: { groupId, bookings: await Promise.all(rows.map((r) => this.detail(ctx, r))) }, replay: false };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotencyKey')) {
        // A concurrent twin with the same key committed first: answer as its replay.
        const twin = await this.groupReplay(ctx, [...keys.values()], hash);
        if (twin) return twin;
        throw idempotencyReused();
      }
      if (isUniqueViolation(e) || isOverlapExclusion(e)) {
        // A concurrent single booking won a passenger's slot after our checks: say who, nothing was written.
        const twin = await this.groupReplay(ctx, [...keys.values()], hash);
        if (twin) return twin;
        const now = await conflicts(this.prisma, ids);
        throw groupInvalid(now.length ? now : ids.map((passengerId) => ({ passengerId, code: 'BOOKING_DUPLICATE' })));
      }
      throw e;
    }
  }

  /** The committed group of these per-passenger keys (same user + body), else null; a mismatch is 422 IDEMPOTENCY_KEY_REUSED. */
  private async groupReplay(ctx: AuthContext, keys: string[], hash: string): Promise<Replayable<TransportGroupBookingResult> | null> {
    const found = await this.prisma.transportBooking.findMany({ where: { customerCompanyId: ctx.companyId, idempotencyKey: { in: keys } }, include: BOOKING_INCLUDE });
    if (!found.length) return null;
    const groupId = found[0].groupId;
    if (!groupId || found.length !== keys.length || found.some((b) => b.idempotencyHash !== hash || b.createdById !== ctx.userId || b.groupId !== groupId)) throw idempotencyReused();
    for (const b of found) assertBookingAccess(ctx, b, 'read');
    const order = new Map(keys.map((k, i) => [k, i]));
    const rows = [...found].sort((a, b) => (order.get(a.idempotencyKey ?? '') ?? 0) - (order.get(b.idempotencyKey ?? '') ?? 0));
    return { value: { groupId, bookings: await Promise.all(rows.map((r) => this.detail(ctx, r))) }, replay: true };
  }

  /** Per-passenger duplicate (COMMUTE, same date + direction) and overlap failures for a group's window. */
  private async groupConflicts(db: Pick<Prisma.TransactionClient, 'transportBooking'>, ids: string[], journey: TransportBookingJourney, day: string, direction: TransportDirection, start: number, end: number): Promise<TransportGroupFailure[]> {
    const out: TransportGroupFailure[] = [];
    for (const id of ids) {
      if (journey === 'COMMUTE') {
        const dup = await db.transportBooking.findFirst({ where: { profileId: id, serviceDate: dateOnly(day), direction, journey: 'COMMUTE', status: { in: [...ACTIVE_BOOKING_STATUSES] } }, select: { id: true } });
        if (dup) {
          out.push({ passengerId: id, code: 'BOOKING_DUPLICATE' });
          continue;
        }
      }
      const clash = await db.transportBooking.findFirst({ where: overlapWhere(id, journey, start, end), select: { id: true } });
      if (clash) out.push({ passengerId: id, code: 'BOOKING_OVERLAP' });
    }
    return out;
  }

  // ───────────────────────────── change ─────────────────────────────

  /**
   * PATCH (WP 3.9): while REQUESTED / PENDING_ASSIGNMENT / WAITLISTED; the shared eligibility and point / consent rules
   * of create; a missing pickup / drop can be set. After the (new) cut-off the desk needs `lateReason` (409
   * LATE_REASON_REQUIRED); the reason, cut-off, edit time and user are audited and `lateReason` is stored. An edit
   * never creates a trip or a seat.
   */
  async update(ctx: AuthContext, id: string, dto: UpdateBookingDto): Promise<TransportBookingDto> {
    const before = await this.find(ctx, id, 'write');
    if (!(UNSEATED_STATUSES as readonly string[]).includes(before.status)) throw conflict('INVALID_STATE', 'Only a booking without a seat can be changed; remove it from the trip first');
    if (before.version !== dto.expectedVersion) throw versionConflict(before.version);
    const seats = dto.passengerCount ?? before.passengerCount;
    const { profile } = await this.eligible(ctx, before.profileId, before.shiftId, dayKeyOf(before.serviceDate), seats);
    const consent = await this.consentActive(profile.id);
    const p2p = before.journey === 'POINT_TO_POINT';
    const data: Prisma.TransportBookingUncheckedUpdateManyInput = {};
    if (dto.pickup !== undefined) {
      if (p2p && !dto.pickup) throw invalid('A point-to-point booking needs a pickup');
      Object.assign(data, this.columns('pickup', dto.pickup ? await this.point(ctx, dto.pickup, consent) : null));
    }
    if (dto.drop !== undefined) {
      if (p2p && !dto.drop) throw invalid('A point-to-point booking needs a destination');
      Object.assign(data, this.columns('drop', dto.drop ? await this.point(ctx, dto.drop, consent) : null));
    }
    if (dto.passengerCount !== undefined) data.passengerCount = dto.passengerCount;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    let start = before.windowStart.getTime();
    let end = before.windowEnd.getTime();
    let cutoffAt = before.cutoffAt?.getTime() ?? null;
    const windowChanged = dto.windowStart !== undefined || dto.windowEnd !== undefined;
    if (windowChanged) {
      start = dto.windowStart !== undefined ? parseInstant(dto.windowStart, 'windowStart') : start;
      end = dto.windowEnd !== undefined ? parseInstant(dto.windowEnd, 'windowEnd') : end;
      checkWindow(start, end);
      if (end < Date.now()) throw invalid('The window has already passed');
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
      cutoffAt = start - cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin) * 60_000;
      data.windowStart = new Date(start);
      data.windowEnd = new Date(end);
      data.cutoffAt = new Date(cutoffAt);
    }
    // D-A1: an edit after the cut-off (the new one when the window moves) needs the dispatcher's reason.
    const editedAt = new Date();
    const lateReason = isLate(cutoffAt, editedAt.getTime()) ? requireLateReason(dto.lateReason) : null;
    if (lateReason) data.lateReason = lateReason;
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await lockPassenger(tx, profile.id);
        if (windowChanged) {
          const clash = await tx.transportBooking.findFirst({ where: overlapWhere(profile.id, before.journey, start, end, id), select: { id: true } });
          if (clash) throw overlapConflict(clash.id);
        }
        const claimed = await tx.transportBooking.updateMany({ where: { id, version: dto.expectedVersion, status: before.status }, data: { ...data, version: { increment: 1 } } });
        if (!claimed.count) throw versionConflict(before.version);
        const after = await tx.transportBooking.findUniqueOrThrow({ where: { id }, include: BOOKING_INCLUDE });
        await this.audit.record(
          ctx,
          {
            action: 'UPDATE',
            entity: BOOKING_ENTITY,
            entityId: id,
            before: bookingSnapshot(before),
            after: { ...bookingSnapshot(after), ...(lateReason ? { late: lateAudit(cutoffAt!, editedAt, ctx.userId, lateReason, 'editedAt') } : {}) },
          },
          tx,
        );
        return after;
      });
      return await this.detail(ctx, row);
    } catch (e) {
      if (isOverlapExclusion(e)) throw overlapConflict(await this.overlapping(profile.id, before.journey, start, end, id));
      throw e;
    }
  }

  /** approve / reject / cancel (05 §2.5). Cancelling a seated booking takes the passenger off the trip in the same transaction. */
  async command(ctx: AuthContext, id: string, command: Extract<TransportBookingCommand, 'approve' | 'reject' | 'cancel'>, dto: BookingCommandDto): Promise<TransportBookingDto> {
    const before = await this.find(ctx, id, 'write');
    const next = bookingTransition(before.status, command);
    if (!next) throw conflict('INVALID_STATE', `A ${before.status.toLowerCase().replace('_', ' ')} booking cannot be ${command === 'approve' ? 'approved' : command === 'reject' ? 'rejected' : 'cancelled'}`);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== before.version) throw versionConflict(before.version);
    const reason = dto.reason?.trim() || null;
    if ((command === 'reject' || command === 'cancel') && !reason) throw invalid('Give a reason');
    const kind = decisionKind(command, before.status);
    const { row, push } = await this.prisma.$transaction(async (tx) => {
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
        data: { status: next, statusReason: command === 'approve' ? null : reason, ...(kind === 'BOOKING_APPROVED' ? { approvedAt: new Date() } : {}), version: { increment: 1 } },
      });
      if (!claimed.count) throw versionConflict(before.version);
      const after = await tx.transportBooking.findUniqueOrThrow({ where: { id }, include: BOOKING_INCLUDE });
      // D-A5: the passenger hears about the decision on any booking they can see (GET /me/transport/bookings lists all
      // their bookings: self-made, desk-made, schedule-generated) when they have a login that is not the caller. Generic
      // push; the reject reason is read through the API (MeBookingDto.statusReason). Committed with the decision; the
      // dedupe key includes the decided version, so a retried / bulk approve can never notify twice.
      const passenger = kind ? await tx.employeeTransportProfile.findFirst({ where: { id: before.profileId, companyId: before.customerCompanyId }, select: { userId: true, preferences: true } }) : null;
      const notifyUser = kind && passenger?.userId && passenger.userId !== ctx.userId ? passenger.userId : null;
      const notified =
        kind && notifyUser
          ? await this.notifications.write(tx, [
              {
                companyId: before.customerCompanyId,
                userId: notifyUser,
                audience: 'PASSENGER',
                kind,
                tripId: null,
                bookingId: id,
                dedupeKey: `${kind === 'BOOKING_APPROVED' ? 'bka' : 'bkr'}:${id}:v${before.version}:${notifyUser}`,
                push: passengerPushAllowed(passenger!.preferences, kind),
              },
            ])
          : { ids: [], push: [] };
      await this.audit.record(
        ctx,
        { action: 'UPDATE', entity: BOOKING_ENTITY, entityId: id, before: bookingSnapshot(before), after: { ...bookingSnapshot(after), ...(notified.ids.length ? { passengerNotified: kind } : {}) }, details: { command, reason } },
        tx,
      );
      return { row: after, push: notified.push };
    });
    await this.notifications.enqueue(push);
    return await this.detail(ctx, row);
  }

  async bulkApprove(ctx: AuthContext, ids: string[]): Promise<BulkApproveTransportBookingsResult> {
    const rl = await this.bulkLimiter.hit(ctx.userId);
    if (!rl.allowed) throw e3Error(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `Too many bulk approvals; try again in ${rl.retryAfterSec} s`, { retryAfterSec: rl.retryAfterSec });
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
    const [dto] = await withGroupSizes(this.prisma, [toBookingDto(row, ctx, { view: 'detail', consent: await this.consentActive(row.profileId) })]);
    return dto;
  }

  /** Routing consent under the E2 final model (activeRoutingConsents). */
  private async consentActive(profileId: string): Promise<boolean> {
    return (await activeRoutingConsents(this.prisma, [profileId])).has(profileId);
  }

  /**
   * A point from the request. A company place (poiId) must be an active Poi of the caller's company (422 NOT_ELIGIBLE
   * PLACE_NOT_ALLOWED; its coordinates win). Anything else is a personal point (D-A3): only with the passenger's active
   * routing consent (409 CONSENT_REQUIRED, checked before the point is validated or stored).
   */
  private async point(ctx: AuthContext, p: GeoPoint, consent: boolean): Promise<GeoPoint> {
    if (p.poiId) {
      const poi = await this.prisma.poi.findFirst({ where: { id: p.poiId, companyId: ctx.companyId, isActive: true }, select: { id: true, name: true, lat: true, lng: true } });
      if (!poi) throw notEligible('PLACE_NOT_ALLOWED', 'That place is not an active place of your company');
      return { lat: poi.lat, lng: poi.lng, label: p.label?.trim() || poi.name, poiId: poi.id };
    }
    if (!consent) throw personalPointConsentRequired();
    if (!validPoint(p)) throw invalid('A point must have a valid latitude and longitude (not 0, 0)');
    return { lat: p.lat, lng: p.lng, label: p.label?.trim() || null, poiId: null };
  }

  /**
   * The shared eligibility rule (WP 3.9 B2): the passenger is a profile of the caller's company in its branches (404
   * otherwise, as before), active and not erased; the shift, when given, is the company's (400 unknown), active and
   * runs that weekday; the seats are within limits. 422 NOT_ELIGIBLE with the reason.
   */
  private async eligible(ctx: AuthContext, profileId: string, shiftId: string | null, day: string, seats: number) {
    const profile = await this.prisma.employeeTransportProfile.findFirst({
      where: { id: profileId, companyId: ctx.companyId },
      select: { id: true, companyId: true, branchId: true, userId: true, isActive: true, anonymisedAt: true, preferences: true, homeLat: true, homeLng: true, defaultStop: { select: { id: true, name: true, lat: true, lng: true } } },
    });
    if (!profile || profile.companyId !== ctx.companyId || !inProfileBranch(ctx, profile.branchId)) throw notFound('Passenger not found');
    const shift = shiftId ? await this.prisma.transportShift.findFirst({ where: { id: shiftId, companyId: ctx.companyId }, include: { sitePoi: true } }) : null;
    if (shiftId && (!shift || shift.companyId !== ctx.companyId)) throw invalid('Unknown shift');
    assertEligible({
      profile: { isActive: profile.isActive !== false, anonymisedAt: profile.anonymisedAt ?? null },
      shift: shift ? { isActive: shift.isActive !== false, days: shift.days } : null,
      weekday: weekdayOf(day),
      passengerCount: seats,
    });
    return { profile, shift };
  }

  /** The active booking a window clashes with (for the 409 body after the exclusion constraint fired), else null. */
  private async overlapping(profileId: string, journey: TransportBookingJourney, start: number, end: number, exceptId?: string): Promise<string | null> {
    return (await this.prisma.transportBooking.findFirst({ where: overlapWhere(profileId, journey, start, end, exceptId), select: { id: true } }))?.id ?? null;
  }

  private columns(side: 'pickup' | 'drop', p: GeoPoint | null): Record<string, number | string | null> {
    return { [`${side}Lat`]: p?.lat ?? null, [`${side}Lng`]: p?.lng ?? null, [`${side}Label`]: p?.label ?? null, [`${side}PoiId`]: p?.poiId ?? null };
  }

}
