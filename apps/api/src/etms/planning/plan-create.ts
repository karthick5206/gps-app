import { Body, Controller, Headers, HttpCode, Injectable, Post, Res, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ETMS_PLANNING_MENU, ROUTING_LIMITS, ROUTING_PROFILES, type RoutePlanDetailDto, type RoutePlanVersionSnapshot, type RoutingProfile } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { dateOnly, idempotencyKey, idempotencyReused, inProfileBranch, invalid, notFound, requestHash } from '../dispatch/e3-common';
import { PERSONAL_STOP_NAME } from '../dispatch/personal-points';
import { activeRoutingConsents } from '../people/people.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { PlanningFeatureGuard } from './planning-feature.guard';
import { PLAN_ENTITY, RoutePlansService } from './plans.service';

class PointDto {
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
}

/** Shared CreateRoutePlanRequest (ETMS fields required) + the vehicles of the plan. */
export class CreateRoutePlanDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) planDate!: string;
  @IsOptional() @IsISO8601() planStartAt?: string;
  @IsOptional() @IsIn(ROUTING_PROFILES) profile?: RoutingProfile;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() branchId?: string | null;
  /** Company place the vehicles start from (IN) / return to (OUT); never a personal point. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @ValidateNested() @Type(() => PointDto) depot?: PointDto | null;
  @IsIn(['IN', 'OUT']) direction!: 'IN' | 'OUT';
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() shiftId?: string | null;
  @IsUUID() sitePoiId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(ROUTING_LIMITS.optimizeVehicles) @IsUUID('all', { each: true }) objectIds!: string[];
}

export type CreatedRoutePlanDto = RoutePlanDetailDto & {
  /** Bookings of the service date / direction / site not put on the plan, and why (ids only). */
  skippedBookings: { bookingId: string; reason: 'consent_required' | 'needs_location' | 'out_of_scope' }[];
};

const H = 3_600_000;

/**
 * POST /api/transport/route-plans: a DRAFT plan built from the bookings waiting for a seat (PENDING_ASSIGNMENT) of the
 * caller's company for the service date, direction, site (and shift), plus one route per chosen vehicle.
 * Points: the booking's own pickup / drop (consented at the source), never a profile's home coordinates; a personal end
 * is used only with active routing consent (else the booking is skipped as consent_required). Site stops carry the
 * booking window (IN: arrival, OUT: departure, seconds after planStartAt). Idempotency-Key (stored in options.createKey
 * with the request hash). The client then starts the optimise job (POST /api/routing/jobs/optimize).
 */
@Injectable()
export class RoutePlanCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: RoutePlansService,
  ) {}

  async create(ctx: AuthContext, dto: CreateRoutePlanDto, rawKey: string | undefined): Promise<{ value: CreatedRoutePlanDto; replay: boolean }> {
    if (ctx.allCompanies) throw invalid('Select one company to plan its routes');
    const key = idempotencyKey(rawKey);
    const hash = requestHash(dto);
    const existing = await this.prisma.routePlan.findFirst({ where: { companyId: ctx.companyId, options: { path: ['createKey'], equals: key } }, select: { id: true, options: true } });
    if (existing) {
      const o = (existing.options ?? {}) as { createHash?: string };
      if (o.createHash !== hash) throw idempotencyReused();
      return { value: { ...(await this.plans.get(ctx, existing.id)), skippedBookings: [] }, replay: true };
    }
    // Another company's site is a 404 before anything else (no hint that it exists).
    const site = await this.prisma.poi.findFirst({ where: { id: dto.sitePoiId, companyId: ctx.companyId }, select: { id: true, name: true, lat: true, lng: true } });
    if (!site) throw notFound('Site not found');
    if (ctx.dataScope !== 'COMPANY' && (!dto.branchId || !ctx.branchIds.includes(dto.branchId))) throw invalid('Choose one of your branches for the plan');
    if (dto.shiftId && !(await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId }, select: { id: true } }))) throw notFound('Shift not found');
    const objectIds = [...new Set(dto.objectIds)];
    const objects = await this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds } }] }, select: { id: true, name: true, plateNumber: true } });
    if (objects.length !== objectIds.length) throw notFound('Vehicle not found');
    const seats = new Map((await this.prisma.transportVehicleProfile.findMany({ where: { objectId: { in: objectIds } }, select: { objectId: true, seats: true } })).map((v) => [v.objectId, v.seats]));

    const bookings = await this.prisma.transportBooking.findMany({
      where: {
        customerCompanyId: ctx.companyId,
        serviceDate: dateOnly(dto.planDate),
        direction: dto.direction,
        status: 'PENDING_ASSIGNMENT',
        ...(dto.shiftId ? { shiftId: dto.shiftId } : {}),
        ...(dto.direction === 'IN' ? { dropPoiId: site.id } : { pickupPoiId: site.id }),
      },
      include: { profile: { select: { branchId: true } } },
      orderBy: { windowStart: 'asc' },
    });
    const skipped: CreatedRoutePlanDto['skippedBookings'] = [];
    const inScope = bookings.filter((b) => {
      const ok = inProfileBranch(ctx, b.profile.branchId) && (!dto.branchId || !b.profile.branchId || b.profile.branchId === dto.branchId);
      if (!ok) skipped.push({ bookingId: b.id, reason: 'out_of_scope' });
      return ok;
    });
    // The passenger's end (IN: pickup, OUT: drop) is personal unless it is a company place.
    const personalEnd = (b: (typeof bookings)[number]) => (dto.direction === 'IN' ? { poiId: b.pickupPoiId, lat: b.pickupLat, lng: b.pickupLng } : { poiId: b.dropPoiId, lat: b.dropLat, lng: b.dropLng });
    const consents = await activeRoutingConsents(this.prisma, inScope.filter((b) => !personalEnd(b).poiId).map((b) => b.profileId));
    const usable = inScope.filter((b) => {
      const end = personalEnd(b);
      if (end.lat === null || end.lng === null) return void skipped.push({ bookingId: b.id, reason: 'needs_location' }), false;
      if (!end.poiId && !consents.has(b.profileId)) return void skipped.push({ bookingId: b.id, reason: 'consent_required' }), false;
      return true;
    });
    if (usable.length * 2 > ROUTING_LIMITS.planStops) throw invalid(`At most ${ROUTING_LIMITS.planStops / 2} bookings per plan (found ${usable.length}); narrow the plan by shift or branch`);
    const poiNames = new Map((await this.prisma.poi.findMany({ where: { companyId: ctx.companyId, id: { in: usable.map((b) => personalEnd(b).poiId).filter((p): p is string => !!p) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));

    const startMs = dto.planStartAt ? Date.parse(dto.planStartAt) : usable.length ? Math.floor((Math.min(...usable.map((b) => b.windowStart.getTime())) - 2 * H) / 60_000) * 60_000 : Date.parse(`${dto.planDate}T00:00:00Z`);
    const rel = (d: Date) => Math.max(0, Math.round((d.getTime() - startMs) / 1000));

    const planId = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.routePlan.create({
        data: {
          companyId: ctx.companyId,
          branchId: dto.branchId ?? null,
          name: dto.name.trim(),
          planDate: dateOnly(dto.planDate),
          planStartAt: new Date(startMs),
          status: 'DRAFT',
          profile: dto.profile ?? 'car',
          depot: dto.depot ? { lat: dto.depot.lat, lng: dto.depot.lng } : Prisma.DbNull,
          options: { createKey: key, createHash: hash },
          direction: dto.direction,
          shiftId: dto.shiftId ?? null,
          sitePoiId: site.id,
          createdById: ctx.userId,
        },
      });
      const assignments = [];
      for (const [i, id] of objectIds.entries()) {
        const o = objects.find((x) => x.id === id)!;
        assignments.push(await tx.routeAssignment.create({ data: { planId: plan.id, companyId: ctx.companyId, objectId: id, driverId: null, vehicleLabel: o.plateNumber ? `${o.name} (${o.plateNumber})` : o.name, seq: i, capacity: seats.get(id) ?? null, distanceM: null, durationS: null, adjustedDurationS: null, startS: null, endS: null } }));
      }
      // Unset columns spelled out (null), so every reader sees the same row as after a database round trip.
      const blank = { assignmentId: null, sequence: null, etaS: null, unassignedReason: null, snappedLat: null, snappedLng: null, snapDistanceM: null, snapGraphVersion: null };
      const rows: Prisma.RoutePlanStopCreateManyInput[] = [];
      for (const b of usable) {
        const end = personalEnd(b);
        const window: [number, number][] = [[rel(b.windowStart), rel(b.windowEnd)]];
        const passenger: Prisma.RoutePlanStopCreateManyInput = {
          ...blank,
          planId: plan.id,
          companyId: ctx.companyId,
          ref: `${dto.direction === 'IN' ? 'p' : 'd'}-${b.id}`,
          name: end.poiId ? (poiNames.get(end.poiId) ?? null) : PERSONAL_STOP_NAME[dto.direction === 'IN' ? 'PICKUP' : 'DROP'],
          lat: end.lat!,
          lng: end.lng!,
          demand: b.passengerCount,
          serviceS: 60,
          stopKind: dto.direction === 'IN' ? 'PICKUP' : 'DROP',
          customerCompanyId: b.customerCompanyId,
          bookingId: b.id,
          profileId: end.poiId ? null : b.profileId,
          poiId: end.poiId,
        };
        const atSite: Prisma.RoutePlanStopCreateManyInput = {
          ...blank,
          planId: plan.id,
          companyId: ctx.companyId,
          ref: `${dto.direction === 'IN' ? 'd' : 'p'}-${b.id}`,
          name: site.name,
          lat: site.lat,
          lng: site.lng,
          demand: 0,
          serviceS: 0,
          timeWindows: window,
          stopKind: dto.direction === 'IN' ? 'DROP' : 'PICKUP',
          customerCompanyId: b.customerCompanyId,
          bookingId: b.id,
          profileId: null,
          poiId: site.id,
        };
        rows.push(passenger, atSite);
      }
      if (rows.length) await tx.routePlanStop.createMany({ data: rows });
      const stops = await tx.routePlanStop.findMany({ where: { planId: plan.id }, orderBy: { ref: 'asc' }, select: { id: true, ref: true } });
      // Snapshot: ids only (shared RoutePlanVersionSnapshot: no coordinates, no names).
      const snapshot: RoutePlanVersionSnapshot = {
        status: 'DRAFT',
        assignments: assignments.map((a) => ({ id: a.id, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: null, stopIds: [] })),
        stops: stops.map((s) => ({ id: s.id, ref: s.ref, assignmentId: null, sequence: null, etaS: null, unassignedReason: null })),
      };
      await tx.routePlanVersion.create({ data: { planId: plan.id, companyId: ctx.companyId, version: 1, changeType: 'CREATED', snapshot: snapshot as unknown as Prisma.InputJsonValue, changedById: ctx.userId } });
      await this.audit.record(ctx, { action: 'CREATE', entity: PLAN_ENTITY, entityId: plan.id, details: { direction: dto.direction, planDate: dto.planDate, bookings: usable.length, skipped: skipped.length, vehicles: objectIds.length } }, tx);
      return plan.id;
    });
    return { value: { ...(await this.plans.get(ctx, planId)), skippedBookings: skipped }, replay: false };
  }
}

/** POST /api/transport/route-plans (etms_planning:create; Idempotency-Key). Same gates as the other plan routes. */
@Controller('transport/route-plans')
@UseGuards(TransportFeatureGuard, PlanningFeatureGuard)
export class RoutePlanCreateController {
  constructor(private readonly creator: RoutePlanCreateService) {}

  @Post() @HttpCode(201) @RequirePermission(ETMS_PLANNING_MENU, 'create')
  async create(@Auth() ctx: AuthContext, @Body() dto: CreateRoutePlanDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: { setHeader?: (n: string, v: string) => unknown; status?: (c: number) => unknown }): Promise<CreatedRoutePlanDto> {
    const r = await this.creator.create(ctx, dto, key);
    if (r.replay) {
      res?.setHeader?.('Idempotent-Replay', 'true');
      res?.status?.(200);
    }
    return r.value;
  }
}
