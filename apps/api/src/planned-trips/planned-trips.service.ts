import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PlannedTrip, PlannedTripEvent, PlannedTripStop, Prisma } from '@prisma/client';
import {
  ACTIVE_PLANNED_TRIP_STATUSES,
  PLANNED_TRIPS_INVALIDATE_REASON,
  PlannedTripClosedBy,
  PlannedTripDto,
  PlannedTripEventDto,
  PlannedTripEventKind,
  PlannedTripStopDto,
  PlannedTripSummaryDto,
  RoutePath,
} from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AlertTargetsService } from '../alerts/alert-targets.service';
import { AuditService } from '../audit/audit.service';
import { iso, isoOrNull } from '../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { driverScopeWhere } from '../drivers/drivers.service';
import { PrismaService } from '../prisma/prisma.service';
import { CancelPlannedTripDto, CreatePlannedTripDto, ManualTripActionDto, PlannedTripListQuery, UpdatePlannedTripDto } from './planned-trips.dto';
import { buildTripSnapshot, shiftTripTimes, SnapshotRoute } from './snapshot';
import { canCancelTrip, canCompleteTrip, canEditTrip, canStartTrip } from './trip-rules';

const ENTITY = 'planned_trip';
const NO_ID = '00000000-0000-0000-0000-000000000000';

type SummaryRow = PlannedTrip & { _count: { stops: number } };
type DetailRow = PlannedTrip & { stops: PlannedTripStop[]; events: PlannedTripEvent[] };

const LIST: ListSpec = {
  search: ['routeName', 'notes'],
  sort: { plannedStart: 'plannedStart', plannedEnd: 'plannedEnd', routeName: 'routeName', status: 'status', delaySec: 'delaySec', createdAt: 'createdAt' },
  defaultSort: 'plannedStart',
  status: null,
};

const fmt = (s: string | null) => s ?? '';

const CSV: CsvSpec<PlannedTripSummaryDto> = {
  name: 'planned-trips',
  columns: [
    { header: 'Route', value: (t) => t.routeName },
    { header: 'Vehicle', value: (t) => t.objectName },
    { header: 'Driver', value: (t) => t.driverName },
    { header: 'Status', value: (t) => t.status },
    { header: 'Planned start', value: (t) => t.plannedStart },
    { header: 'Planned end', value: (t) => t.plannedEnd },
    { header: 'Actual start', value: (t) => fmt(t.actualStart) },
    { header: 'Actual end', value: (t) => fmt(t.actualEnd) },
    { header: 'Delay (min)', value: (t) => (t.delaySec === null ? null : Math.round(t.delaySec / 60)) },
    { header: 'Stops', value: (t) => t.stopCount },
    { header: 'Deviations', value: (t) => t.deviationCount },
    { header: 'Distance (km)', value: (t) => t.distanceKm },
    { header: 'Closed by', value: (t) => t.closedBy },
    { header: 'Cancel reason', value: (t) => t.cancelReason },
    { header: 'Generated', value: (t) => (t.scheduleId ? 'Yes' : 'No') },
  ],
};

/** Audit snapshot: trip columns without the (large) path. */
function auditSnapshot(t: PlannedTrip, extra: Record<string, unknown> = {}) {
  const { path, ...rest } = t;
  return { ...rest, pathPoints: Array.isArray(path) ? path.length : 0, ...extra };
}

/** Everything needed to create a trip from a route (one-off or generated). */
export interface NewTripInput {
  companyId: string;
  routeId: string;
  route: SnapshotRoute;
  objectId: string;
  branchId: string | null;
  driverId: string | null;
  scheduleId: string | null;
  plannedStartMs: number;
  createdById: string | null;
  notes?: string | null;
}

@Injectable()
export class PlannedTripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly targets: AlertTargetsService,
  ) {}

  /** Trips the caller may see: whole company, or trips of the vehicles in their scope. */
  private async scopeWhere(ctx: AuthContext): Promise<Prisma.PlannedTripWhereInput> {
    if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
    const objects = await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } });
    return { companyId: ctx.companyId, objectId: { in: objects.length ? objects.map((o) => o.id) : [NO_ID] } };
  }

  // ───────────── reads ─────────────

  async list(ctx: AuthContext, q: PlannedTripListQuery) {
    const plan = planList<Prisma.PlannedTripWhereInput, Prisma.PlannedTripOrderByWithRelationInput>(q, LIST);
    const filters: Prisma.PlannedTripWhereInput[] = [await this.scopeWhere(ctx), plan.where];
    if (q.from || q.to) filters.push({ plannedStart: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } });
    if (q.routeId) filters.push({ routeId: q.routeId });
    if (q.objectId) filters.push({ objectId: q.objectId });
    if (q.driverId) filters.push({ driverId: q.driverId });
    if (q.tripStatus?.length) filters.push({ status: { in: q.tripStatus } });
    const where: Prisma.PlannedTripWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.plannedTrip.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: { _count: { select: { stops: true } } } }),
      this.prisma.plannedTrip.count({ where }),
    ]);
    return listResult(plan, await this.toSummaries(rows), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<PlannedTripDto> {
    return this.toDetail(await this.find(ctx, id));
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  // ───────────── writes ─────────────

  /** One-off trip from a route: snapshot copy (SPEC §4.2). */
  async create(ctx: AuthContext, dto: CreatePlannedTripDto): Promise<PlannedTripDto> {
    const route = await this.prisma.route.findFirst({
      where: { AND: [this.routeScopeWhere(ctx), { id: dto.routeId }] },
      include: { stops: { orderBy: { seq: 'asc' } } },
    });
    if (!route) throw new BadRequestException('Unknown route');
    if (!route.isActive) throw new BadRequestException('This route is archived');
    if (route.stops.length < 2) throw new BadRequestException('This route has fewer than 2 stops');
    const object = await this.checkObject(ctx, dto.objectId);
    const driverId = dto.driverId ? await this.checkDriver(ctx, dto.driverId) : null;
    const row = await this.insertTrip({
      companyId: ctx.companyId,
      routeId: route.id,
      route,
      objectId: object.id,
      branchId: object.branchId,
      driverId,
      scheduleId: null,
      plannedStartMs: this.parseStart(dto.plannedStart),
      createdById: ctx.userId,
      notes: dto.notes?.trim() || null,
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: auditSnapshot(row) });
    await this.invalidate(ctx.companyId);
    return this.get(ctx, row.id);
  }

  /**
   * Inserts a trip with its stops (no audit, no invalidation: callers do that). Used by `create` and by the
   * generator; a duplicate generated trip fails with P2002 on (scheduleId, plannedStart).
   */
  async insertTrip(input: NewTripInput, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<PlannedTrip> {
    const snap = buildTripSnapshot(input.route, input.plannedStartMs);
    return db.plannedTrip.create({
      data: {
        companyId: input.companyId,
        branchId: input.branchId,
        routeId: input.routeId,
        scheduleId: input.scheduleId,
        objectId: input.objectId,
        driverId: input.driverId,
        routeName: snap.routeName,
        corridorM: snap.corridorM,
        path: snap.path ? (snap.path as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        plannedStart: snap.plannedStart,
        plannedEnd: snap.plannedEnd,
        nextStopSeq: 0,
        notes: input.notes ?? null,
        createdById: input.createdById,
        stops: { create: snap.stops },
      },
    });
  }

  /** Vehicle, driver, planned start (stop times shift with it) and notes; only while SCHEDULED. */
  async update(ctx: AuthContext, id: string, dto: UpdatePlannedTripDto): Promise<PlannedTripDto> {
    const before = await this.find(ctx, id);
    if (!canEditTrip(before.status)) throw new ConflictException('Only a scheduled trip can be edited');
    const data: Prisma.PlannedTripUncheckedUpdateInput = {};
    if (dto.objectId !== undefined && dto.objectId !== before.objectId) {
      const object = await this.checkObject(ctx, dto.objectId);
      data.objectId = object.id;
      data.branchId = object.branchId;
    }
    if (dto.driverId !== undefined) data.driverId = dto.driverId ? await this.checkDriver(ctx, dto.driverId) : null;
    if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
    let shifted: ReturnType<typeof shiftTripTimes<PlannedTripStop>> | null = null;
    if (dto.plannedStart !== undefined) {
      const start = this.parseStart(dto.plannedStart);
      if (start !== before.plannedStart.getTime()) {
        shifted = shiftTripTimes(before, before.stops, start);
        data.plannedStart = shifted.plannedStart;
        data.plannedEnd = shifted.plannedEnd;
      }
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.plannedTrip.updateMany({ where: { id, status: 'SCHEDULED' }, data });
      if (!claimed.count) throw new ConflictException('The trip has started meanwhile; reload it');
      if (shifted) {
        for (const s of shifted.stops) {
          await tx.plannedTripStop.update({ where: { id: s.id }, data: { plannedArrival: s.plannedArrival, plannedDeparture: s.plannedDeparture } });
        }
      }
      return tx.plannedTrip.findUniqueOrThrow({ where: { id } });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: auditSnapshot(before), after: auditSnapshot(row) });
    await this.invalidate(ctx.companyId);
    return this.get(ctx, id);
  }

  async cancel(ctx: AuthContext, id: string, dto: CancelPlannedTripDto): Promise<PlannedTripDto> {
    const before = await this.find(ctx, id);
    if (!canCancelTrip(before.status)) throw new ConflictException(`A ${before.status.toLowerCase().replace('_', ' ')} trip cannot be cancelled`);
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Give a reason');
    const row = await this.close(id, before.status, { status: 'CANCELLED', closedBy: 'MANUAL' satisfies PlannedTripClosedBy, cancelReason: reason });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: auditSnapshot(before), after: auditSnapshot(row) });
    await this.invalidate(ctx.companyId);
    return this.get(ctx, id);
  }

  /**
   * Manual start (override): SCHEDULED → IN_PROGRESS now; the start stop counts as departed. Refused while the vehicle
   * has another active trip (a vehicle has at most one).
   */
  async start(ctx: AuthContext, id: string, dto: ManualTripActionDto): Promise<PlannedTripDto> {
    const before = await this.find(ctx, id);
    if (!canStartTrip(before.status)) throw new ConflictException('Only a scheduled trip can be started');
    const active = await this.prisma.plannedTrip.findFirst({
      where: { objectId: before.objectId, status: { in: [...ACTIVE_PLANNED_TRIP_STATUSES] }, id: { not: id } },
      select: { routeName: true },
    });
    if (active) throw new ConflictException(`This vehicle is already on trip "${active.routeName}"; complete or cancel it first`);
    const now = new Date();
    const first = before.stops[0];
    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.plannedTrip.updateMany({
        where: { id, status: 'SCHEDULED' },
        data: { status: 'IN_PROGRESS', actualStart: now, nextStopSeq: before.stops.length > 1 ? 1 : null },
      });
      if (!claimed.count) throw new ConflictException('The trip changed meanwhile; reload it');
      if (first) {
        await tx.plannedTripStop.update({ where: { id: first.id }, data: { status: 'DEPARTED', actualDeparture: now } });
      }
      return tx.plannedTrip.findUniqueOrThrow({ where: { id } });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: auditSnapshot(before, { manual: null }), after: auditSnapshot(row, { manual: `start${dto.note ? `: ${dto.note}` : ''}` }) });
    await this.invalidate(ctx.companyId);
    return this.get(ctx, id);
  }

  /** Manual complete (override): STARTED / IN_PROGRESS → COMPLETED now (closedBy MANUAL); stops not reached → SKIPPED. */
  async complete(ctx: AuthContext, id: string, dto: ManualTripActionDto): Promise<PlannedTripDto> {
    const before = await this.find(ctx, id);
    if (!canCompleteTrip(before.status)) throw new ConflictException('Only a started trip can be completed');
    const row = await this.close(id, before.status, { status: 'COMPLETED', closedBy: 'MANUAL' satisfies PlannedTripClosedBy, actualEnd: new Date(), nextStopSeq: null });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: auditSnapshot(before, { manual: null }), after: auditSnapshot(row, { manual: `complete${dto.note ? `: ${dto.note}` : ''}` }) });
    await this.invalidate(ctx.companyId);
    return this.get(ctx, id);
  }

  /** Publishes the processor cache invalidation for the company's trips (reason `planned-trips`). */
  async invalidate(companyId: string): Promise<void> {
    await this.targets.invalidate(companyId, PLANNED_TRIPS_INVALIDATE_REASON);
  }

  // ───────────── helpers ─────────────

  /** Compare-and-set close: status change guarded by the status read, PENDING stops → SKIPPED. */
  private close(id: string, from: PlannedTrip['status'], data: Prisma.PlannedTripUncheckedUpdateInput): Promise<PlannedTrip> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.plannedTrip.updateMany({ where: { id, status: from }, data });
      if (!claimed.count) throw new ConflictException('The trip changed meanwhile; reload it');
      await tx.plannedTripStop.updateMany({ where: { tripId: id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
      return tx.plannedTrip.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Same visibility as the routes list: company-wide routes plus the caller's branches. */
  private routeScopeWhere(ctx: AuthContext): Prisma.RouteWhereInput {
    if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
    return { companyId: ctx.companyId, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
  }

  private async find(ctx: AuthContext, id: string): Promise<DetailRow> {
    const row = await this.prisma.plannedTrip.findFirst({
      where: { AND: [await this.scopeWhere(ctx), { id }] },
      include: { stops: { orderBy: { seq: 'asc' } }, events: { orderBy: { startAt: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Planned trip not found');
    return row;
  }

  private async checkObject(ctx: AuthContext, objectId: string): Promise<{ id: string; branchId: string | null }> {
    const object = await this.prisma.trackedObject.findFirst({
      where: { AND: [objectScopeWhere(ctx), { id: objectId, isActive: true }] },
      select: { id: true, branchId: true },
    });
    if (!object) throw new BadRequestException('Unknown or inactive vehicle');
    return object;
  }

  private async checkDriver(ctx: AuthContext, driverId: string): Promise<string> {
    const driver = await this.prisma.driver.findFirst({ where: { AND: [driverScopeWhere(ctx), { id: driverId, isActive: true }] }, select: { id: true } });
    if (!driver) throw new BadRequestException('Unknown or inactive driver');
    return driver.id;
  }

  private parseStart(value: string): number {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new BadRequestException('Planned start must be a date and time');
    return ms;
  }

  private async names(rows: PlannedTrip[]) {
    const objectIds = [...new Set(rows.map((r) => r.objectId))];
    const driverIds = [...new Set(rows.map((r) => r.driverId).filter((x): x is string => !!x))];
    const [objects, drivers] = await Promise.all([
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true } }) : [],
      driverIds.length ? this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true } }) : [],
    ]);
    return { objects: new Map(objects.map((o) => [o.id, o.name])), drivers: new Map(drivers.map((d) => [d.id, d.name])) };
  }

  private summary(t: PlannedTrip, stopCount: number, skippedStops: number, n: Awaited<ReturnType<PlannedTripsService['names']>>): PlannedTripSummaryDto {
    return {
      id: t.id,
      routeId: t.routeId,
      scheduleId: t.scheduleId,
      routeName: t.routeName,
      objectId: t.objectId,
      objectName: n.objects.get(t.objectId) ?? null,
      driverId: t.driverId,
      driverName: t.driverId ? (n.drivers.get(t.driverId) ?? null) : null,
      branchId: t.branchId,
      corridorM: t.corridorM,
      plannedStart: iso(t.plannedStart),
      plannedEnd: iso(t.plannedEnd),
      status: t.status,
      actualStart: isoOrNull(t.actualStart),
      actualEnd: isoOrNull(t.actualEnd),
      closedBy: (t.closedBy as PlannedTripClosedBy | null) ?? null,
      cancelReason: t.cancelReason,
      notes: t.notes,
      distanceKm: t.distanceKm,
      deviationCount: t.deviationCount,
      maxDeviationM: t.maxDeviationM,
      nextStopSeq: t.nextStopSeq,
      etaNextStop: isoOrNull(t.etaNextStop),
      delaySec: t.delaySec,
      stopCount,
      skippedStops,
      createdAt: iso(t.createdAt),
      updatedAt: iso(t.updatedAt),
    };
  }

  private async toSummaries(rows: SummaryRow[]): Promise<PlannedTripSummaryDto[]> {
    const [n, skipped] = await Promise.all([
      this.names(rows),
      rows.length
        ? this.prisma.plannedTripStop.groupBy({ by: ['tripId'], where: { tripId: { in: rows.map((r) => r.id) }, status: 'SKIPPED' }, _count: { _all: true } })
        : [],
    ]);
    const skippedBy = new Map(skipped.map((g) => [g.tripId, g._count._all]));
    return rows.map((r) => this.summary(r, r._count.stops, skippedBy.get(r.id) ?? 0, n));
  }

  private async toDetail(t: DetailRow): Promise<PlannedTripDto> {
    const n = await this.names([t]);
    return {
      ...this.summary(t, t.stops.length, t.stops.filter((s) => s.status === 'SKIPPED').length, n),
      path: Array.isArray(t.path) ? (t.path as unknown as RoutePath) : null,
      stops: t.stops.map(
        (s): PlannedTripStopDto => ({
          id: s.id,
          seq: s.seq,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          radiusM: s.radiusM,
          plannedArrival: iso(s.plannedArrival),
          plannedDeparture: iso(s.plannedDeparture),
          actualArrival: isoOrNull(s.actualArrival),
          actualDeparture: isoOrNull(s.actualDeparture),
          status: s.status,
          delaySec: s.delaySec,
        }),
      ),
      events: t.events.map(
        (e): PlannedTripEventDto => ({
          id: e.id,
          kind: e.kind as PlannedTripEventKind,
          startAt: iso(e.startAt),
          endAt: isoOrNull(e.endAt),
          lat: e.lat,
          lng: e.lng,
          data: e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : null,
        }),
      ),
    };
  }
}
