import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpException, Injectable, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  can,
  canOverrideMaxRide,
  ETMS_PLANNING_MENU,
  isRoutingStrategy,
  planBookingsLimitMessage,
  ROUTE_PLAN_ALTERNATIVES,
  ROUTE_PLAN_EDITABLE,
  ROUTING_JOB_STATE_OF,
  ROUTING_LIMITS,
  ROUTING_STRATEGIES,
  ROUTING_STRATEGY_INFO,
  type RoutePlanAlternativeJob,
  type RoutePlanAlternativesList,
  type RoutePlanAlternativesRequest,
  type RoutePlanAlternativesResult,
  type RoutePlanVersionSnapshot,
  type RoutingJobStatus,
  type RoutingStrategy,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { createHash } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutePlanPreferencesDto } from '../../routing-jobs/routing-jobs.controller';
import { RoutingHttpError } from '../../routing-jobs/routing-flags';
import { RoutingJobsService } from '../../routing-jobs/routing-jobs.service';
import { MAX_RIDE_AUDIT_ENTITY, maxRidePolicyOf, storedOverrideOf } from '../../routing-jobs/max-ride';
import { checkPreferenceMaxRide, checkPreferences } from '../../routing-jobs/strategies';
import { idempotencyKey, idempotencyReused, inProfileBranch, invalid, notFound, requestHash } from '../dispatch/e3-common';
import { activeRoutingConsents } from '../people/people.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { outOfScope, PLAN_INCLUDE, planStopOwner, type PlanPointView, type ViewBooking } from './plan-view';
import { PlanningFeatureGuard } from './planning-feature.guard';
import { PLAN_ENTITY, RoutePlansService } from './plans.service';

/** POST /transport/route-plans/:id/alternatives (shared RoutePlanAlternativesRequest). */
export class AlternativesDto implements RoutePlanAlternativesRequest {
  @IsArray() @ArrayMinSize(ROUTE_PLAN_ALTERNATIVES.min) @ArrayMaxSize(ROUTE_PLAN_ALTERNATIVES.max) @ArrayUnique() @IsIn(ROUTING_STRATEGIES, { each: true }) strategies!: RoutingStrategy[];
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ROUTING_LIMITS.optimizeTimeLimitS) timeLimitS?: number;
  @IsOptional() @ValidateNested() @Type(() => RoutePlanPreferencesDto) preferences?: RoutePlanPreferencesDto;
}

const ACTIVE_JOB: RoutingJobStatus[] = ['QUEUED', 'RUNNING'];

/** Copied plan options (solver settings and the authorised max-ride override); never keys, locks, pins or snapshots. */
const COPIED_OPTIONS = ['maxRideOverride', 'deterministic', 'allowMixedCustomers'] as const;

/**
 * E4 WP-A alternative plans: one sibling DRAFT plan per strategy, cloned from a DRAFT / PLANNED source plan (same
 * bookings and stops, vehicles and drivers, depot, site, shift, branch, start, profile and max-ride override; stops
 * unassigned; locks and pins not copied), each optimised by one job through RoutingJobsService (one job per plan, the
 * 75-booking limit, per-company concurrency and daily limits, rate limit). Published routes and their passengers are
 * not cloned; a personal stop whose passenger no longer has active routing consent is not cloned either.
 * Idempotency-Key: siblings carry options.alternativesKey / alternativesHash and a unique createKey
 * (`alt/<source>/<key>/<strategy>`, the RoutePlan createKey unique index guards concurrent duplicates); a replay with the
 * same key and body answers the same siblings and starts the jobs that could not start before (concurrency).
 */
@Injectable()
export class RoutePlanAlternativesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: RoutePlansService,
    private readonly jobs: RoutingJobsService,
  ) {}

  async create(ctx: AuthContext, sourceId: string, dto: AlternativesDto, rawKey: string | undefined): Promise<{ value: RoutePlanAlternativesResult; replay: boolean }> {
    if (ctx.allCompanies) throw invalid('Select one company to plan its routes');
    const key = idempotencyKey(rawKey);
    const strategies = dto.strategies ?? [];
    if (strategies.length < ROUTE_PLAN_ALTERNATIVES.min || strategies.length > ROUTE_PLAN_ALTERNATIVES.max || new Set(strategies).size !== strategies.length || !strategies.every(isRoutingStrategy)) {
      throw invalid(`Choose ${ROUTE_PLAN_ALTERNATIVES.min} to ${ROUTE_PLAN_ALTERNATIVES.max} different strategies`);
    }
    const preferences = checkPreferences(dto.preferences);
    if (preferences?.preserveLocks === false && !can(ctx.permissions, ETMS_PLANNING_MENU, 'edit')) {
      throw new ForbiddenException({ message: 'Only a user who may edit plans can re-optimise locked routes (preserveLocks: false)', code: 'FORBIDDEN_GRANT' });
    }
    const timeLimitS = dto.timeLimitS;
    const hash = requestHash({ sourceId, strategies, expectedVersion: dto.expectedVersion, timeLimitS: timeLimitS ?? null, preferences: preferences ?? null });

    const replay = await this.siblingsByKey(ctx, key);
    if (replay.length) {
      const own = replay.every((p) => (p.options as { alternativesHash?: string }).alternativesHash === hash && p.createdById === ctx.userId);
      const visible = await this.prisma.routePlan.count({ where: { AND: [this.plans.planWhere(ctx), { id: { in: replay.map((p) => p.id) } }] } });
      if (!own || visible !== replay.length) throw idempotencyReused();
      const siblings = strategies.map((s) => replay.find((p) => (p.options as { strategy?: string }).strategy === s)).filter((p): p is (typeof replay)[number] => !!p);
      const skipped = ((replay[0].options as { alternativesSkipped?: RoutePlanAlternativesResult['skippedBookings'] }).alternativesSkipped ?? []).slice(0, 200);
      return { value: { sourcePlanId: sourceId, alternatives: await this.startJobs(ctx, key, siblings.map((p) => ({ planId: p.id, strategy: (p.options as { strategy: RoutingStrategy }).strategy })), timeLimitS, preferences), skippedBookings: skipped }, replay: true };
    }

    // Another company's / branch's plan is a plain 404 (planWhere), as everywhere in the plans API.
    const source = await this.prisma.routePlan.findFirst({ where: { AND: [this.plans.planWhere(ctx), { id: sourceId }] }, include: PLAN_INCLUDE });
    if (!source) throw notFound('Plan not found');
    if (source.version !== dto.expectedVersion) throw new RoutingHttpError('PLAN_STALE', 'The plan changed meanwhile; reload it and try again', { currentVersion: source.version });
    if (!(ROUTE_PLAN_EDITABLE as readonly string[]).includes(source.status)) throw new RoutingHttpError('PLAN_NOT_EDITABLE', `Alternatives cannot be made from a ${source.status.toLowerCase()} plan`);

    // Security delta D1: passengers outside the caller's branches are invisible to them. Their stops (and every stop of
    // the same booking) are never cloned, and they are not counted or listed in skippedBookings.
    const view = await this.scopeView(ctx, source.stops);
    const hiddenBookings = new Set(source.stops.filter((s) => s.bookingId && outOfScope(s, view)).map((s) => s.bookingId as string));
    const visible = source.stops.filter((s) => !outOfScope(s, view) && !(s.bookingId && hiddenBookings.has(s.bookingId)));
    // Published routes (an E3 trip exists) and all stops of their bookings stay out of the clones.
    const published = new Set(source.transportTrips.map((t) => t.routeAssignmentId).filter((x): x is string => !!x));
    const skipped: RoutePlanAlternativesResult['skippedBookings'] = [];
    const out = new Set<string>();
    for (const s of visible) if (s.bookingId && s.assignmentId && published.has(s.assignmentId) && !out.has(s.bookingId)) (out.add(s.bookingId), skipped.push({ bookingId: s.bookingId, reason: 'published' }));
    // Consent re-checked now (planStopOwner: a legacy personal stop without profileId belongs to its booking's
    // passenger): a personal point is only copied with active routing consent.
    const ownerOf = (s: (typeof visible)[number]) => planStopOwner(s, view.bookings);
    const owners = [...new Set(visible.map(ownerOf).filter((p): p is string => !!p))];
    const consenting = owners.length ? await activeRoutingConsents(this.prisma, owners) : new Set<string>();
    const noConsent = (s: (typeof visible)[number]) => {
      const o = ownerOf(s);
      return !!o && !consenting.has(o);
    };
    for (const s of visible) if (s.bookingId && noConsent(s) && !out.has(s.bookingId)) (out.add(s.bookingId), skipped.push({ bookingId: s.bookingId, reason: 'consent_required' }));
    const stops = visible.filter((s) => !(s.assignmentId && published.has(s.assignmentId)) && !(s.bookingId && out.has(s.bookingId)) && !noConsent(s));
    const assignments = source.assignments.filter((a) => !published.has(a.id));
    const bookings = new Set(stops.map((s) => s.bookingId).filter(Boolean)).size;
    if (bookings > ROUTING_LIMITS.planBookings) throw new RoutingHttpError('LIMIT_EXCEEDED', planBookingsLimitMessage(bookings));
    if (!assignments.length) throw new RoutingHttpError('LIMIT_EXCEEDED', 'The plan has no unpublished vehicle to plan alternatives with');
    // Nothing is created when not even one job could start (per-company concurrency).
    const active = await this.prisma.routingJob.count({ where: { companyId: ctx.companyId, status: { in: ACTIVE_JOB } } });
    if (active >= ROUTING_LIMITS.concurrentOptimizePerCompany) throw new RoutingHttpError('QUOTA_EXCEEDED', `At most ${ROUTING_LIMITS.concurrentOptimizePerCompany} optimisations may run at once for a company; wait for one to finish`);

    const srcOptions = (source.options && typeof source.options === 'object' && !Array.isArray(source.options) ? source.options : {}) as Record<string, unknown>;
    // The source's max-ride override is copied only by a caller who may set one (else the siblings use the policy).
    const mayOverride = canOverrideMaxRide(ctx.permissions, ctx.dataScope);
    const copied = Object.fromEntries(COPIED_OPTIONS.filter((k) => srcOptions[k] !== undefined && (k !== 'maxRideOverride' || mayOverride)).map((k) => [k, srcOptions[k]]));
    // Preferences checked against the siblings' effective max ride BEFORE anything is written (no orphan siblings).
    const policyS = await maxRidePolicyOf(this.prisma, ctx.companyId);
    checkPreferenceMaxRide(preferences, storedOverrideOf(copied)?.maxRideS ?? policyS ?? null);
    let created: { planId: string; strategy: RoutingStrategy }[];
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const made: { planId: string; strategy: RoutingStrategy }[] = [];
        for (const strategy of strategies) {
          const plan = await tx.routePlan.create({
            data: {
              companyId: source.companyId,
              branchId: source.branchId,
              name: `${source.name} · ${ROUTING_STRATEGY_INFO[strategy].label}`.slice(0, 120),
              planDate: source.planDate,
              planStartAt: source.planStartAt,
              status: 'DRAFT',
              profile: source.profile,
              depot: source.depot === null ? Prisma.DbNull : (source.depot as Prisma.InputJsonValue),
              direction: source.direction,
              shiftId: source.shiftId,
              sitePoiId: source.sitePoiId,
              createdById: ctx.userId,
              options: {
                ...copied,
                createKey: `alt/${source.id}/${key}/${strategy}`,
                alternativeOf: source.id,
                strategy,
                alternativesKey: key,
                alternativesHash: hash,
                ...(skipped.length ? { alternativesSkipped: skipped.slice(0, 200) } : {}),
              } as Prisma.InputJsonValue,
            },
          });
          const idOf = new Map<string, string>();
          for (const a of assignments) {
            const row = await tx.routeAssignment.create({ data: { planId: plan.id, companyId: source.companyId, objectId: a.objectId, driverId: a.driverId, vehicleLabel: a.vehicleLabel, seq: a.seq, capacity: a.capacity } });
            idOf.set(a.id, row.id);
          }
          if (stops.length) {
            await tx.routePlanStop.createMany({
              data: stops.map((s) => ({
                planId: plan.id,
                companyId: s.companyId,
                assignmentId: null,
                ref: s.ref,
                name: s.name,
                lat: s.lat,
                lng: s.lng,
                demand: s.demand,
                serviceS: s.serviceS,
                timeWindows: s.timeWindows === null ? Prisma.DbNull : (s.timeWindows as Prisma.InputJsonValue),
                sequence: null,
                etaS: null,
                unassignedReason: null,
                stopKind: s.stopKind,
                customerCompanyId: s.customerCompanyId,
                bookingId: s.bookingId,
                profileId: s.profileId,
                poiId: s.poiId,
                snappedLat: null,
                snappedLng: null,
                snapDistanceM: null,
                snapGraphVersion: null,
              })),
            });
          }
          const rows = await tx.routePlanStop.findMany({ where: { planId: plan.id }, orderBy: { ref: 'asc' }, select: { id: true, ref: true } });
          const snapshot: RoutePlanVersionSnapshot = {
            status: 'DRAFT',
            assignments: assignments.map((a) => ({ id: idOf.get(a.id)!, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: a.driverId, stopIds: [] })),
            stops: rows.map((s) => ({ id: s.id, ref: s.ref, assignmentId: null, sequence: null, etaS: null, unassignedReason: null })),
          };
          await tx.routePlanVersion.create({ data: { planId: plan.id, companyId: source.companyId, version: 1, changeType: 'CREATED', snapshot: snapshot as unknown as Prisma.InputJsonValue, changedById: ctx.userId } });
          await this.audit.record(
            ctx,
            { action: 'CREATE', entity: PLAN_ENTITY, entityId: plan.id, details: { alternativeOf: source.id, strategy, bookings, skipped: skipped.length, vehicles: assignments.length, ...(copied.maxRideOverride ? { maxRideOverrideCopied: true } : {}) } },
            tx,
          );
          const override = storedOverrideOf(copied);
          if (override) {
            await this.audit.record(ctx, { action: 'UPDATE', entity: MAX_RIDE_AUDIT_ENTITY, entityId: plan.id, details: { maxRideOverride: { from: null, to: override.maxRideS }, reason: override.reason, copiedFrom: source.id, via: 'alternatives', policyS, version: 1 } }, tx);
          }
          made.push({ planId: plan.id, strategy });
        }
        return made;
      });
    } catch (e) {
      // A concurrent request with the same key won the createKey unique index: answer as its replay.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') && !/createKey|23505/.test(e instanceof Error ? e.message : '')) throw e;
      if (!(await this.siblingsByKey(ctx, key)).length) throw e;
      return this.create(ctx, sourceId, dto, rawKey);
    }
    let started: RoutePlanAlternativeJob[];
    try {
      started = await this.startJobs(ctx, key, created, timeLimitS, preferences);
    } catch (e) {
      // A refusal that applies to every sibling (400 / 403): nothing of this request is kept (no orphan siblings).
      await this.discard(ctx, created.map((c) => c.planId));
      throw e;
    }
    return { value: { sourcePlanId: source.id, alternatives: started, skippedBookings: skipped }, replay: false };
  }

  /** Removes siblings of a refused request (their queued jobs first). */
  private async discard(ctx: AuthContext, planIds: string[]): Promise<void> {
    if (!planIds.length) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.routingJob.deleteMany({ where: { companyId: ctx.companyId, planId: { in: planIds } } });
      await tx.routePlan.deleteMany({ where: { companyId: ctx.companyId, id: { in: planIds } } });
    });
  }

  /** The branch-scope view of a plan's stops (bookings with their passenger's branch, owners' branches). */
  private async scopeView(ctx: AuthContext, stops: { bookingId: string | null; profileId: string | null; poiId: string | null }[]): Promise<Pick<PlanPointView, 'bookings' | 'ownerBranch' | 'inBranch'>> {
    const ids = [...new Set(stops.flatMap((s) => (s.bookingId ? [s.bookingId] : [])))];
    const rows = ids.length ? await this.prisma.transportBooking.findMany({ where: { id: { in: ids } }, select: { id: true, passengerCount: true, profileId: true, pickupLabel: true, dropLabel: true, profile: { select: { branchId: true, displayName: true } } } }) : [];
    const bookings = new Map<string, ViewBooking>(rows.map((b) => [b.id, { id: b.id, passengerCount: b.passengerCount, profileId: b.profileId, pickupLabel: b.pickupLabel, dropLabel: b.dropLabel, branchId: b.profile?.branchId ?? null, displayName: b.profile?.displayName ?? null }]));
    const ownerBranch = new Map<string, string | null>([...bookings.values()].map((b) => [b.profileId, b.branchId] as const));
    const missing = [...new Set(stops.flatMap((s) => (s.profileId && !ownerBranch.has(s.profileId) ? [s.profileId] : [])))];
    if (missing.length) for (const p of await this.prisma.employeeTransportProfile.findMany({ where: { id: { in: missing } }, select: { id: true, branchId: true } })) ownerBranch.set(p.id, p.branchId);
    return { bookings, ownerBranch, inBranch: (b) => inProfileBranch(ctx, b) };
  }

  /** One optimise job per sibling (stable per-sibling job key, so a replay never queues a second one). */
  private async startJobs(ctx: AuthContext, key: string, siblings: { planId: string; strategy: RoutingStrategy }[], timeLimitS: number | undefined, preferences: ReturnType<typeof checkPreferences>): Promise<RoutePlanAlternativeJob[]> {
    const out: RoutePlanAlternativeJob[] = [];
    for (const s of siblings) {
      const jobKey = `alt-${createHash('sha256').update(`${key}|${s.planId}`).digest('hex').slice(0, 40)}`;
      try {
        const r = await this.jobs.enqueueOptimize(ctx, { planId: s.planId, expectedVersion: 1, strategy: s.strategy, ...(timeLimitS ? { timeLimitS } : {}), ...(preferences ? { preferences } : {}) }, jobKey);
        out.push({ strategy: s.strategy, planId: s.planId, jobId: r.job.jobId, jobState: r.job.state });
      } catch (e) {
        if (!(e instanceof HttpException)) throw e;
        // 400 / 403 (validation, rights, max ride above the policy) apply to every sibling: fatal for the request.
        if (e.getStatus() === 400 || e.getStatus() === 403) throw e;
        const body = e.getResponse() as { code?: string; message?: string };
        out.push({ strategy: s.strategy, planId: s.planId, jobId: null, jobState: null, error: { code: body.code ?? `HTTP_${e.getStatus()}`, message: String(body.message ?? 'Not started') } });
      }
    }
    return out;
  }

  private siblingsByKey(ctx: AuthContext, key: string) {
    return this.prisma.routePlan.findMany({ where: { companyId: ctx.companyId, options: { path: ['alternativesKey'], equals: key } }, select: { id: true, options: true, createdById: true } });
  }

  /** The siblings of a plan: of the plan itself, or of its source when it is an alternative (caller's scope only). */
  async list(ctx: AuthContext, id: string): Promise<RoutePlanAlternativesList> {
    const plan = await this.prisma.routePlan.findFirst({ where: { AND: [this.plans.planWhere(ctx), { id }] }, select: { id: true, options: true } });
    if (!plan) throw notFound('Plan not found');
    const of = (plan.options as { alternativeOf?: unknown } | null)?.alternativeOf;
    const root = typeof of === 'string' ? of : plan.id;
    const rows = await this.prisma.routePlan.findMany({
      where: { AND: [this.plans.planWhere(ctx), { options: { path: ['alternativeOf'], equals: root } }] },
      select: { id: true, name: true, status: true, version: true, options: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const siblings = rows.filter((r) => (r.options as { alternativeOf?: unknown } | null)?.alternativeOf === root);
    const jobs = siblings.length
      ? await this.prisma.routingJob.findMany({ where: { companyId: ctx.companyId, planId: { in: siblings.map((s) => s.id) } }, orderBy: { createdAt: 'desc' }, select: { id: true, planId: true, status: true, progress: true, error: true, createdAt: true } })
      : [];
    return {
      sourcePlanId: root,
      alternatives: siblings.map((s) => {
        const j = [...jobs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).find((x) => x.planId === s.id);
        const err = j?.error as { code?: string; message?: string } | null | undefined;
        const strategy = (s.options as { strategy?: unknown } | null)?.strategy;
        return {
          planId: s.id,
          name: s.name,
          strategy: isRoutingStrategy(strategy) ? strategy : null,
          status: s.status,
          version: s.version,
          createdAt: s.createdAt.toISOString(),
          job: j ? { jobId: j.id, state: ROUTING_JOB_STATE_OF[j.status as RoutingJobStatus], progress: j.progress, ...(err?.code && j.status === 'FAILED' ? { error: { code: err.code, message: String(err.message ?? '') } } : {}) } : null,
        };
      }),
    };
  }
}

/**
 * POST / GET /api/transport/route-plans/:id/alternatives (E4 WP-A). POST: etms_planning:create, Idempotency-Key, 201
 * (200 + Idempotent-Replay on a replay). GET: etms_planning:view. Same gates and scope as the other plan routes.
 */
@Controller('transport/route-plans')
@UseGuards(TransportFeatureGuard, PlanningFeatureGuard)
export class RoutePlanAlternativesController {
  constructor(private readonly alternatives: RoutePlanAlternativesService) {}

  @Post(':id/alternatives') @HttpCode(201) @RequirePermission(ETMS_PLANNING_MENU, 'create')
  async create(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AlternativesDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res?: { setHeader?: (n: string, v: string) => unknown; status?: (c: number) => unknown },
  ): Promise<RoutePlanAlternativesResult> {
    const r = await this.alternatives.create(ctx, id, dto, key);
    if (r.replay) {
      res?.setHeader?.('Idempotent-Replay', 'true');
      res?.status?.(200);
    }
    return r.value;
  }

  @Get(':id/alternatives') @RequirePermission(ETMS_PLANNING_MENU, 'view')
  list(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutePlanAlternativesList> {
    return this.alternatives.list(ctx, id);
  }
}
