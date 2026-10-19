import { BadRequestException, ForbiddenException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Poi, Prisma } from '@prisma/client';
import {
  GeofenceGeometry,
  POI_DEFAULT_COLOR,
  POI_DEFAULT_RADIUS_M,
  POI_IMPORT_MAX_BYTES,
  POI_MAX_RADIUS_M,
  POI_MIN_RADIUS_M,
  PoiDto,
  PoiImportPreview,
  PoiImportResult,
} from '@veetracer/shared';
import { hasPermission } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { BulkActionDto, runBulk } from '../common/bulk';
import { iso } from '../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { httpErrorFromPrisma } from '../common/prisma-errors';
import { GeofencesService } from '../masters/geofences/geofences.service';
import { PrismaService } from '../prisma/prisma.service';
import { toGeoJson, toKml } from './poi-export';
import { detectFormat, ImportFormatError, parseImportFile } from './poi-import';
import { CreatePoiDto, ExportQuery, ImportCommitDto, PoiListQuery, UpdatePoiDto } from './pois.dto';

const ENTITY = 'poi';
type Scope = Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds'>;

/** ASSIGNED-scope users see POIs of their branches plus company-wide ones (same rule as geofences). */
export function poiScopeWhere(ctx: Scope): Prisma.PoiWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
}

/** Whether the caller may change a POI owned by `branchId` (null = company-wide: company-scope roles only). */
export function canWritePoi(ctx: Scope, branchId: string | null): boolean {
  if (ctx.dataScope === 'COMPANY') return true;
  return branchId !== null && ctx.branchIds.includes(branchId);
}

const LIST: ListSpec = {
  search: ['name', 'category', 'address', 'description'],
  sort: { name: 'name', category: 'category', radiusM: 'radiusM', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<PoiDto> = {
  name: 'pois',
  columns: [
    { header: 'name', value: (p) => p.name },
    { header: 'lat', value: (p) => p.lat },
    { header: 'lng', value: (p) => p.lng },
    { header: 'category', value: (p) => p.category },
    { header: 'address', value: (p) => p.address },
    { header: 'radius', value: (p) => p.radiusM },
    { header: 'description', value: (p) => p.description },
    { header: 'color', value: (p) => p.color },
    { header: 'owner', value: (p) => p.branchName ?? 'Company-wide' },
    { header: 'active', value: (p) => (p.isActive ? 'Yes' : 'No') },
  ],
};

@Injectable()
export class PoisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly geofences: GeofencesService,
  ) {}

  private async toDtos(rows: Poi[]): Promise<PoiDto[]> {
    const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))];
    const branches = branchIds.length ? await this.prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(branches.map((b) => [b.id, b.name]));
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      lat: p.lat,
      lng: p.lng,
      address: p.address,
      radiusM: p.radiusM,
      icon: p.icon,
      color: p.color,
      description: p.description,
      branchId: p.branchId,
      branchName: p.branchId ? (names.get(p.branchId) ?? null) : null,
      isActive: p.isActive,
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt),
    }));
  }

  async list(ctx: AuthContext, query: PoiListQuery) {
    const plan = planList<Prisma.PoiWhereInput, Prisma.PoiOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.PoiWhereInput[] = [poiScopeWhere(ctx), plan.where];
    if (query.category) filters.push({ category: query.category });
    if (query.branchId) filters.push({ branchId: query.branchId });
    if (query.bbox) {
      const [minLat, minLng, maxLat, maxLng] = query.bbox.split(',').map(Number);
      filters.push({ lat: { gte: minLat, lte: maxLat }, lng: { gte: minLng, lte: maxLng } });
    }
    const where: Prisma.PoiWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.poi.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.poi.count({ where }),
    ]);
    return listResult(plan, await this.toDtos(rows), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<PoiDto> {
    return (await this.toDtos([await this.find(ctx, id)]))[0];
  }

  async create(ctx: AuthContext, dto: CreatePoiDto, imported = false): Promise<PoiDto> {
    const fields = await this.prepare(ctx, dto, null);
    const row = await this.prisma.poi.create({ data: { ...fields, companyId: ctx.companyId } as Prisma.PoiUncheckedCreateInput });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: imported ? { ...row, imported: true } : row });
    return (await this.toDtos([row]))[0];
  }

  async update(ctx: AuthContext, id: string, dto: UpdatePoiDto): Promise<PoiDto> {
    const before = await this.findWritable(ctx, id);
    const fields = await this.prepare(ctx, dto, before);
    const row = await this.prisma.poi.update({ where: { id }, data: fields as Prisma.PoiUncheckedUpdateInput });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before, after: row });
    return (await this.toDtos([row]))[0];
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findWritable(ctx, id);
    await this.prisma.poi.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'pois', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  // ───────────── import ─────────────

  /** Parse an uploaded KML / KMZ / GPX / GeoJSON / CSV file and return what would be imported (nothing is saved). */
  preview(file: { buffer: Buffer; originalname?: string } | undefined): PoiImportPreview {
    if (!file?.buffer?.length) throw new BadRequestException('Upload a KML, KMZ, GPX, GeoJSON or CSV file');
    if (file.buffer.length > POI_IMPORT_MAX_BYTES) throw new BadRequestException('The file is larger than 5 MB');
    const format = detectFormat(file.originalname, file.buffer);
    try {
      const items = parseImportFile(format, file.buffer);
      return {
        format,
        items,
        counts: {
          pois: items.filter((i) => i.kind === 'POI').length,
          geofences: items.filter((i) => i.kind === 'GEOFENCE').length,
          errors: items.filter((i) => i.kind === null).length,
        },
      };
    } catch (error) {
      if (error instanceof ImportFormatError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /** Save the selected preview items: points as POIs, areas as geofences (geofences need geofences:create). */
  async commit(ctx: AuthContext, dto: ImportCommitDto): Promise<PoiImportResult> {
    const wantsGeofences = dto.items.some((i) => i.kind === 'GEOFENCE');
    if (wantsGeofences && !hasPermission(ctx, 'geofences', 'create')) throw new ForbiddenException('You may not create geofences: unselect the areas');
    const [poiCats, gfCats] = await Promise.all([this.categoryCodes(ctx.companyId, 'POI_CATEGORY'), this.categoryCodes(ctx.companyId, 'GEOFENCE_CATEGORY')]);
    const result: PoiImportResult = { pois: 0, geofences: 0, failed: [] };
    for (const item of dto.items) {
      try {
        if (item.kind === 'POI') {
          if (item.lat === undefined || item.lng === undefined) throw new BadRequestException('Latitude / longitude missing');
          if (Math.abs(item.lat) > 90 || Math.abs(item.lng) > 180) throw new BadRequestException('Latitude / longitude out of range');
          const category = item.category && poiCats.has(item.category) ? item.category : (dto.category ?? 'OTHER');
          await this.create(
            ctx,
            {
              name: item.name.trim(),
              lat: item.lat,
              lng: item.lng,
              category,
              address: item.address,
              description: item.description,
              color: item.color,
              radiusM: clampRadius(item.radiusM ?? dto.radiusM ?? POI_DEFAULT_RADIUS_M),
              branchId: dto.branchId,
            },
            true,
          );
          result.pois++;
        } else {
          if (!item.geometry) throw new BadRequestException('Geometry missing');
          const category = item.category && gfCats.has(item.category) ? item.category : dto.geofenceCategory;
          await this.geofences.createImported(ctx, {
            name: item.name,
            geometry: item.geometry as unknown as GeofenceGeometry,
            category,
            color: item.color,
            description: item.description,
            address: item.address,
            branchId: dto.branchId,
          });
          result.geofences++;
        }
      } catch (error) {
        const http = error instanceof BadRequestException || error instanceof ForbiddenException ? error : httpErrorFromPrisma(error);
        if (!http) throw error;
        result.failed.push({ index: item.index, name: item.name, message: http.message });
      }
    }
    if (result.geofences) await this.geofences.invalidateTargets(ctx.companyId, 'geofence_import');
    return result;
  }

  // ───────────── export ─────────────

  async export(ctx: AuthContext, q: ExportQuery): Promise<StreamableFile> {
    const format = q.format ?? 'kml';
    const include = q.include ?? 'all';
    const withGeofences = include !== 'pois' && hasPermission(ctx, 'geofences', 'view');
    const [pois, geofences] = await Promise.all([
      include === 'geofences' ? [] : this.prisma.poi.findMany({ where: { AND: [poiScopeWhere(ctx), { isActive: true }] }, orderBy: { name: 'asc' }, take: 50_000 }),
      withGeofences ? this.geofences.exportRows(ctx, true) : [],
    ]);
    const gf = geofences.map((g) => ({ ...g, geometry: g.geometry as unknown as GeofenceGeometry }));
    const company = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } });
    const body = format === 'kml' ? toKml(`${company?.name ?? 'VeeTrax'} places`, pois, gf) : toGeoJson(pois, gf);
    const date = new Date().toISOString().slice(0, 10);
    const base = include === 'geofences' ? 'geofences' : include === 'pois' ? 'pois' : 'places';
    return new StreamableFile(Buffer.from(body, 'utf8'), {
      type: format === 'kml' ? 'application/vnd.google-earth.kml+xml; charset=utf-8' : 'application/geo+json; charset=utf-8',
      disposition: `attachment; filename="${base}-${date}.${format}"`,
    });
  }

  // ───────────── helpers ─────────────

  private async categoryCodes(companyId: string, type: string): Promise<Set<string>> {
    const rows = await this.prisma.lookup.findMany({ where: { type, isActive: true, OR: [{ companyId: null }, { companyId }] }, select: { code: true } });
    return new Set(['OTHER', ...rows.map((r) => r.code)]);
  }

  private async find(ctx: AuthContext, id: string): Promise<Poi> {
    const row = await this.prisma.poi.findFirst({ where: { AND: [poiScopeWhere(ctx), { id }] } });
    if (!row) throw new NotFoundException('Point of interest not found');
    return row;
  }

  private async findWritable(ctx: AuthContext, id: string): Promise<Poi> {
    const row = await this.find(ctx, id);
    if (!canWritePoi(ctx, row.branchId)) throw new ForbiddenException('Company-wide points of interest are read-only for you');
    return row;
  }

  /** Validated column values (only the provided ones on update). */
  private async prepare(ctx: AuthContext, dto: UpdatePoiDto, before: Poi | null): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Name is required');
      fields.name = name;
    }
    if (dto.branchId !== undefined) {
      if (dto.branchId !== null) {
        const branch = await this.prisma.branch.findFirst({ where: { id: dto.branchId, companyId: ctx.companyId } });
        if (!branch) throw new BadRequestException('Unknown branch');
      }
      fields.branchId = dto.branchId;
    }
    const branchId = dto.branchId !== undefined ? dto.branchId : (before?.branchId ?? null);
    if (!canWritePoi(ctx, branchId)) throw new ForbiddenException('Choose one of your branches as the owner');
    for (const key of ['category', 'lat', 'lng', 'radiusM', 'isActive'] as const) {
      if (dto[key] !== undefined) fields[key] = dto[key];
    }
    for (const key of ['address', 'icon', 'description'] as const) {
      if (dto[key] !== undefined) fields[key] = dto[key]?.trim() || null;
    }
    if (dto.color !== undefined) fields.color = dto.color || POI_DEFAULT_COLOR;
    if (!before) {
      fields.category ??= 'OTHER';
      fields.radiusM ??= POI_DEFAULT_RADIUS_M;
      fields.color ??= POI_DEFAULT_COLOR;
    }
    return fields;
  }
}

const clampRadius = (r: number) => Math.min(Math.max(Math.round(r), POI_MIN_RADIUS_M), POI_MAX_RADIUS_M);
