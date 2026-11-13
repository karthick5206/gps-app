import { ForbiddenException, Injectable } from '@nestjs/common';
import { MAX_RIDE_BOUNDS_S, transportSettingsOf, type TransportSettingsDto } from '@veetracer/shared';
import { IsBoolean, IsInt, IsOptional, Matches, Max, Min, ValidateIf } from 'class-validator';
import { TRANSPORT_DESK_PHONE_RE } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { setCompanySetting } from '../../common/company-settings';
import { PrismaService } from '../../prisma/prisma.service';

export class UpdateTransportSettingsDto {
  @IsOptional() @IsBoolean() directoryListed?: boolean;
  /** E5: transport desk phone shown to drivers and passengers; null clears it. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(TRANSPORT_DESK_PHONE_RE, { message: 'deskPhone must be a phone number (digits, spaces, + ( ) -)' }) deskPhone?: string | null;
  /** Owner decision 1: company maximum ride time per passenger (seconds, 15 min – 4 h); null clears it (no limit). */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(MAX_RIDE_BOUNDS_S.min) @Max(MAX_RIDE_BOUNDS_S.max) maxRideS?: number | null;
  /** E5 WP 5.3: passenger self-service (book, commute, places, confirm, report). Default off. */
  @IsOptional() @IsBoolean() selfBooking?: boolean;
  /** WP 3.9 wave 2 (D-A5): passenger bookings wait for approval. Default ON (stored only when switched off). */
  @IsOptional() @IsBoolean() selfBookingApproval?: boolean;
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
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
    const before = transportSettingsOf(company.settings);
    // Keep `etms` keys this form does not manage (e.g. a hand-set `bookingCutoffMin`); only the DTO keys are rewritten.
    const rawEtms = (company.settings as Record<string, unknown> | null)?.[ETMS_SETTINGS_KEY];
    const unmanaged: Record<string, unknown> = rawEtms && typeof rawEtms === 'object' && !Array.isArray(rawEtms) ? { ...(rawEtms as Record<string, unknown>) } : {};
    for (const k of ['directoryListed', 'deskPhone', 'selfBooking', 'selfBookingApproval', 'maxRideS']) delete unmanaged[k];
    const after: TransportSettingsDto = { ...before, ...(dto.directoryListed !== undefined ? { directoryListed: dto.directoryListed } : {}) };
    if (dto.deskPhone !== undefined) {
      if (dto.deskPhone === null || !dto.deskPhone.trim()) delete after.deskPhone;
      else after.deskPhone = dto.deskPhone.trim();
    }
    if (dto.selfBooking !== undefined) {
      if (dto.selfBooking) after.selfBooking = true;
      else delete after.selfBooking;
    }
    if (dto.selfBookingApproval !== undefined) {
      // Default ON: only the switched-off state is stored (absent = approval required).
      if (dto.selfBookingApproval) delete after.selfBookingApproval;
      else after.selfBookingApproval = false;
    }
    if (dto.maxRideS !== undefined) {
      if (dto.maxRideS === null) delete after.maxRideS;
      else after.maxRideS = dto.maxRideS;
    }
    await this.prisma.$transaction(async (tx) => {
      // F9: only the `etms` key is written (atomic jsonb_set).
      await setCompanySetting(tx, ctx.companyId, ETMS_SETTINGS_KEY, { ...unmanaged, ...after });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'etms_settings', entityId: ctx.companyId, before: { ...before }, after: { ...after } }, tx);
    });
    return after;
  }
}
