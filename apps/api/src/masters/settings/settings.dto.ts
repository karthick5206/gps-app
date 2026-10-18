import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, IsTimeZone, Length, Max, Min, ValidateNested } from 'class-validator';

export class ThresholdsDto {
  @IsOptional() @IsNumber() @Min(1) @Max(50) runningSpeedKph?: number;
  @IsOptional() @IsInt() @Min(10) @Max(3600) idleAfterSec?: number;
  @IsOptional() @IsInt() @Min(60) @Max(86_400) offlineAfterSec?: number;
  @IsOptional() @IsInt() @Min(0) @Max(500) driftRadiusM?: number;
}

export class UpdateSettingsDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsTimeZone() timezone?: string;
  @IsOptional() @ValidateNested() @Type(() => ThresholdsDto) thresholds?: ThresholdsDto;
}
