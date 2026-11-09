import { PartialType } from '@nestjs/mapped-types';
import { SIM_OWNERSHIPS, SIM_PROVIDER_KINDS, SIM_STATUSES, SimOwnership, SimProviderKind, SimStatus } from '@veetracer/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ListQueryDto } from '../common/list-query';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ───────────── Providers & plans ─────────────

export class ProviderListQuery extends ListQueryDto {}

export class CreateProviderDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsIn(SIM_PROVIDER_KINDS) kind?: SimProviderKind;
  @IsOptional() @IsObject() supportContact?: Record<string, string>;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateProviderDto extends PartialType(CreateProviderDto) {}

export class PlanListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() providerId?: string;
}

export class CreatePlanDto {
  @IsUUID() providerId!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) dataMbPerMonth?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) smsPerMonth?: number | null;
  @IsInt() @Min(1) @Max(3650) validityDays!: number;
  @IsInt() @Min(0) @Max(100_000_000) costPaise!: number;
  /** QI-3 open: null = SIM not billed to customers. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) pricePaise?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdatePlanDto extends PartialType(CreatePlanDto) {}

// ───────────── SIM cards ─────────────

export class SimListQuery extends ListQueryDto {
  @IsOptional() @IsIn(SIM_STATUSES) simStatus?: SimStatus;
  @IsOptional() @IsUUID() providerId?: string;
  @IsOptional() @IsUUID() planId?: string;
  @IsOptional() @IsIn(['true', 'false']) assigned?: 'true' | 'false';
  /** Renewal due within N days (overdue included). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) renewalWithin?: number;
  @IsOptional() @IsIn(['true']) reconcile?: 'true';
}

export class CreateSimDto {
  @Transform(trim) @IsString() @MaxLength(30) iccid!: string;
  @IsOptional() @IsString() @MaxLength(20) msisdn?: string | null;
  @IsOptional() @Matches(/^\d{6,15}$/, { message: 'imsi must be 6-15 digits' }) imsi?: string | null;
  @IsUUID() providerId!: string;
  @IsOptional() @IsUUID() planId?: string | null;
  @IsOptional() @IsIn(SIM_OWNERSHIPS) ownership?: SimOwnership;
  @IsOptional() @IsUUID() locationId?: string | null;
  @IsOptional() @Matches(DATE_ONLY, { message: 'renewalDueAt must be YYYY-MM-DD' }) renewalDueAt?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}

/** Editable descriptive fields (status, assignment and renewal have their own actions). */
export class UpdateSimDto {
  @IsOptional() @IsString() @MaxLength(20) msisdn?: string | null;
  @IsOptional() @Matches(/^\d{6,15}$/, { message: 'imsi must be 6-15 digits' }) imsi?: string | null;
  @IsOptional() @IsUUID() planId?: string | null;
  @IsOptional() @IsIn(SIM_OWNERSHIPS) ownership?: SimOwnership;
  @IsOptional() @IsUUID() locationId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}

export class SimStatusDto {
  @IsIn(SIM_STATUSES) status!: SimStatus;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SimAssignDto {
  /** Device to fit the SIM to; a SIM already in another device is moved (transfer). */
  @IsUUID() deviceId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SimUnassignDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SimRenewDto {
  @Matches(DATE_ONLY, { message: 'renewalDueAt must be YYYY-MM-DD' }) renewalDueAt!: string;
  @IsOptional() @IsUUID() planId?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SimUsageDto {
  @Matches(DATE_ONLY, { message: 'periodStart must be YYYY-MM-DD' }) periodStart!: string;
  @Matches(DATE_ONLY, { message: 'periodEnd must be YYYY-MM-DD' }) periodEnd!: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) dataMb?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) smsCount?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) costPaise?: number | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}

export class SimEventListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() simId?: string;
}

export class SimImportDto {
  @IsString() @MinLength(1) @MaxLength(200_000) csv!: string;
  /** Used for rows without a provider column. */
  @IsOptional() @IsUUID() providerId?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class RenewalQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) withinDays?: number;
}
