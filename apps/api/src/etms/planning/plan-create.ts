import { Body, Controller, Headers, HttpCode, HttpException, Injectable, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { OptimizeOptionsDto } from '../../routing-jobs/routing-jobs.controller';
import { RoutingJobsService } from '../../routing-jobs/routing-jobs.service';
import { Prisma } from '@prisma/client';
import { ETMS_PLANNING_MENU, ROUTING_LIMITS, ROUTING_PROFILES, type RoutingJobDto, type RoutePlanDetailDto, type RoutePlanVersionSnapshot, type RoutingProfile } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { dateOnly, idempotencyKey, idempotencyReused, inProfileBranch, invalid, notFound, requestHash } from '../dispatch/e3-common';
import { PERSONAL_STOP_NAME } from '../dispatch/personal-points';
import { haversineMeters } from '../../tracking/geo';
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
    const replay = await this.replay(ctx, key, hash);
    if (replay) return replay;
    // Another company's site is a 404 before anything else (no hint that it exists).
    const site = await this.prisma.poi.findFirst({ where: { id: dto.sitePoiId, companyId: ctx.companyId }, select: { id: true, name: true, lat: true, lng: true } });
    if (!site) throw notFound('Site not found');
    if (ctx.dataScope !== 'COMPANY' && (!dto.branchId || !ctx.branchIds.includes(dto.branchId))) throw invalid('Choose one of your branches for the plan');
    if (dto.shiftId && !(await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId }, select: { id: true } }))) throw notFound('Shift not found');
    const depot = dto.depot ? await this.depotPlace(ctx, dto.depot) : null;
    const objectIds = [...new Set(dto.objectIds)];
    // E4 security review (informational): inactive vehicles are refused like unknown ones.
    const objects = await this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds }, isActive: true }] }, select: { id: true, name: true, plateNumber: true } });
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
      // L1: (companyId, options->>'createKey') is unique (migration 20261119090000): a concurrent create with the
      // same key fails here and is answered as a replay below.
      const plan = await tx.routePlan.create({
        data: {
          companyId: ctx.companyId,
          branchId: dto.branchId ?? null,
          name: dto.name.trim(),
          planDate: dateOnly(dto.planDate),
          planStartAt: new Date(startMs),
          status: 'DRAFT',
          profile: dto.profile ?? 'car',
          depot: depot ? { lat: depot.lat, lng: depot.lng } : Prisma.DbNull,
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
    }).catch(async (e: unknown) => {
      if (!isCreateKeyConflict(e)) throw e;
      const again = await this.replay(ctx, key, hash);
      if (!again) throw e;
      return again;
    });
    if (typeof planId !== 'string') return planId; // lost the race to a concurrent create with the same key: its replay
    return { value: { ...(await this.plans.get(ctx, planId)), skippedBookings: skipped }, replay: false };
  }

  /**
   * Idempotency-Key replay (E4 security review L1, the E3 L3 rule): only for the user who created the plan with that
   * key and the same body, and only while the plan is visible to them (`plans.get` is scoped); anything else is 422
   * IDEMPOTENCY_KEY_REUSED without the plan.
   */
  private async replay(ctx: AuthContext, key: string, hash: string): Promise<{ value: CreatedRoutePlanDto; replay: boolean } | null> {
    const existing = await this.prisma.routePlan.findFirst({ where: { companyId: ctx.companyId, options: { path: ['createKey'], equals: key } }, select: { id: true, options: true, createdById: true } });
    if (!existing) return null;
    const o = (existing.options ?? {}) as { createHash?: string };
    if (o.createHash !== hash || existing.createdById !== ctx.userId) throw idempotencyReused();
    const value = await this.plans.get(ctx, existing.id).catch((e: unknown) => {
      if (e instanceof HttpException && e.getStatus() === 404) throw idempotencyReused();
      throw e;
    });
    return { value: { ...value, skippedBookings: [] }, replay: true };
  }

  /**
   * E4 security review (informational): the depot must be a company place. The client point is matched to the
   * caller's company places within DEPOT_MATCH_M and the plan stores that place's own coordinates (never an arbitrary
   * client point, so never a personal address). Vehicle live positions are not accepted as a depot (they live in
   * Valkey and change; a garage is a company place).
   */
  private async depotPlace(ctx: AuthContext, p: { lat: number; lng: number }): Promise<{ lat: number; lng: number }> {
    const d = DEPOT_MATCH_M / 111_000;
    const dl = d / Math.max(0.1, Math.cos((p.lat * Math.PI) / 180));
    const near = await this.prisma.poi.findMany({ where: { companyId: ctx.companyId, lat: { gte: p.lat - d, lte: p.lat + d }, lng: { gte: p.lng - dl, lte: p.lng + dl } }, select: { lat: true, lng: true } });
    const best = near.map((x) => ({ x, m: haversineMeters(p.lat, p.lng, x.lat, x.lng) })).filter((c) => c.m <= DEPOT_MATCH_M).sort((a, b) => a.m - b.m)[0];
    if (!best) throw invalid('The depot must be one of your company places');
    return { lat: best.x.lat, lng: best.x.lng };
  }
}

/** How far a client depot point may be from the company place it names. */
export const DEPOT_MATCH_M = 150;

/** Unique violation of RoutePlan (companyId, options->>'createKey') (a concurrent create with the same key). */
function isCreateKeyConflict(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return true;
  const msg = e instanceof Error ? e.message : '';
  return /RoutePlan_companyId_createKey_key/.test(msg) || /23505/.test(msg);
}

/**
 * POST /api/transport/route-plans (etms_planning:create; Idempotency-Key) and the doc 05 §2 optimise alias
 * POST /api/transport/route-plans/:id/optimize (same permission, idempotency, limits and 202 job as
 * POST /api/routing/jobs/optimize). Same gates as the other plan routes.
 */
@Controller('transport/route-plans')
@UseGuards(TransportFeatureGuard, PlanningFeatureGuard)
export class RoutePlanCreateController {
  constructor(
    private readonly creator: RoutePlanCreateService,
    private readonly jobs: RoutingJobsService,
  ) {}

  @Post(':id/optimize') @HttpCode(202) @RequirePermission(ETMS_PLANNING_MENU, 'create')
  async optimize(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OptimizeOptionsDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res?: { setHeader?: (n: string, v: string) => unknown; status?: (c: number) => unknown },
  ): Promise<RoutingJobDto> {
    const r = await this.jobs.enqueueOptimize(ctx, { ...dto, planId: id }, key);
    if (r.replay) {
      res?.setHeader?.('Idempotent-Replay', 'true');
      res?.status?.(200);
    }
    return r.job;
  }

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
