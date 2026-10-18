import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CompanySummary } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { toCompanySummary } from '../../common/company-summary';
import { asRecord } from '../../common/dto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { companyThresholds } from '../../tracking/thresholds';
import { UpdateSettingsDto } from './settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async get(ctx: AuthContext): Promise<{ company: CompanySummary }> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
    return { company: toCompanySummary(company) };
  }

  async update(ctx: AuthContext, dto: UpdateSettingsDto): Promise<{ company: CompanySummary }> {
    const before = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
    const settings = asRecord(before.settings);
    const thresholds = dto.thresholds ? { ...companyThresholds(settings), ...dto.thresholds } : undefined;
    const company = await this.prisma.company.update({
      where: { id: ctx.companyId },
      data: {
        name: dto.name?.trim(),
        timezone: dto.timezone,
        settings: thresholds ? ({ ...settings, thresholds } as Prisma.InputJsonValue) : undefined,
      },
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'company', entityId: company.id, before, after: company });
    if (thresholds) await this.redis.invalidateCache('thresholds');
    return { company: toCompanySummary(company) };
  }
}
