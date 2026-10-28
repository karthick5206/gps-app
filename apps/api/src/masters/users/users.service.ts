import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserDto } from '@veetracer/shared';
import { assertCanManageUserAccess, objectScopeWhere, userScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { iso, isoOrNull } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { hashPassword } from '../../common/secrets';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CreateUserDto, UpdateUserDto, UserListQuery } from './users.dto';

const ENTITY = 'user';
const INCLUDE = {
  manager: { select: { name: true } },
  roles: { include: { role: { select: { id: true, name: true, dataScope: true } } } },
  branches: { include: { branch: { select: { id: true, name: true } } } },
  objects: { include: { object: { select: { id: true, name: true } } } },
} satisfies Prisma.UserInclude;
type Row = Prisma.UserGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['name', 'email', 'mobile'],
  sort: { name: 'name', email: 'email', mobile: 'mobile', lastLoginAt: 'lastLoginAt', createdAt: 'createdAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<UserDto> = {
  name: 'users',
  columns: [
    { header: 'Name', value: (u) => u.name },
    { header: 'Email', value: (u) => u.email },
    { header: 'Mobile', value: (u) => u.mobile },
    { header: 'Roles', value: (u) => u.roles.map((r) => r.name) },
    { header: 'Branches', value: (u) => u.branches.map((b) => b.name) },
    { header: 'Manager', value: (u) => u.managerName },
    { header: 'Active', value: (u) => (u.isActive ? 'Yes' : 'No') },
    { header: 'Last login', value: (u) => u.lastLoginAt },
  ],
};

function toDto(u: Row): UserDto {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    mobile: u.mobile,
    isActive: u.isActive,
    managerId: u.managerId,
    managerName: u.manager?.name ?? null,
    roles: u.roles.map((r) => ({ id: r.role.id, name: r.role.name })),
    branches: u.branches.map((b) => ({ id: b.branch.id, name: b.branch.name })),
    objects: u.objects.map((o) => ({ id: o.object.id, name: o.object.name })),
    lastLoginAt: isoOrNull(u.lastLoginAt),
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
  };
}

/** Audit snapshot: scalar fields plus relation ids. */
function snapshot(u: Row) {
  const { manager: _m, roles, branches, objects, ...scalars } = u;
  return {
    ...scalars,
    roleIds: roles.map((r) => r.roleId).sort(),
    branchIds: branches.map((b) => b.branchId).sort(),
    objectIds: objects.map((o) => o.objectId).sort(),
  };
}

const normaliseEmail = (email: string | null | undefined) => (email ? email.trim().toLowerCase() : null);

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(ctx: AuthContext, query: UserListQuery) {
    const plan = planList<Prisma.UserWhereInput, Prisma.UserOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.UserWhereInput[] = [userScopeWhere(ctx), plan.where];
    if (query.roleId) filters.push({ roles: { some: { roleId: query.roleId } } });
    if (query.branchId) filters.push({ branches: { some: { branchId: query.branchId } } });
    const where: Prisma.UserWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.user.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<UserDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateUserDto): Promise<UserDto> {
    const email = normaliseEmail(dto.email);
    if (!email && !dto.mobile) throw new BadRequestException('Email or mobile is required');
    const roleIds = dto.roleIds ?? [];
    const branchIds = dto.branchIds ?? [];
    const objectIds = dto.objectIds ?? [];
    await this.validateAccess(ctx, roleIds, branchIds, objectIds, dto.managerId);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
      data: {
        companyId: ctx.companyId,
        name: dto.name.trim(),
        email,
        mobile: dto.mobile,
        passwordHash: dto.password ? await hashPassword(dto.password) : null,
        managerId: dto.managerId,
        isActive: dto.isActive,
        roles: { create: roleIds.map((roleId) => ({ roleId })) },
        branches: { create: branchIds.map((branchId) => ({ branchId })) },
        objects: { create: objectIds.map((objectId) => ({ objectId })) },
      },
      include: INCLUDE,
      });
      return created;
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: snapshot(row) });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateUserDto): Promise<UserDto> {
    const before = await this.findManageable(ctx, id);
    if (id === ctx.userId && dto.isActive === false) throw new BadRequestException('You cannot deactivate yourself');
    const email = dto.email === undefined ? undefined : normaliseEmail(dto.email) || null;
    const mobile = dto.mobile;
    if (!(email === undefined ? before.email : email) && !(mobile === undefined ? before.mobile : mobile)) {
      throw new BadRequestException('Email or mobile is required');
    }
    if (dto.managerId === id) throw new BadRequestException('A user cannot be their own manager');

    const roleIds = dto.roleIds ?? before.roles.map((r) => r.roleId);
    const branchIds = dto.branchIds ?? before.branches.map((b) => b.branchId);
    const objectIds = dto.objectIds ?? before.objects.map((o) => o.objectId);
    await this.validateAccess(ctx, roleIds, branchIds, dto.objectIds ?? [], dto.managerId);

    const row = await this.prisma.$transaction(async (tx) => {
      // Re-activating a user who has no licence seat takes one from the pool.
      if (dto.roleIds) await tx.userRole.deleteMany({ where: { userId: id } });
      if (dto.branchIds) await tx.userBranch.deleteMany({ where: { userId: id } });
      if (dto.objectIds) await tx.userObject.deleteMany({ where: { userId: id } });
      return tx.user.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          email,
          mobile,
          passwordHash: dto.password ? await hashPassword(dto.password) : undefined,
          managerId: dto.managerId,
          isActive: dto.isActive,
          roles: dto.roleIds ? { create: roleIds.map((roleId) => ({ roleId })) } : undefined,
          branches: dto.branchIds ? { create: branchIds.map((branchId) => ({ branchId })) } : undefined,
          objects: dto.objectIds ? { create: objectIds.map((objectId) => ({ objectId })) } : undefined,
        },
        include: INCLUDE,
      });
    });
    if (dto.password || dto.isActive === false) {
      await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: snapshot(before), after: snapshot(row) });
    await this.redis.invalidateCache('user');
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    if (id === ctx.userId) throw new BadRequestException('You cannot delete yourself');
    const before = await this.findManageable(ctx, id);
    await this.prisma.user.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: snapshot(before) });
    await this.redis.invalidateCache('user');
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'users', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.user.findFirst({ where: { AND: [userScopeWhere(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  /** A user the caller may edit: never the Super Admin; in ASSIGNED scope only users wholly inside own branches. */
  private async findManageable(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.find(ctx, id);
    if (row.isSuperAdmin && row.id !== ctx.userId) throw new ForbiddenException('The Super Admin cannot be modified');
    if (ctx.dataScope === 'ASSIGNED' && row.id !== ctx.userId) {
      assertCanManageUserAccess(
        ctx,
        row.branches.map((b) => b.branchId),
        row.roles.map((r) => r.role),
      );
    }
    return row;
  }

  private async validateAccess(
    ctx: AuthContext,
    roleIds: string[],
    branchIds: string[],
    newObjectIds: string[],
    managerId: string | null | undefined,
  ): Promise<void> {
    const [roles, branchCount, objectCount, manager] = await Promise.all([
      this.prisma.role.findMany({ where: { id: { in: roleIds }, companyId: ctx.companyId }, select: { dataScope: true } }),
      this.prisma.branch.count({ where: { id: { in: branchIds }, companyId: ctx.companyId } }),
      this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: { in: newObjectIds } }] } }),
      managerId ? this.prisma.user.count({ where: { id: managerId, companyId: ctx.companyId } }) : Promise.resolve(1),
    ]);
    if (roles.length !== new Set(roleIds).size) throw new BadRequestException('Unknown role');
    if (branchCount !== new Set(branchIds).size) throw new BadRequestException('Unknown branch');
    if (objectCount !== new Set(newObjectIds).size) throw new BadRequestException('Unknown object');
    if (!manager) throw new BadRequestException('Unknown manager');
    assertCanManageUserAccess(ctx, branchIds, roles);
  }
}
