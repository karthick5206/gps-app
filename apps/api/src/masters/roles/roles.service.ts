import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Action, MenuKey, RoleDto } from '@veetracer/shared';
import { validateRolePermissions } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CreateRoleDto, RolePermissionDto, RoleListQuery, UpdateRoleDto } from './roles.dto';

const ENTITY = 'role';
const INCLUDE = { permissions: true, _count: { select: { users: true } } } satisfies Prisma.RoleInclude;
type Row = Prisma.RoleGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['name', 'description'],
  sort: { name: 'name', dataScope: 'dataScope', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
  status: null,
};

const CSV: CsvSpec<RoleDto> = {
  name: 'roles',
  columns: [
    { header: 'Name', value: (r) => r.name },
    { header: 'Description', value: (r) => r.description },
    { header: 'Data scope', value: (r) => r.dataScope },
    { header: 'System', value: (r) => (r.isSystem ? 'Yes' : 'No') },
    { header: 'Users', value: (r) => r.userCount },
  ],
};

function toDto(r: Row): RoleDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    dataScope: r.dataScope,
    permissions: r.permissions.map((p) => ({ menu: p.menu as MenuKey, actions: p.actions as Action[] })),
    userCount: r._count.users,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function snapshot(r: Row) {
  const { permissions, _count, ...scalars } = r;
  return { ...scalars, permissions: Object.fromEntries(permissions.map((p) => [p.menu, p.actions])) };
}

function checkedPermissions(perms: RolePermissionDto[]): { menu: string; actions: string[] }[] {
  const nonEmpty = perms.filter((p) => p.actions.length > 0).map((p) => ({ menu: p.menu, actions: [...new Set(p.actions)] }));
  const error = validateRolePermissions(nonEmpty);
  if (error) throw new BadRequestException(error);
  return nonEmpty;
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(ctx: AuthContext, query: RoleListQuery) {
    const plan = planList<Prisma.RoleWhereInput, Prisma.RoleOrderByWithRelationInput>(query, LIST);
    // ASSIGNED-scope callers may only hand out ASSIGNED-scope roles, so only list those.
    const scope: Prisma.RoleWhereInput = ctx.dataScope === 'COMPANY' ? {} : { dataScope: 'ASSIGNED' };
    const where: Prisma.RoleWhereInput = { AND: [{ companyId: ctx.companyId }, scope, plan.where] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.role.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<RoleDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateRoleDto): Promise<RoleDto> {
    const permissions = checkedPermissions(dto.permissions);
    const row = await this.prisma.role.create({
      data: {
        companyId: ctx.companyId,
        name: dto.name.trim(),
        description: dto.description,
        dataScope: dto.dataScope,
        permissions: { create: permissions },
      },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: snapshot(row) });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateRoleDto): Promise<RoleDto> {
    const before = await this.find(ctx, id);
    if (before.isSystem && dto.name !== undefined && dto.name.trim() !== before.name) {
      throw new ForbiddenException('System roles cannot be renamed');
    }
    if (before.isSystem && dto.dataScope !== undefined && dto.dataScope !== before.dataScope) {
      throw new ForbiddenException('The data scope of a system role cannot be changed');
    }
    const permissions = dto.permissions ? checkedPermissions(dto.permissions) : undefined;
    const row = await this.prisma.$transaction(async (tx) => {
      if (permissions) await tx.rolePermission.deleteMany({ where: { roleId: id } });
      return tx.role.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          description: dto.description,
          dataScope: dto.dataScope,
          permissions: permissions ? { create: permissions } : undefined,
        },
        include: INCLUDE,
      });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: snapshot(before), after: snapshot(row) });
    await this.redis.invalidateCache('role');
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    if (before.isSystem) throw new ForbiddenException('System roles cannot be deleted');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: snapshot(before) });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'roles', dto, {
      setActive: () => Promise.reject(new BadRequestException('Roles cannot be activated or deactivated')),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.role.findFirst({ where: { id, companyId: ctx.companyId }, include: INCLUDE });
    if (!row) throw new NotFoundException('Role not found');
    return row;
  }
}
