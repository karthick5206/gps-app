import { Controller, Get, Query } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuditLogDto } from '@veetracer/shared';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { AuditService } from '../../audit/audit.service';
import { CsvSpec, ListQueryDto, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';

class AuditLogListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(50) entity?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsEnum(AuditAction) action?: AuditAction;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

const LIST: ListSpec = {
  search: ['entity', 'entityId'],
  sort: { createdAt: 'createdAt', action: 'action', entity: 'entity' },
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
  status: null,
};

const CSV: CsvSpec<AuditLogDto> = {
  name: 'audit-log',
  columns: [
    { header: 'Time', value: (a) => a.createdAt },
    { header: 'User', value: (a) => a.userName },
    { header: 'Action', value: (a) => a.action },
    { header: 'Entity', value: (a) => a.entity },
    { header: 'Entity ID', value: (a) => a.entityId },
    { header: 'Changes', value: (a) => (a.changes ? JSON.stringify(a.changes) : '') },
    { header: 'IP', value: (a) => a.ip },
  ],
};

/** Read-only audit trail of the caller's (effective) company. */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get() @RequirePermission('audit_log', 'view')
  async list(@Auth() ctx: AuthContext, @Query() query: AuditLogListQuery) {
    const plan = planList<Prisma.AuditLogWhereInput, Prisma.AuditLogOrderByWithRelationInput>(query, LIST);
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(query.from);
    if (query.to) createdAt.lte = new Date(query.to);
    const where: Prisma.AuditLogWhereInput = {
      AND: [
        { companyId: ctx.companyId },
        plan.where,
        query.entity ? { entity: query.entity } : {},
        query.userId ? { userId: query.userId } : {},
        query.action ? { action: query.action } : {},
        query.from || query.to ? { createdAt } : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.auditLog.count({ where }),
    ]);
    return listResult(plan, await this.audit.toDtos(rows), total, CSV);
  }
}
