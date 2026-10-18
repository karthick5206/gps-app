import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Lookup, Prisma } from '@prisma/client';
import { LookupDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLookupDto, LookupListQuery, UpdateLookupDto } from './lookups.dto';

const ENTITY = 'lookup';

const LIST: ListSpec = {
  search: ['type', 'code', 'label'],
  sort: { type: 'type', code: 'code', label: 'label', sortOrder: 'sortOrder', createdAt: 'createdAt' },
  defaultSort: 'sortOrder',
};

const CSV: CsvSpec<LookupDto> = {
  name: 'lookups',
  columns: [
    { header: 'Type', value: (l) => l.type },
    { header: 'Code', value: (l) => l.code },
    { header: 'Label', value: (l) => l.label },
    { header: 'Sort order', value: (l) => l.sortOrder },
    { header: 'System', value: (l) => (l.isSystem ? 'Yes' : 'No') },
    { header: 'Active', value: (l) => (l.isActive ? 'Yes' : 'No') },
  ],
};

function toDto(l: Lookup): LookupDto {
  return {
    id: l.id,
    type: l.type,
    code: l.code,
    label: l.label,
    sortOrder: l.sortOrder,
    isSystem: l.companyId === null,
    isActive: l.isActive,
  };
}

/** The Super Admin acting in the platform company maintains system lookups (companyId null). */
const isPlatformContext = (ctx: AuthContext) => ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId;

/** System lookups (shared, read-only for companies) plus the company's own values. */
@Injectable()
export class LookupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: AuthContext, query: LookupListQuery) {
    const plan = planList<Prisma.LookupWhereInput, Prisma.LookupOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.LookupWhereInput[] = [{ OR: [{ companyId: null }, { companyId: ctx.companyId }] }, plan.where];
    if (query.type) filters.push({ type: query.type });
    const where: Prisma.LookupWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.lookup.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.lookup.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<LookupDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateLookupDto): Promise<LookupDto> {
    const row = await this.prisma.lookup.create({
      data: { ...dto, label: dto.label.trim(), companyId: isPlatformContext(ctx) ? null : ctx.companyId },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: row });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateLookupDto): Promise<LookupDto> {
    const before = await this.findWritable(ctx, id);
    const row = await this.prisma.lookup.update({ where: { id }, data: { ...dto, label: dto.label?.trim() } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before, after: row });
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findWritable(ctx, id);
    await this.prisma.lookup.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'lookups', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    const row = await this.find(ctx, id);
    return row.companyId === null ? this.audit.platformHistory(ENTITY, id) : this.audit.history(ctx, ENTITY, id);
  }

  private async find(ctx: AuthContext, id: string): Promise<Lookup> {
    const row = await this.prisma.lookup.findFirst({ where: { id, OR: [{ companyId: null }, { companyId: ctx.companyId }] } });
    if (!row) throw new NotFoundException('Lookup not found');
    return row;
  }

  private async findWritable(ctx: AuthContext, id: string): Promise<Lookup> {
    const row = await this.find(ctx, id);
    if (row.companyId === null && !isPlatformContext(ctx)) throw new ForbiddenException('System lookups are read-only');
    return row;
  }
}
