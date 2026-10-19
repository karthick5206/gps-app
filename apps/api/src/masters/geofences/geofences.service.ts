import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Geofence, GeofenceTarget, Prisma } from '@prisma/client';
import { GeofenceDto, GeofenceGeometry, GeofenceVisitDto, TimeWindow } from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AlertTargetsService } from '../../alerts/alert-targets.service';
import { cleanGeometry, geometryBBox, validateGeometry } from '../../alerts/logic/geofence-geometry';
import { isValidTimeWindow } from '../../alerts/logic/time-window';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { httpErrorFromPrisma } from '../../common/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportItem, parseCsvGeofences, parseGeoJsonGeofences } from './geofence-import';
import { CreateGeofenceDto, GeofenceListQuery, ImportGeofencesDto, UpdateGeofenceDto } from './geofences.dto';

const ENTITY = 'geofence';
const VISITS_MAX = 2000;
const IMPORT_MAX = 2000;

type Row = Geofence & { targets: GeofenceTarget[] };

const LIST: ListSpec = {
  search: ['name', 'category', 'address', 'description'],
  sort: { name: 'name', category: 'category', mode: 'mode', type: 'type', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<GeofenceDto> = {
  name: 'geofences',
  columns: [
    { header: 'Name', value: (g) => g.name },
    { header: 'Category', value: (g) => g.category },
    { header: 'Type', value: (g) => g.geometry.type },
    { header: 'Centre lat', value: (g) => (g.geometry.type === 'CIRCLE' ? g.geometry.center.lat : null) },
    { header: 'Centre lng', value: (g) => (g.geometry.type === 'CIRCLE' ? g.geometry.center.lng : null) },
    { header: 'Radius (m)', value: (g) => (g.geometry.type === 'CIRCLE' ? g.geometry.radiusM : null) },
    { header: 'Points', value: (g) => (g.geometry.type === 'CIRCLE' ? null : g.geometry.points.length) },
    { header: 'Mode', value: (g) => g.mode },
    { header: 'Branch', value: (g) => g.branchName ?? 'Company-wide' },
    { header: 'Notify enter', value: (g) => (g.notifyEnter ? 'Yes' : 'No') },
    { header: 'Notify exit', value: (g) => (g.notifyExit ? 'Yes' : 'No') },
    { header: 'Max stay (min)', value: (g) => g.maxStayMin },
    { header: 'Speed limit (km/h)', value: (g) => g.speedLimitKph },
    { header: 'Applies to', value: (g) => (g.appliesTo.all ? 'All' : `${g.appliesTo.branchIds.length} branches, ${g.appliesTo.groupIds.length} groups, ${g.appliesTo.objectIds.length} objects`) },
    { header: 'Active', value: (g) => (g.isActive ? 'Yes' : 'No') },
  ],
};

function snapshot(g: Row) {
  const { targets, ...rest } = g;
  return { ...rest, targets: targets.map((t) => `${t.kind}:${t.refId}`).sort() };
}

@Injectable()
export class GeofencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly targets: AlertTargetsService,
  ) {}

  /** ASSIGNED-scope users see geofences of their branches plus company-wide ones. */
  private scopeWhere(ctx: AuthContext): Prisma.GeofenceWhereInput {
    if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
    return { companyId: ctx.companyId, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
  }

  private async toDtos(rows: Row[]): Promise<GeofenceDto[]> {
    const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))];
    const branches = branchIds.length ? await this.prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(branches.map((b) => [b.id, b.name]));
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      category: g.category,
      geometry: g.geometry as unknown as GeofenceGeometry,
      color: g.color,
      address: g.address,
      description: g.description,
      branchId: g.branchId,
      branchName: g.branchId ? (names.get(g.branchId) ?? null) : null,
      mode: g.mode,
      notifyEnter: g.notifyEnter,
      notifyExit: g.notifyExit,
      maxStayMin: g.maxStayMin,
      speedLimitKph: g.speedLimitKph,
      timeWindows: Array.isArray(g.timeWindows) ? (g.timeWindows as unknown as TimeWindow[]) : [],
      appliesTo: {
        all: g.appliesToAll,
        branchIds: g.targets.filter((t) => t.kind === 'BRANCH').map((t) => t.refId),
        groupIds: g.targets.filter((t) => t.kind === 'GROUP').map((t) => t.refId),
        objectIds: g.targets.filter((t) => t.kind === 'OBJECT').map((t) => t.refId),
      },
      isActive: g.isActive,
      createdAt: iso(g.createdAt),
      updatedAt: iso(g.updatedAt),
    }));
  }

  async list(ctx: AuthContext, query: GeofenceListQuery) {
    const plan = planList<Prisma.GeofenceWhereInput, Prisma.GeofenceOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.GeofenceWhereInput[] = [this.scopeWhere(ctx), plan.where];
    if (query.category) filters.push({ category: query.category });
    if (query.branchId) filters.push({ branchId: query.branchId });
    if (query.mode) filters.push({ mode: query.mode });
    if (query.type) filters.push({ type: query.type as Geofence['type'] });
    const where: Prisma.GeofenceWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.geofence.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: { targets: true } }),
      this.prisma.geofence.count({ where }),
    ]);
    return listResult(plan, await this.toDtos(rows), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<GeofenceDto> {
    return (await this.toDtos([await this.find(ctx, id)]))[0];
  }

  async create(ctx: AuthContext, dto: CreateGeofenceDto): Promise<GeofenceDto> {
    const data = await this.prepare(ctx, dto, null);
    const row = await this.prisma.geofence.create({
      data: { ...data.fields, companyId: ctx.companyId, name: dto.name.trim(), targets: { create: data.targets } } as Prisma.GeofenceUncheckedCreateInput,
      include: { targets: true },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: snapshot(row) });
    await this.targets.invalidate(ctx.companyId, 'geofence');
    return (await this.toDtos([row]))[0];
  }

  async update(ctx: AuthContext, id: string, dto: UpdateGeofenceDto): Promise<GeofenceDto> {
    const before = await this.findWritable(ctx, id);
    const data = await this.prepare(ctx, dto, before);
    const row = await this.prisma.$transaction(async (tx) => {
      if (data.targetsChanged) {
        await tx.geofenceTarget.deleteMany({ where: { geofenceId: id } });
        if (data.targets.length) await tx.geofenceTarget.createMany({ data: data.targets.map((t) => ({ ...t, geofenceId: id })) });
      }
      return tx.geofence.update({
        where: { id },
        data: { ...data.fields, name: dto.name?.trim() } as Prisma.GeofenceUncheckedUpdateInput,
        include: { targets: true },
      });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: snapshot(before), after: snapshot(row) });
    await this.targets.invalidate(ctx.companyId, 'geofence');
    return (await this.toDtos([row]))[0];
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findWritable(ctx, id);
    await this.prisma.geofence.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: snapshot(before) });
    await this.targets.invalidate(ctx.companyId, 'geofence');
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'geofences', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  async import(ctx: AuthContext, dto: ImportGeofencesDto, file?: { buffer: Buffer; originalname?: string }) {
    const content = file ? file.buffer.toString('utf8') : dto.content;
    if (!content?.trim()) throw new BadRequestException('Upload a file or send its content');
    const format = dto.format ?? (file?.originalname?.toLowerCase().endsWith('.csv') ? 'csv' : content.trim().startsWith('{') ? 'geojson' : 'csv');
    let items: ImportItem[];
    try {
      items = format === 'csv' ? parseCsvGeofences(content) : parseGeoJsonGeofences(JSON.parse(content));
    } catch (error) {
      throw new BadRequestException(`Could not read the file: ${(error as Error).message}`);
    }
    if (!items.length) throw new BadRequestException('The file contains no geofences');
    if (items.length > IMPORT_MAX) throw new BadRequestException(`At most ${IMPORT_MAX} geofences per import`);
    let created = 0;
    const failed: { index: number; name: string; message: string }[] = [];
    for (const item of items) {
      if (!item.geometry) {
        failed.push({ index: item.index, name: item.name, message: item.error ?? 'Invalid geometry' });
        continue;
      }
      try {
        await this.createImported(ctx, {
          name: item.name,
          geometry: item.geometry,
          category: item.category ?? dto.category,
          color: item.color ?? dto.color,
          description: item.description,
          branchId: dto.branchId,
        });
        created++;
      } catch (error) {
        const http = httpErrorFromPrisma(error);
        failed.push({ index: item.index, name: item.name, message: http?.message ?? (error as Error).message });
      }
    }
    if (created) await this.targets.invalidate(ctx.companyId, 'geofence_import');
    return { created, failed };
  }

  /**
   * Create one imported geofence (same validation as the form; applies to all vehicles). The caller invalidates the
   * alert targets once after the whole import.
   */
  async createImported(
    ctx: AuthContext,
    item: { name: string; geometry: GeofenceGeometry; category?: string; color?: string; description?: string; address?: string; branchId?: string | null },
  ): Promise<string> {
    const data = await this.prepare(
      ctx,
      {
        name: item.name.slice(0, 100),
        geometry: item.geometry as unknown as Record<string, unknown>,
        category: item.category,
        color: item.color,
        description: item.description,
        address: item.address,
        branchId: item.branchId ?? undefined,
      },
      null,
      false,
    );
    const row = await this.prisma.geofence.create({
      data: { ...data.fields, companyId: ctx.companyId, name: item.name.trim().slice(0, 100) } as Prisma.GeofenceUncheckedCreateInput,
      include: { targets: true },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: { ...snapshot(row), imported: true } });
    return row.id;
  }

  async invalidateTargets(companyId: string, reason: string): Promise<void> {
    await this.targets.invalidate(companyId, reason);
  }

  /** Geofences visible to the caller (for KML / GeoJSON export). */
  async exportRows(ctx: AuthContext, activeOnly: boolean) {
    return this.prisma.geofence.findMany({
      where: { AND: [this.scopeWhere(ctx), activeOnly ? { isActive: true } : {}] },
      orderBy: { name: 'asc' },
      take: 10_000,
      select: { name: true, category: true, color: true, description: true, geometry: true },
    });
  }

  async visits(ctx: AuthContext, id: string, from?: string, to?: string, objectId?: string): Promise<GeofenceVisitDto[]> {
    const g = await this.find(ctx, id);
    const objectFilter =
      ctx.dataScope === 'COMPANY'
        ? undefined
        : (await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } })).map((o) => o.id);
    const rows = await this.prisma.geofenceVisit.findMany({
      where: {
        companyId: ctx.companyId,
        geofenceId: id,
        ...(objectId ? { objectId } : {}),
        ...(objectFilter ? { objectId: objectId ? (objectFilter.includes(objectId) ? objectId : '00000000-0000-0000-0000-000000000000') : { in: objectFilter } } : {}),
        ...(to ? { enterTime: { lte: new Date(to) } } : {}),
        ...(from ? { OR: [{ exitTime: null }, { exitTime: { gte: new Date(from) } }] } : {}),
      },
      orderBy: { enterTime: 'desc' },
      take: VISITS_MAX,
    });
    const objectIds = [...new Set(rows.map((r) => r.objectId))];
    const objects = objectIds.length ? await this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(objects.map((o) => [o.id, o.name]));
    return rows.map((v) => ({
      objectId: v.objectId,
      objectName: names.get(v.objectId) ?? 'Unknown object',
      geofenceId: v.geofenceId,
      geofenceName: g.name,
      enterTime: iso(v.enterTime),
      exitTime: v.exitTime ? iso(v.exitTime) : null,
      durationSec: v.durationSec,
    }));
  }

  // ───────────── helpers ─────────────
  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.geofence.findFirst({ where: { AND: [this.scopeWhere(ctx), { id }] }, include: { targets: true } });
    if (!row) throw new NotFoundException('Geofence not found');
    return row;
  }

  private async findWritable(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.find(ctx, id);
    if (ctx.dataScope !== 'COMPANY' && row.branchId === null) throw new ForbiddenException('Company-wide geofences are read-only for you');
    return row;
  }

  /** Validates the body and returns column values (only the provided ones on update) and target rows. */
  private async prepare(ctx: AuthContext, dto: UpdateGeofenceDto, before: Row | null, withTargets = true) {
    const fields: Record<string, unknown> = {};
    if (dto.geometry !== undefined) {
      const err = validateGeometry(dto.geometry);
      if (err) throw new BadRequestException(err);
      const geometry = cleanGeometry(dto.geometry as unknown as GeofenceGeometry);
      Object.assign(fields, { type: geometry.type, geometry, ...geometryBBox(geometry) });
    } else if (!before) {
      throw new BadRequestException('Geometry is required');
    }
    if (dto.branchId !== undefined) {
      if (dto.branchId !== null) {
        const branch = await this.prisma.branch.findFirst({ where: { id: dto.branchId, companyId: ctx.companyId } });
        if (!branch) throw new BadRequestException('Unknown branch');
      }
      fields.branchId = dto.branchId;
    }
    const branchId = dto.branchId !== undefined ? dto.branchId : (before?.branchId ?? null);
    if (ctx.dataScope !== 'COMPANY' && (!branchId || !ctx.branchIds.includes(branchId))) {
      throw new ForbiddenException('Choose one of your branches as the owner');
    }
    if (dto.timeWindows !== undefined) {
      if (!dto.timeWindows.every(isValidTimeWindow)) throw new BadRequestException('Time windows must be {days: [1–7], from: "HH:mm", to: "HH:mm"}');
      fields.timeWindows = dto.timeWindows as unknown as Prisma.InputJsonValue;
    }
    for (const key of ['category', 'color', 'address', 'description', 'mode', 'notifyEnter', 'notifyExit', 'maxStayMin', 'speedLimitKph', 'isActive'] as const) {
      if (dto[key] !== undefined) fields[key] = dto[key];
    }
    if (!before && fields.category === undefined) fields.category = 'OTHER';

    let targets: { kind: string; refId: string }[] = [];
    let targetsChanged = false;
    if (withTargets && dto.appliesTo) {
      targetsChanged = true;
      fields.appliesToAll = dto.appliesTo.all;
      if (!dto.appliesTo.all) {
        const branchIds = [...new Set(dto.appliesTo.branchIds ?? [])];
        const groupIds = [...new Set(dto.appliesTo.groupIds ?? [])];
        const objectIds = [...new Set(dto.appliesTo.objectIds ?? [])];
        if (!branchIds.length && !groupIds.length && !objectIds.length) {
          throw new BadRequestException('Choose at least one branch, group or vehicle, or apply to all');
        }
        const [b, g, o] = await Promise.all([
          branchIds.length ? this.prisma.branch.count({ where: { companyId: ctx.companyId, id: { in: branchIds } } }) : 0,
          groupIds.length ? this.prisma.vehicleGroup.count({ where: { companyId: ctx.companyId, id: { in: groupIds } } }) : 0,
          objectIds.length ? this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds } }] } }) : 0,
        ]);
        if (b !== branchIds.length) throw new BadRequestException('Unknown branch in applies-to');
        if (g !== groupIds.length) throw new BadRequestException('Unknown vehicle group in applies-to');
        if (o !== objectIds.length) throw new BadRequestException('Unknown vehicle in applies-to');
        targets = [
          ...branchIds.map((refId) => ({ kind: 'BRANCH', refId })),
          ...groupIds.map((refId) => ({ kind: 'GROUP', refId })),
          ...objectIds.map((refId) => ({ kind: 'OBJECT', refId })),
        ];
      }
    }
    return { fields, targets, targetsChanged };
  }
}
