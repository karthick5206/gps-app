import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ACTIVE_TRIP_STATUSES_FOR_OVERLAP,
  BOOKING_HOLD_REASON_MAX,
  SHARING_POLICY_TEXT_MAX,
  VEHICLE_AVAILABILITY_KINDS,
  VEHICLE_AVAILABILITY_LIMITS,
  type DriverHoursPolicy,
  type PlannedTripStatus,
  type PoolingSettingsDto,
  type TransportBookingDto,
  type TransportSharingPolicyDto,
  type VehicleAvailabilityDto,
} from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { setCompanySetting } from '../../common/company-settings';
import { PrismaService } from '../../prisma/prisma.service';
import { BOOKING_ENTITY, BookingsService } from '../dispatch/bookings.service';
import { UNSEATED_STATUSES } from '../dispatch/booking-generator.service';
import { assertBookingAccess, bookingReadWhere, conflict, invalid, notFound, versionConflict } from '../dispatch/e3-common';
import { lockBookings } from '../dispatch/trip-ops';
import { LimitsError, validateLimits } from './pooling-rules';
import { driverHoursOf, POOLING_SETTINGS_KEY, poolingSettingsOf } from './pooling-settings';
import { currentPolicy } from './sharing-policy';
import type { HoldDto, PoolingSettingsBody, PutAvailabilityDto, SharingPolicyBody } from './pooling.dto';

const DAY = 86_400_000;

/** Whole-company scope for company-wide pooling settings (like the transport settings form). */
function requireCompanyScope(ctx: AuthContext): void {
  if (ctx.dataScope !== 'COMPANY') throw new ForbiddenException({ message: 'Only users with whole-company access can change this setting', code: 'SCOPE_REQUIRED' });
}

/**
 * Pooling administration (doc 20 B1 / C1): dispatcher hold, the sharing policy (append-only versions), pooling and
 * live-dispatch settings, the driver working-hour policy and the vehicle availability timeline. Every change audited.
 */
@Injectable()
export class PoolingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
  ) {}

  // ───────────────────────────── hold ─────────────────────────────

  async hold(ctx: AuthContext, id: string, dto: HoldDto): Promise<TransportBookingDto> {
    const before = await this.prisma.transportBooking.findFirst({ where: { AND: [bookingReadWhere(ctx), { id }] }, include: { profile: { select: { branchId: true } } } });
    if (!before || before.customerCompanyId !== ctx.companyId) throw notFound('Booking not found');
    assertBookingAccess(ctx, before, 'write');
    const reason = dto.reason?.trim().replace(/\s+/g, ' ') || null;
    if (dto.hold && (!reason || reason.length < 3)) throw invalid('Give a reason for the hold');
    if (reason && reason.length > BOOKING_HOLD_REASON_MAX) throw invalid(`The reason can be at most ${BOOKING_HOLD_REASON_MAX} characters`);
    await this.prisma.$transaction(async (tx) => {
      await lockBookings(tx, [id]);
      const b = await tx.transportBooking.findUniqueOrThrow({ where: { id } });
      if (b.version !== dto.expectedVersion) throw versionConflict(b.version);
      if (!(UNSEATED_STATUSES as readonly string[]).includes(b.status)) throw conflict('INVALID_STATE', 'Only a booking waiting for a seat (or for approval) can be held or released');
      if (b.holdFromPlanning === dto.hold) return;
      const now = new Date();
      await tx.transportBooking.update({
        where: { id },
        data: dto.hold ? { holdFromPlanning: true, holdReason: reason, holdById: ctx.userId, holdAt: now, version: { increment: 1 } } : { holdFromPlanning: false, holdReason: null, holdById: null, holdAt: null, version: { increment: 1 } },
      });
      await this.audit.record(ctx, { action: 'UPDATE', entity: BOOKING_ENTITY, entityId: id, before: { holdFromPlanning: b.holdFromPlanning, version: b.version }, after: { holdFromPlanning: dto.hold, version: b.version + 1, ...(dto.hold ? { holdReason: reason } : {}) } }, tx);
    });
    return this.bookings.get(ctx, id);
  }

  // ───────────────────────────── sharing policy ─────────────────────────────

  async policy(ctx: AuthContext): Promise<TransportSharingPolicyDto> {
    return (await currentPolicy(this.prisma, ctx.companyId)).dto;
  }

  async updatePolicy(ctx: AuthContext, dto: SharingPolicyBody): Promise<TransportSharingPolicyDto> {
    requireCompanyScope(ctx);
    const text = dto.text.trim();
    if (text.length < 20 || text.length > SHARING_POLICY_TEXT_MAX) throw invalid(`The policy text must be 20–${SHARING_POLICY_TEXT_MAX} characters`);
    let limits;
    try {
      limits = { SHARED: validateLimits(dto.limits.SHARED, 'SHARED limits'), FLEXIBLE: validateLimits(dto.limits.FLEXIBLE, 'FLEXIBLE limits') };
    } catch (e) {
      if (e instanceof LimitsError) throw invalid(e.message);
      throw e;
    }
    const priority = Object.fromEntries(Object.entries(dto.priority ?? {}).filter(([k, v]) => ['PRIVATE', 'FLEXIBLE', 'SHARED'].includes(k) && typeof v === 'number' && v > 0 && v <= 100));
    await this.prisma.$transaction(async (tx) => {
      // Serialise versions per company (unique companyId + version is the backstop).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'etms:sharing-policy:' + ctx.companyId}, 0))`;
      const last = await tx.transportSharingPolicy.findFirst({ where: { companyId: ctx.companyId }, orderBy: { version: 'desc' }, select: { version: true } });
      const version = (last?.version ?? 0) + 1;
      const row = await tx.transportSharingPolicy.create({ data: { companyId: ctx.companyId, version, effectiveFrom: new Date(), text, allowFlexible: dto.allowFlexible ?? true, limits: limits as unknown as Prisma.InputJsonValue, priority: priority as Prisma.InputJsonValue, createdById: ctx.userId } });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'TransportSharingPolicy', entityId: row.id, details: { version, allowFlexible: row.allowFlexible, limits, priority } as unknown as Prisma.InputJsonValue }, tx);
    });
    return this.policy(ctx);
  }

  // ───────────────────────────── pooling / live-dispatch settings, driver hours ─────────────────────────────

  async settings(ctx: AuthContext): Promise<PoolingSettingsDto> {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
    return poolingSettingsOf(c.settings);
  }

  async updateSettings(ctx: AuthContext, dto: PoolingSettingsBody): Promise<PoolingSettingsDto> {
    requireCompanyScope(ctx);
    const before = await this.settings(ctx);
    const after = {
      liveDispatch: dto.liveDispatch ?? before.liveDispatch,
      scheduledPolicy: dto.scheduledPolicy ?? before.scheduledPolicy,
      delayPolicy: dto.delayPolicy ?? before.delayPolicy,
      delayThresholdS: dto.delayThresholdS ?? before.delayThresholdS,
      driverHours: dto.driverHours === undefined ? before.driverHours : dto.driverHours === null ? null : this.hoursOrThrow(dto.driverHours),
    };
    await this.prisma.$transaction(async (tx) => {
      await setCompanySetting(tx, ctx.companyId, POOLING_SETTINGS_KEY, after);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'etms_pooling_settings', entityId: ctx.companyId, before: { ...before, killSwitch: undefined } as unknown as Record<string, unknown>, after: after as unknown as Record<string, unknown> }, tx);
    });
    return this.settings(ctx);
  }

  /** PUT /transport/driver-policy: only the working-hour policy part of the pooling settings. */
  async updateDriverPolicy(ctx: AuthContext, dto: DriverHoursPolicy | null): Promise<PoolingSettingsDto> {
    return this.updateSettings(ctx, { driverHours: dto });
  }

  private hoursOrThrow(raw: DriverHoursPolicy): DriverHoursPolicy | null {
    const p = driverHoursOf(raw);
    for (const k of ['maxDutyS', 'maxDrivingS', 'breakAfterS', 'breakS', 'minRestS'] as const) {
      if (raw[k] !== null && raw[k] !== undefined && p?.[k] !== raw[k]) throw invalid(`driverHours.${k} is out of range`);
    }
    if (p && (p.breakAfterS === null) !== (p.breakS === null)) throw invalid('Give both breakAfterS and breakS (or neither)');
    return p;
  }

  // ───────────────────────────── vehicle availability ─────────────────────────────

  private async ownVehicle(ctx: AuthContext, objectId: string) {
    const o = await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(ctx), { id: objectId }] }, select: { id: true, companyId: true, maintenanceSince: true } });
    if (!o || o.companyId !== ctx.companyId) throw notFound('Vehicle not found');
    return o;
  }

  async availability(ctx: AuthContext, objectId: string): Promise<VehicleAvailabilityDto> {
    const o = await this.ownVehicle(ctx, objectId);
    const now = Date.now();
    const [rows, profile, busy] = await Promise.all([
      this.prisma.transportVehicleAvailability.findMany({ where: { objectId, companyId: ctx.companyId, endsAt: { gt: new Date(now - DAY) } }, orderBy: { startsAt: 'asc' }, take: VEHICLE_AVAILABILITY_LIMITS.maxWindows }),
      this.prisma.transportVehicleProfile.findUnique({ where: { objectId }, select: { turnaroundS: true } }),
      this.prisma.plannedTrip.findMany({ where: { objectId, status: { in: [...ACTIVE_TRIP_STATUSES_FOR_OVERLAP] as PlannedTripStatus[] }, plannedEnd: { gt: new Date(now) }, plannedStart: { lt: new Date(now + 7 * DAY) } }, orderBy: { plannedStart: 'asc' }, take: 200, select: { id: true, plannedStart: true, plannedEnd: true, status: true } }),
    ]);
    return {
      objectId,
      turnaroundS: profile?.turnaroundS ?? null,
      maintenanceSince: o.maintenanceSince?.toISOString() ?? null,
      windows: rows.map((r) => ({ id: r.id, kind: r.kind as VehicleAvailabilityDto['windows'][number]['kind'], startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), reason: r.reason })),
      busy: busy.map((b) => ({ plannedTripId: b.id, plannedStart: b.plannedStart.toISOString(), plannedEnd: b.plannedEnd.toISOString(), status: b.status })),
    };
  }

  async putAvailability(ctx: AuthContext, objectId: string, dto: PutAvailabilityDto): Promise<VehicleAvailabilityDto> {
    await this.ownVehicle(ctx, objectId);
    const from = dto.from ? Date.parse(dto.from) : Date.now();
    if (!Number.isFinite(from)) throw invalid('from must be a date and time');
    if (dto.windows.length > VEHICLE_AVAILABILITY_LIMITS.maxWindows) throw invalid(`At most ${VEHICLE_AVAILABILITY_LIMITS.maxWindows} windows`);
    const windows = dto.windows.map((w, i) => {
      const s = Date.parse(w.startsAt);
      const e = Date.parse(w.endsAt);
      if (!(VEHICLE_AVAILABILITY_KINDS as readonly string[]).includes(w.kind)) throw invalid(`Window ${i + 1}: unknown kind`);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw invalid(`Window ${i + 1}: endsAt must be after startsAt`);
      if (e < from) throw invalid(`Window ${i + 1}: ends before ${new Date(from).toISOString()}`);
      if (s > Date.now() + VEHICLE_AVAILABILITY_LIMITS.horizonDays * DAY) throw invalid(`Window ${i + 1}: at most ${VEHICLE_AVAILABILITY_LIMITS.horizonDays} days ahead`);
      const reason = w.reason?.trim() || null;
      if (reason && reason.length > VEHICLE_AVAILABILITY_LIMITS.reasonMax) throw invalid(`Window ${i + 1}: reason too long`);
      return { kind: w.kind, startsAt: new Date(s), endsAt: new Date(e), reason };
    });
    if (dto.turnaroundS !== undefined && dto.turnaroundS !== null && (!Number.isInteger(dto.turnaroundS) || dto.turnaroundS < 0 || dto.turnaroundS > VEHICLE_AVAILABILITY_LIMITS.turnaroundMaxS)) throw invalid('turnaroundS out of range');
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.transportVehicleAvailability.deleteMany({ where: { objectId, companyId: ctx.companyId, endsAt: { gt: new Date(from) } } });
      if (windows.length) await tx.transportVehicleAvailability.createMany({ data: windows.map((w) => ({ ...w, objectId, companyId: ctx.companyId, createdById: ctx.userId })) });
      if (dto.turnaroundS !== undefined) {
        const n = await tx.transportVehicleProfile.updateMany({ where: { objectId, companyId: ctx.companyId }, data: { turnaroundS: dto.turnaroundS } });
        if (!n.count && dto.turnaroundS !== null) throw conflict('NO_SEATS_SET', "Set the vehicle's passenger seats first (Transport → Vehicles)");
      }
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'TransportVehicleAvailability', entityId: objectId, details: { from: new Date(from).toISOString(), removed: removed.count, windows: windows.map((w) => ({ kind: w.kind, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })), ...(dto.turnaroundS !== undefined ? { turnaroundS: dto.turnaroundS } : {}) } as unknown as Prisma.InputJsonValue }, tx);
    });
    return this.availability(ctx, objectId);
  }
}
