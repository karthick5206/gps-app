import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Route, RouteSchedule, RouteStop } from '@prisma/client';
import { ROUTE_LIMITS, RouteDto, RoutePath, RoutePathPreview, RouteScheduleDto, RouteStopDto, RouteSummaryDto } from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { iso } from '../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { driverScopeWhere } from '../drivers/drivers.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { PlannedTripJobService } from './planned-trip-job.service';
import { cleanDays, corridorError, NormalisedStop, normaliseStops, scheduleError } from './route-stops';
import { CreateRouteDto, CreateScheduleDto, PreviewPathDto, RouteListQuery, UpdateRouteDto, UpdateScheduleDto } from './routes.dto';
import { dateOnlyKey } from './schedule-occurrences';
import { cleanPath } from './snapshot';

const ENTITY = 'route';
const SCHEDULE_ENTITY = 'route_schedule';

type DetailRow = Route & { stops: RouteStop[]; schedules: RouteSchedule[] };

const LIST: ListSpec = {
  search: ['name', 'code', 'description'],
  sort: { name: 'name', code: 'code', distanceM: 'distanceM', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<RouteSummaryDto> = {
  name: 'routes',
  columns: [
    { header: 'Name', value: (r) => r.name },
    { header: 'Code', value: (r) => r.code },
    { header: 'Branch', value: (r) => r.branchName ?? 'Company-wide' },
    { header: 'Stops', value: (r) => r.stopCount },
    { header: 'Distance (km)', value: (r) => (r.distanceM === null ? null : Math.round(r.distanceM / 100) / 10) },
    { header: 'Drive time (min)', value: (r) => (r.durationSec === null ? null : Math.round(r.durationSec / 60)) },
    { header: 'Corridor (m)', value: (r) => r.corridorM },
    { header: 'Schedules', value: (r) => r.scheduleCount },
    { header: 'Active', value: (r) => (r.isActive ? 'Yes' : 'No') },
  ],
};

function auditSnapshot(r: Route, stops?: RouteStop[] | NormalisedStop[]) {
  const { path, ...rest } = r;
  return {
    ...rest,
    pathPoints: Array.isArray(path) ? path.length : 0,
    ...(stops ? { stops: stops.map((s) => `${s.seq}:${s.name}@${s.lat},${s.lng} r${s.radiusM} +${s.offsetMin}m w${s.waitMin}m`) } : {}),
  };
}

const dayToDate = (day: string | null | undefined): Date | null | undefined => (day === undefined ? undefined : day === null ? null : new Date(`${day}T00:00:00.000Z`));

@Injectable()
export class RoutesService {
  private readonly logger = new Logger(RoutesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly routing: RoutingService,
    private readonly job: PlannedTripJobService,
  ) {}

  /** ASSIGNED-scope users see routes of their branches plus company-wide ones (as geofences). */
  private scopeWhere(ctx: AuthContext): Prisma.RouteWhereInput {
    if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
    return { companyId: ctx.companyId, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
  }

  // ───────────── routes ─────────────

  async list(ctx: AuthContext, q: RouteListQuery) {
    const plan = planList<Prisma.RouteWhereInput, Prisma.RouteOrderByWithRelationInput>(q, LIST);
    const filters: Prisma.RouteWhereInput[] = [this.scopeWhere(ctx), plan.where];
    if (q.branchId) filters.push({ branchId: q.branchId });
    const where: Prisma.RouteWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.route.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: { _count: { select: { stops: true, schedules: true } } } }),
      this.prisma.route.count({ where }),
    ]);
    const names = await this.branchNames(rows);
    return listResult(plan, rows.map((r) => this.summary(r, r._count.stops, r._count.schedules, names)), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<RouteDto> {
    return this.toDetail(await this.find(ctx, id));
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  async create(ctx: AuthContext, dto: CreateRouteDto): Promise<RouteDto> {
    const stops = this.stopsOrThrow(dto.stops);
    const branchId = await this.checkBranch(ctx, dto.branchId ?? null);
    const corridorM = dto.corridorM ?? ROUTE_LIMITS.corridorDefaultM;
    this.corridorOrThrow(corridorM);
    const road = await this.routing.routeVia(stops);
    const row = await this.prisma.route.create({
      data: {
        companyId: ctx.companyId,
        branchId,
        name: dto.name.trim(),
        code: dto.code?.trim() || null,
        description: dto.description?.trim() || null,
        corridorM,
        path: road ? (road.path as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        distanceM: road ? road.distanceM : null,
        durationSec: road ? road.durationSec : null,
        isActive: dto.isActive ?? true,
        stops: { create: stops },
      },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: auditSnapshot(row, stops) });
    return this.get(ctx, row.id);
  }

  /** Fields provided are changed; `stops` replaces all stops and recomputes the road path. Trips keep their snapshot. */
  async update(ctx: AuthContext, id: string, dto: UpdateRouteDto): Promise<RouteDto> {
    const before = await this.findWritable(ctx, id);
    const data: Prisma.RouteUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.code !== undefined) data.code = dto.code?.trim() || null;
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.branchId !== undefined) data.branchId = await this.checkBranch(ctx, dto.branchId);
    if (dto.corridorM !== undefined) {
      this.corridorOrThrow(dto.corridorM);
      data.corridorM = dto.corridorM;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const stops = dto.stops !== undefined ? this.stopsOrThrow(dto.stops) : null;
    if (stops) {
      const road = await this.routing.routeVia(stops);
      data.path = road ? (road.path as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
      data.distanceM = road ? road.distanceM : null;
      data.durationSec = road ? road.durationSec : null;
    }
    const row = await this.prisma.$transaction(async (tx) => {
      if (stops) {
        await tx.routeStop.deleteMany({ where: { routeId: id } });
        await tx.routeStop.createMany({ data: stops.map((s) => ({ ...s, routeId: id })) });
      }
      return tx.route.update({ where: { id }, data });
    });
    await this.audit.record(ctx, {
      action: 'UPDATE',
      entity: ENTITY,
      entityId: id,
      before: auditSnapshot(before, stops ? before.stops : undefined),
      after: auditSnapshot(row, stops ?? undefined),
    });
    return this.get(ctx, id);
  }

  /** Only a route without planned trips can be deleted; otherwise archive it (isActive = false). */
  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findWritable(ctx, id);
    const trips = await this.prisma.plannedTrip.count({ where: { companyId: ctx.companyId, routeId: id } });
    if (trips) throw new ConflictException(`This route has ${trips} planned trip${trips === 1 ? '' : 's'}; archive it instead`);
    await this.prisma.route.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: auditSnapshot(before, before.stops) });
  }

  /** "<name> (copy)" with the same stops, path and corridor; schedules are not copied (they would double the trips). */
  async copy(ctx: AuthContext, id: string): Promise<RouteDto> {
    const source = await this.find(ctx, id);
    await this.checkBranch(ctx, source.branchId);
    const name = await this.freeCopyName(ctx.companyId, source.name);
    const stops = source.stops.map(({ id: _id, routeId: _routeId, ...s }) => s);
    const row = await this.prisma.route.create({
      data: {
        companyId: ctx.companyId,
        branchId: source.branchId,
        name,
        code: source.code,
        description: source.description,
        corridorM: source.corridorM,
        path: source.path === null ? Prisma.DbNull : (source.path as Prisma.InputJsonValue),
        distanceM: source.distanceM,
        durationSec: source.durationSec,
        isActive: true,
        stops: { create: stops },
      },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: { ...auditSnapshot(row, source.stops), copiedFrom: source.id } });
    return this.get(ctx, row.id);
  }

  /** Road path for the editor without saving (same as on save). */
  async previewPath(dto: PreviewPathDto): Promise<RoutePathPreview> {
    if (!this.routing.enabled) return { enabled: false, path: null, distanceM: null, durationSec: null, legs: [] };
    const road = await this.routing.routeVia(dto.points);
    if (!road) return { enabled: true, path: null, distanceM: null, durationSec: null, legs: [] };
    return { enabled: true, path: road.path, distanceM: road.distanceM, durationSec: road.durationSec, legs: road.legs };
  }

  // ───────────── schedules ─────────────

  async listSchedules(ctx: AuthContext, routeId: string): Promise<RouteScheduleDto[]> {
    const route = await this.find(ctx, routeId);
    return this.scheduleDtos(route.schedules);
  }

  async createSchedule(ctx: AuthContext, routeId: string, dto: CreateScheduleDto): Promise<RouteScheduleDto> {
    await this.findWritable(ctx, routeId);
    this.scheduleOrThrow(dto);
    const row = await this.prisma.routeSchedule.create({
      data: {
        companyId: ctx.companyId,
        routeId,
        days: cleanDays(dto.days),
        startMin: dto.startMin,
        objectId: dto.objectId ? await this.checkObject(ctx, dto.objectId) : null,
        driverId: dto.driverId ? await this.checkDriver(ctx, dto.driverId) : null,
        validFrom: dayToDate(dto.validFrom) ?? null,
        validTo: dayToDate(dto.validTo) ?? null,
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: SCHEDULE_ENTITY, entityId: row.id, after: { ...row } });
    await this.generateNow(row.id);
    return (await this.scheduleDtos([row]))[0];
  }

  /** Changes apply to trips generated from now on; trips already generated stay as they are. */
  async updateSchedule(ctx: AuthContext, routeId: string, scheduleId: string, dto: UpdateScheduleDto): Promise<RouteScheduleDto> {
    await this.findWritable(ctx, routeId);
    const before = await this.findSchedule(ctx, routeId, scheduleId);
    const merged = {
      days: dto.days ?? before.days,
      startMin: dto.startMin ?? before.startMin,
      validFrom: dto.validFrom !== undefined ? dto.validFrom : dateOnlyKey(before.validFrom),
      validTo: dto.validTo !== undefined ? dto.validTo : dateOnlyKey(before.validTo),
    };
    this.scheduleOrThrow(merged);
    const data: Prisma.RouteScheduleUncheckedUpdateInput = {};
    if (dto.days !== undefined) data.days = cleanDays(dto.days);
    if (dto.startMin !== undefined) data.startMin = dto.startMin;
    if (dto.objectId !== undefined) data.objectId = dto.objectId ? await this.checkObject(ctx, dto.objectId) : null;
    if (dto.driverId !== undefined) data.driverId = dto.driverId ? await this.checkDriver(ctx, dto.driverId) : null;
    if (dto.validFrom !== undefined) data.validFrom = dayToDate(dto.validFrom);
    if (dto.validTo !== undefined) data.validTo = dayToDate(dto.validTo);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const row = await this.prisma.routeSchedule.update({ where: { id: scheduleId }, data });
    await this.audit.record(ctx, { action: 'UPDATE', entity: SCHEDULE_ENTITY, entityId: scheduleId, before: { ...before }, after: { ...row } });
    await this.generateNow(row.id);
    return (await this.scheduleDtos([row]))[0];
  }

  /** Trips already generated from the schedule are kept (cancel them if needed). */
  async removeSchedule(ctx: AuthContext, routeId: string, scheduleId: string): Promise<void> {
    await this.findWritable(ctx, routeId);
    const before = await this.findSchedule(ctx, routeId, scheduleId);
    await this.prisma.routeSchedule.delete({ where: { id: scheduleId } });
    await this.audit.record(ctx, { action: 'DELETE', entity: SCHEDULE_ENTITY, entityId: scheduleId, before: { ...before } });
  }

  // ───────────── helpers ─────────────

  /** Generate the schedule's next-24-h trips right away; a failure only means waiting for the next job tick. */
  private async generateNow(scheduleId: string): Promise<void> {
    await this.job.generate(Date.now(), [scheduleId]).catch((error) => this.logger.warn(`Generating trips for schedule ${scheduleId} failed: ${(error as Error).message}`));
  }

  private stopsOrThrow(input: CreateRouteDto['stops']): NormalisedStop[] {
    const result = normaliseStops(input);
    if (!result.ok) throw new BadRequestException(result.error);
    return result.stops;
  }

  private corridorOrThrow(corridorM: number): void {
    const err = corridorError(corridorM);
    if (err) throw new BadRequestException(err);
  }

  private scheduleOrThrow(s: { days?: number[]; startMin?: number; validFrom?: string | null; validTo?: string | null }): void {
    const err = scheduleError(s);
    if (err) throw new BadRequestException(err);
  }

  private async find(ctx: AuthContext, id: string): Promise<DetailRow> {
    const row = await this.prisma.route.findFirst({
      where: { AND: [this.scopeWhere(ctx), { id }] },
      include: { stops: { orderBy: { seq: 'asc' } }, schedules: { orderBy: [{ startMin: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!row) throw new NotFoundException('Route not found');
    return row;
  }

  private async findWritable(ctx: AuthContext, id: string): Promise<DetailRow> {
    const row = await this.find(ctx, id);
    if (ctx.dataScope !== 'COMPANY' && row.branchId === null) throw new ForbiddenException('Company-wide routes are read-only for you');
    return row;
  }

  private async findSchedule(ctx: AuthContext, routeId: string, scheduleId: string): Promise<RouteSchedule> {
    const row = await this.prisma.routeSchedule.findFirst({ where: { id: scheduleId, routeId, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('Schedule not found');
    return row;
  }

  /** Owner branch: must exist in the company; ASSIGNED-scope callers must pick one of their branches. */
  private async checkBranch(ctx: AuthContext, branchId: string | null): Promise<string | null> {
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({ where: { id: branchId, companyId: ctx.companyId }, select: { id: true } });
      if (!branch) throw new BadRequestException('Unknown branch');
    }
    if (ctx.dataScope !== 'COMPANY' && (!branchId || !ctx.branchIds.includes(branchId))) throw new ForbiddenException('Choose one of your branches as the owner');
    return branchId;
  }

  private async checkObject(ctx: AuthContext, objectId: string): Promise<string> {
    const object = await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(ctx), { id: objectId }] }, select: { id: true } });
    if (!object) throw new BadRequestException('Unknown vehicle');
    return object.id;
  }

  private async checkDriver(ctx: AuthContext, driverId: string): Promise<string> {
    const driver = await this.prisma.driver.findFirst({ where: { AND: [driverScopeWhere(ctx), { id: driverId }] }, select: { id: true } });
    if (!driver) throw new BadRequestException('Unknown driver');
    return driver.id;
  }

  private async freeCopyName(companyId: string, name: string): Promise<string> {
    const base = `${name.slice(0, 90)} (copy`;
    const taken = new Set((await this.prisma.route.findMany({ where: { companyId, name: { startsWith: base } }, select: { name: true } })).map((r) => r.name));
    if (!taken.has(`${base})`)) return `${base})`;
    for (let i = 2; i < 1000; i++) if (!taken.has(`${base} ${i})`)) return `${base} ${i})`;
    throw new ConflictException('Too many copies of this route');
  }

  private async branchNames(rows: Route[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))];
    const branches = ids.length ? await this.prisma.branch.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    return new Map(branches.map((b) => [b.id, b.name]));
  }

  private summary(r: Route, stopCount: number, scheduleCount: number, branches: Map<string, string>): RouteSummaryDto {
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      description: r.description,
      branchId: r.branchId,
      branchName: r.branchId ? (branches.get(r.branchId) ?? null) : null,
      corridorM: r.corridorM,
      distanceM: r.distanceM,
      durationSec: r.durationSec,
      stopCount,
      scheduleCount,
      isActive: r.isActive,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }

  private async toDetail(r: DetailRow): Promise<RouteDto> {
    const branches = await this.branchNames([r]);
    return {
      ...this.summary(r, r.stops.length, r.schedules.length, branches),
      path: cleanPath(r.path) as RoutePath | null,
      stops: r.stops.map(
        (s): RouteStopDto => ({
          id: s.id,
          seq: s.seq,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          radiusM: s.radiusM,
          offsetMin: s.offsetMin,
          waitMin: s.waitMin,
          geofenceId: s.geofenceId,
        }),
      ),
      schedules: await this.scheduleDtos(r.schedules),
    };
  }

  private async scheduleDtos(rows: RouteSchedule[]): Promise<RouteScheduleDto[]> {
    const objectIds = [...new Set(rows.map((r) => r.objectId).filter((x): x is string => !!x))];
    const driverIds = [...new Set(rows.map((r) => r.driverId).filter((x): x is string => !!x))];
    const [objects, drivers] = await Promise.all([
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true } }) : [],
      driverIds.length ? this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true } }) : [],
    ]);
    const on = new Map(objects.map((o) => [o.id, o.name]));
    const dn = new Map(drivers.map((d) => [d.id, d.name]));
    return rows.map((s) => ({
      id: s.id,
      routeId: s.routeId,
      days: s.days,
      startMin: s.startMin,
      objectId: s.objectId,
      objectName: s.objectId ? (on.get(s.objectId) ?? null) : null,
      driverId: s.driverId,
      driverName: s.driverId ? (dn.get(s.driverId) ?? null) : null,
      validFrom: dateOnlyKey(s.validFrom),
      validTo: dateOnlyKey(s.validTo),
      isActive: s.isActive,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
    }));
  }
}
