import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CompanyDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { ensureSystemRoles } from '../../access/system-roles';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { toCompanySummary } from '../../common/company-summary';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { hashPassword } from '../../common/secrets';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CompanyListQuery, CreateCompanyDto, UpdateCompanyDto } from './companies.dto';

const ENTITY = 'company';
export const DEFAULT_PARTNER_SLUG = 'veetracer';
const INCLUDE = {
  _count: { select: { branches: true, users: true, objects: true, devices: true } },
} satisfies Prisma.CompanyInclude;
type Row = Prisma.CompanyGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['name'],
  sort: { name: 'name', status: 'status', accountType: 'accountType', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
  status: (active) => ({ status: active ? 'ACTIVE' : 'SUSPENDED' }),
};

const CSV: CsvSpec<CompanyDto> = {
  name: 'companies',
  columns: [
    { header: 'Name', value: (c) => c.name },
    { header: 'Account type', value: (c) => c.accountType },
    { header: 'Status', value: (c) => c.status },
    { header: 'Timezone', value: (c) => c.timezone },
    { header: 'Branches', value: (c) => c.branchCount },
    { header: 'Users', value: (c) => c.userCount },
    { header: 'Objects', value: (c) => c.objectCount },
    { header: 'Devices', value: (c) => c.deviceCount },
    { header: 'Created', value: (c) => c.createdAt },
  ],
};

function toDto(c: Row): CompanyDto {
  return {
    ...toCompanySummary(c),
    branchCount: c._count.branches,
    userCount: c._count.users,
    objectCount: c._count.objects,
    deviceCount: c._count.devices,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

/** Customer companies (Super Admin). The platform company itself is never listed or editable here. */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(query: CompanyListQuery) {
    const plan = planList<Prisma.CompanyWhereInput, Prisma.CompanyOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.CompanyWhereInput[] = [{ isPlatform: false }, plan.where];
    if (query.accountType) filters.push({ accountType: query.accountType });
    const where: Prisma.CompanyWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.company.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.company.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(id: string): Promise<CompanyDto> {
    return toDto(await this.find(id));
  }

  /** Company + system roles + "Head Office" branch + first Admin user, atomically. */
  async create(ctx: AuthContext, dto: CreateCompanyDto): Promise<CompanyDto> {
    const email = dto.admin.email?.trim().toLowerCase();
    if (!email && !dto.admin.mobile) throw new BadRequestException('Admin email or mobile is required');
    const passwordHash = await hashPassword(dto.admin.password);
    const row = await this.prisma.$transaction(async (tx) => {
      const partner = await tx.partner.findUnique({ where: { slug: DEFAULT_PARTNER_SLUG } });
      if (!partner) throw new BadRequestException('Default partner missing — run the seed');
      const company = await tx.company.create({
        data: { partnerId: partner.id, name: dto.name.trim(), accountType: dto.accountType, timezone: dto.timezone },
      });
      const roles = await ensureSystemRoles(tx, company.id);
      const branch = await tx.branch.create({ data: { companyId: company.id, name: 'Head Office' } });
      await tx.user.create({
        data: {
          companyId: company.id,
          name: dto.admin.name.trim(),
          email,
          mobile: dto.admin.mobile,
          passwordHash,
          roles: { create: [{ roleId: roles.get('Admin')! }] },
          branches: { create: [{ branchId: branch.id }] },
        },
      });
      return tx.company.findUniqueOrThrow({ where: { id: company.id }, include: INCLUDE });
    });
    await this.audit.record(ctx, {
      action: 'CREATE',
      entity: ENTITY,
      entityId: row.id,
      after: { ...row, adminEmail: email ?? null, adminMobile: dto.admin.mobile ?? null },
    });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateCompanyDto): Promise<CompanyDto> {
    const before = await this.find(id);
    const row = await this.prisma.company.update({
      where: { id },
      data: { ...dto, name: dto.name?.trim() },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before, after: row });
    if (dto.status && dto.status !== before.status) await this.redis.invalidateCache('company');
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(id);
    await this.prisma.company.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'sa_companies', dto, {
      setActive: (id, active) => this.update(ctx, id, { status: active ? 'ACTIVE' : 'SUSPENDED' }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(id: string) {
    await this.find(id);
    return this.audit.platformHistory(ENTITY, id);
  }

  private async find(id: string): Promise<Row> {
    const row = await this.prisma.company.findFirst({ where: { id, isPlatform: false }, include: INCLUDE });
    if (!row) throw new NotFoundException('Company not found');
    return row;
  }
}
