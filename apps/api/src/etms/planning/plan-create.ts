import { Body, Controller, Headers, HttpCode, HttpException, Injectable, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { OptimizeOptionsDto } from '../../routing-jobs/routing-jobs.controller';
import { RoutingJobsService } from '../../routing-jobs/routing-jobs.service';
import { checkMaxRideOverride, MaxRideOverrideDto, maxRidePolicyOf, withOverride } from '../../routing-jobs/max-ride';
import { RoutingHttpError } from '../../routing-jobs/routing-flags';
import { Prisma } from '@prisma/client';
import { ETMS_PLANNING_MENU, planBookingsLimitMessage, ROUTING_LIMITS, ROUTING_PROFILES, type RoutingJobDto, type RoutePlanDetailDto, type RoutePlanEmptyReason, type RoutePlanSkippedBooking, type RoutePlanVersionSnapshot, type RoutingProfile } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { dateOnly, idempotencyKey, idempotencyReused, inProfileBranch, invalid, notFound, requestHash } from '../dispatch/e3-common';
import { PERSONAL_STOP_NAME } from '../dispatch/personal-points';
import { legWindow } from '../dispatch/service-dates';
import { haversineMeters } from '../../tracking/geo';
import { activeRoutingConsents } from '../people/people.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { PLAN_CANDIDATE_STATUSES, planSkipReason, type PlanScope } from './plan-booking-scope';
import { PlanningFeatureGuard } from './planning-feature.guard';
import { relS } from './plan-rules';
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
  /** Owner decision 1: per-plan max-ride override (etms_settings:edit + whole-company scope, else 403), with a reason; audited. */
  @IsOptional() @ValidateNested() @Type(() => MaxRideOverrideDto) maxRideOverride?: MaxRideOverrideDto;
}

export type CreatedRoutePlanDto = RoutePlanDetailDto & {
  /**
   * WP 3.9: every booking of the service date / direction the caller can see that waits for a seat or for approval and
   * was not put on the plan, and why (ids only; reasons and their order: plan-booking-scope.ts).
   */
  skippedBookings: RoutePlanSkippedBooking[];
  /** Set when the plan has no passenger, with why (QA re-check: a shift without bookings no longer looks like a bug). */
  emptyReason: RoutePlanEmptyReason | null;
  /**
   * Bookings found, planned and skipped (found = planned + skipped). WP 3.9: `found` counts every visible booking of the
   * date / direction in REQUESTED / WAITLISTED / PENDING_ASSIGNMENT (no longer only the plan's site / shift), so an empty
   * plan with bookings of other shifts or sites answers ALL_SKIPPED (with their reasons) instead of NO_BOOKINGS_FOR_SHIFT.
   * On a replay: planned from the plan, found / skipped unknown (null).
   */
  bookingCounts: { found: number | null; planned: number; skipped: number | null };
};

/** Why a plan created from `found` bookings with `planned` on it is empty (null when it has passengers). */
export function emptyReasonOf(found: number, planned: number, shiftId: string | null | undefined): RoutePlanEmptyReason | null {
  if (planned > 0) return null;
  if (found > 0) return 'ALL_SKIPPED';
  return shiftId ? 'NO_BOOKINGS_FOR_SHIFT' : 'NO_BOOKINGS';
}

const H = 3_600_000;

/**
 * POST /api/transport/route-plans: a DRAFT plan built from the bookings waiting for a seat (PENDING_ASSIGNMENT) of the
 * caller's company for the service date, direction, site (and shift: bookings of that shift, plus shift-less COMMUTE
 * bookings whose window overlaps the shift's leg window — WP 3.9), plus one route per chosen vehicle. Every other
 * visible booking of the date / direction waiting for a seat or an approval is reported in skippedBookings.
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
    // Owner decision 1: only an authorised caller may set a max-ride override (403 before anything else).
    const maxRideOverride = dto.maxRideOverride == null ? undefined : (checkMaxRideOverride(ctx, dto.maxRideOverride) ?? undefined);
    const key = idempotencyKey(rawKey);
    const hash = requestHash(dto);
    const replay = await this.replay(ctx, key, hash);
    if (replay) return replay;
    // Another company's site is a 404 before anything else (no hint that it exists).
    const site = await this.prisma.poi.findFirst({ where: { id: dto.sitePoiId, companyId: ctx.companyId }, select: { id: true, name: true, lat: true, lng: true } });
    if (!site) throw notFound('Site not found');
    // T2-D5: a branch-scoped caller with exactly one branch plans for that branch when none is named (the planner UI
    // had no branch to send for such a user); with several branches the request must name one of them.
    const branchId = dto.branchId ?? (ctx.dataScope !== 'COMPANY' && ctx.branchIds.length === 1 ? ctx.branchIds[0] : null);
    if (ctx.dataScope !== 'COMPANY' && (!branchId || !ctx.branchIds.includes(branchId))) throw invalid('Choose one of your branches for the plan');
    const shift = dto.shiftId ? await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId }, select: { startMin: true, endMin: true, timeZone: true } }) : null;
    if (dto.shiftId && !shift) throw notFound('Shift not found');
    const depot = dto.depot ? await this.depotPlace(ctx, dto.depot) : null;
    const objectIds = [...new Set(dto.objectIds)];
    // E4 security review (informational): inactive vehicles are refused like unknown ones.
    const objects = await this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds }, isActive: true }] }, select: { id: true, name: true, plateNumber: true } });
    if (objects.length !== objectIds.length) throw notFound('Vehicle not found');
    const seats = new Map((await this.prisma.transportVehicleProfile.findMany({ where: { objectId: { in: objectIds } }, select: { objectId: true, seats: true } })).map((v) => [v.objectId, v.seats]));

    // WP 3.9: every open booking of the date / direction (ad-hoc ones too: another destination, another or no shift,
    // point-to-point, still to approve) is either planned or reported in skippedBookings, never silently dropped.
    const bookings = await this.prisma.transportBooking.findMany({
      where: {
        customerCompanyId: ctx.companyId,
        serviceDate: dateOnly(dto.planDate),
        direction: dto.direction,
        status: { in: [...PLAN_CANDIDATE_STATUSES] },
      },
      include: { profile: { select: { branchId: true } } },
      orderBy: [{ windowStart: 'asc' }, { id: 'asc' }],
    });
    const scope: PlanScope = { direction: dto.direction, sitePoiId: site.id, shiftId: dto.shiftId ?? null, shiftLeg: shift ? legWindow(shift, dto.direction, dto.planDate) : null, branchId };
    const skipped: RoutePlanSkippedBooking[] = [];
    // Security delta D1: bookings outside the caller's own branches are invisible to them, so they are neither listed
    // nor counted. `out_of_scope` only names bookings the caller can see that fall outside the plan's branch.
    const visible = bookings.filter((b) => inProfileBranch(ctx, b.profile.branchId));
    const inScope = visible.filter((b) => {
      const reason = planSkipReason({ ...b, branchId: b.profile.branchId }, scope);
      if (reason) skipped.push({ bookingId: b.id, reason });
      return !reason;
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
    // Owner decision 2 (T3-D9): the one bookings limit of creation and optimisation; refused, never truncated.
    if (usable.length > ROUTING_LIMITS.planBookings) throw new RoutingHttpError('LIMIT_EXCEEDED', planBookingsLimitMessage(usable.length));
    const poiNames = new Map((await this.prisma.poi.findMany({ where: { companyId: ctx.companyId, id: { in: usable.map((b) => personalEnd(b).poiId).filter((p): p is string => !!p) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));

    const startMs = dto.planStartAt ? Date.parse(dto.planStartAt) : usable.length ? Math.floor((Math.min(...usable.map((b) => b.windowStart.getTime())) - 2 * H) / 60_000) * 60_000 : Date.parse(`${dto.planDate}T00:00:00Z`);
    const rel = (d: Date) => relS(d, startMs);

    const planId = await this.prisma.$transaction(async (tx) => {
      // L1: (companyId, options->>'createKey') is unique (migration 20261119090000): a concurrent create with the
      // same key fails here and is answered as a replay below.
      const plan = await tx.routePlan.create({
        data: {
          companyId: ctx.companyId,
          branchId,
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
      if (maxRideOverride) {
        // Stored on the plan (applied from the first optimisation on) and audited as its own entry.
        const base = plan.options as Record<string, unknown>;
        const options = await withOverride(tx, this.audit, ctx, { id: plan.id, options: base, version: 1 }, maxRideOverride, 'create', await maxRidePolicyOf(tx, ctx.companyId));
        await tx.routePlan.update({ where: { id: plan.id }, data: { options: options as Prisma.InputJsonValue } });
      }
      return plan.id;
    }).catch(async (e: unknown) => {
      if (!isCreateKeyConflict(e)) throw e;
      const again = await this.replay(ctx, key, hash);
      if (!again) throw e;
      return again;
    });
    if (typeof planId !== 'string') return planId; // lost the race to a concurrent create with the same key: its replay
    return {
      value: { ...(await this.plans.get(ctx, planId)), skippedBookings: skipped, emptyReason: emptyReasonOf(visible.length, usable.length, dto.shiftId), bookingCounts: { found: visible.length, planned: usable.length, skipped: skipped.length } },
      replay: false,
    };
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
    const planned = new Set(value.stops.map((s) => s.bookingId).filter((b): b is string => !!b)).size;
    // A replay cannot tell how many bookings were skipped at create time; an empty plan is reported as having found none
    // only for its shift (the create answer already explained it the first time).
    return {
      value: { ...value, skippedBookings: [], emptyReason: planned ? null : value.shiftId ? 'NO_BOOKINGS_FOR_SHIFT' : 'NO_BOOKINGS', bookingCounts: { found: null, planned, skipped: null } },
      replay: true,
    };
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
