import { FUEL_SOURCES, FuelSource } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';

export class CalibrationPointDto {
  @IsNumber() @Min(-1_000_000) @Max(1_000_000) raw!: number;
  @IsNumber() @Min(0) @Max(100_000) litres!: number;
}

export class FuelConfigBody {
  @IsIn(FUEL_SOURCES) source!: FuelSource;
  @IsOptional() @IsNumber() @Min(1) @Max(100_000) tankCapacityL?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CalibrationPointDto) calibration?: CalibrationPointDto[];
  @IsOptional() @IsNumber() @Min(1) @Max(10_000) refillMinL?: number | null;
  @IsOptional() @IsNumber() @Min(1) @Max(10_000) drainMinL?: number;
  @IsOptional() @IsInt() @Min(1) @Max(240) drainWindowMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(15) smoothingWindow?: number;
}

export class FuelEventsQuery {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsIn(['REFILL', 'DRAIN']) type?: 'REFILL' | 'DRAIN';
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
