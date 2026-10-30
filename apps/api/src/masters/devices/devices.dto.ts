import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, IsISO8601 } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export const UNIQUE_ID_PATTERN = /^[0-9A-Za-z_-]{4,32}$/;

export class DeviceListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() modelId?: string;
  @IsOptional() @IsIn(['true', 'false']) assigned?: 'true' | 'false';
}

export class CreateDeviceDto {
  @Matches(UNIQUE_ID_PATTERN, { message: 'uniqueId must be 4-32 letters, digits, "-" or "_"' }) uniqueId!: string;
  @IsUUID() modelId!: string;
  @IsOptional() @IsString() @MaxLength(20) simNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(40) simOperator?: string | null;
  @IsOptional() @IsString() @MaxLength(40) firmware?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDeviceDto extends PartialType(CreateDeviceDto) {}

/** Devices → Set odometer: the reading to show from now on (0 = reset), with an optional reason. */
export class SetOdometerDto {
  @IsNumber() @Min(0) @Max(10_000_000) valueKm!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  /** When the reading was taken (ISO); km driven since then are added. Default: now. At most 30 days back. */
  @IsOptional() @IsISO8601() readingAt?: string;
}

export class RawQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
