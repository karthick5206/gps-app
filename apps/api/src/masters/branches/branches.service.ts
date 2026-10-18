import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BranchDto } from '@veetracer/shared';
import { branchScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { BranchListQuery, CreateBranchDto, UpdateBranchDto } from './branches.dto';

const ENTITY = 'branch';
const INCLUDE = { _count: { select: { objects: true } } } satisfies Prisma.BranchInclude;
type Row = Prisma.BranchGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['name', 'code', 'address'],
  sort: { name: 'name', code: 'code', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<BranchDto> = {
  name: 'branches',
  columns: [
    { header: 'Name', value: (b) => b.name },
    { header: 'Code', value: (b) => b.code },
    { header: 'Address', value: (b) => b.address },
    { header: 'Objects', value: (b) => b.objectCount },
    { header: 'Active', value: (b) => (b.isActive ? 'Yes' : 'No') },
    { header: 'Created', value: (b) => b.createdAt },
  ],
};

function toDto(b: Row): BranchDto {
  return {
    id: b.id,
    name: b.name,
    code: b.code,
    address: b.address,
    isActive: b.isActive,
    objectCount: b._count.objects,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
  };
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: AuthContext, query: BranchListQuery) {
    const plan = planList<Prisma.BranchWhereInput, Prisma.BranchOrderByWithRelationInput>(query, LIST);
    const where: Prisma.BranchWhereInput = { AND: [branchScopeWhere(ctx), plan.where] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.branch.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.branch.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<BranchDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateBranchDto): Promise<BranchDto> {
    const row = await this.prisma.branch.create({
      data: { companyId: ctx.companyId, name: dto.name.trim(), code: dto.code, address: dto.address, isActive: dto.isActive },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: row });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateBranchDto): Promise<BranchDto> {
    const before = await this.find(ctx, id);
    const row = await this.prisma.branch.update({
      where: { id },
      data: { name: dto.name?.trim(), code: dto.code, address: dto.address, isActive: dto.isActive },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before, after: row });
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.branch.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'branches', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.branch.findFirst({ where: { AND: [branchScopeWhere(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Branch not found');
    return row;
  }
}
