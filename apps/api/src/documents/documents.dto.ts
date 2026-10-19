import { PartialType } from '@nestjs/mapped-types';
import { DOCUMENT_STATUSES, DocumentStatus, SERVICE_STATUSES, ServiceStatus } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ListQueryDto } from '../common/list-query';

export class DocumentListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsIn(['VEHICLE', 'DRIVER']) owner?: 'VEHICLE' | 'DRIVER';
  @IsOptional() @Matches(/^[A-Z0-9_]{1,40}$/) type?: string;
  /** Expiry status (the common `status` is the active flag, which documents don't have). */
  @IsOptional() @IsIn(DOCUMENT_STATUSES) expiry?: DocumentStatus;
}

export class CreateDocumentDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() objectId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() driverId?: string | null;
  @Matches(/^[A-Z0-9_]{1,40}$/, { message: 'type must be a DOCUMENT_TYPE lookup code' }) type!: string;
  @IsOptional() @IsString() @MaxLength(60) number?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() issuedOn?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() expiresOn?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) reminderDays?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}

export class UpdateDocumentDto extends PartialType(CreateDocumentDto) {}

export class ServiceReminderListQuery {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsIn(SERVICE_STATUSES) due?: ServiceStatus;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}

export class CreateServiceReminderDto {
  @IsUUID() objectId!: string;
  @IsString() @Length(1, 80) title!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000) intervalKm?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(3650) intervalDays?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() lastDoneAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(10_000_000) lastDoneOdometerKm?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) notifyBeforeKm?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) notifyBeforeDays?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateServiceReminderDto extends PartialType(CreateServiceReminderDto) {}

export class ServiceDoneDto {
  @IsOptional() @IsDateString() doneAt?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(10_000_000) odometerKm?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(100_000_000) cost?: number | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsBoolean() endMaintenance?: boolean;
}

export class ServiceRecordQuery {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() reminderId?: string;
}
