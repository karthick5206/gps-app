import { ForbiddenException, Injectable } from '@nestjs/common';
import { transportSettingsOf, type TransportSettingsDto } from '@veetracer/shared';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { setCompanySetting } from '../../common/company-settings';
import { PrismaService } from '../../prisma/prisma.service';

export class UpdateTransportSettingsDto {
  @IsOptional() @IsBoolean() directoryListed?: boolean;
}

/** Key of `Company.settings` that holds the ETMS company settings (TransportSettingsDto). */
export const ETMS_SETTINGS_KEY = 'etms';

/**
 * Company-level ETMS settings (menu `etms_settings`), stored in `Company.settings.etms` (F4). E1a: the partner-directory
 * opt-in, default off. Changing it needs whole-company scope (a company-wide choice) and is audited.
 */
@Injectable()
export class TransportSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(ctx: AuthContext): Promise<TransportSettingsDto> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
    return transportSettingsOf(company.settings);
  }

  async update(ctx: AuthContext, dto: UpdateTransportSettingsDto): Promise<TransportSettingsDto> {
    if (ctx.dataScope !== 'COMPANY') {
      throw new ForbiddenException({ message: 'Only users with whole-company access can change transport settings', code: 'SCOPE_REQUIRED' });
    }
    const before = await this.get(ctx);
    const after: TransportSettingsDto = { ...before, ...(dto.directoryListed !== undefined ? { directoryListed: dto.directoryListed } : {}) };
    await this.prisma.$transaction(async (tx) => {
      // F9: only the `etms` key is written (atomic jsonb_set).
      await setCompanySetting(tx, ctx.companyId, ETMS_SETTINGS_KEY, after);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'etms_settings', entityId: ctx.companyId, before: { ...before }, after: { ...after } }, tx);
    });
    return after;
  }
}
