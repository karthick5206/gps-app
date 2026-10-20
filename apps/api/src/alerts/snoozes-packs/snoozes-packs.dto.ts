import { PartialType } from '@nestjs/mapped-types';
import { ALERT_LEVELS, ALERT_TYPE_CODES, AlertLevel, AlertTypeCode } from '@veetracer/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class SnoozeQuery {
  @IsOptional() @IsIn(ALERT_LEVELS) level?: AlertLevel;
  @IsOptional() @IsUUID() targetId?: string;
  /** true = include expired snoozes (last 30 days). */
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeExpired?: boolean;
}

export class CreateSnoozeDto {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsUUID() targetId!: string;
  /** Empty = all non-mandatory alert types. */
  @IsArray() @ArrayMaxSize(20) @IsIn(ALERT_TYPE_CODES, { each: true }) alertTypes!: AlertTypeCode[];
  @IsDateString() until!: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string | null;
}

export class CreatePackDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  /** AlertSettingDto-like objects without id/level/target: {alertType, enabled, params, schedule, cooldownMin, severity, channels, requireAck}. */
  @IsArray() @ArrayMaxSize(50) settings!: Record<string, unknown>[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdatePackDto extends PartialType(CreatePackDto) {}

export class ApplyPackDto {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @IsUUID('all', { each: true }) targetIds!: string[];
}
