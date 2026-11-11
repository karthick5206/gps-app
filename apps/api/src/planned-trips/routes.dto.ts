import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ROUTE_LIMITS } from '@veetracer/shared';
import { ListQueryDto } from '../common/list-query';

export class RouteListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
}

/** Ranges and ordering are checked again (with readable messages) by normaliseStops. */
export class RouteStopBody {
  @IsString() @Length(1, 100) name!: string;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsInt() radiusM?: number;
  @IsOptional() @IsInt() offsetMin?: number;
  @IsOptional() @IsInt() waitMin?: number;
  @IsOptional() @IsUUID() geofenceId?: string | null;
}

export class CreateRouteDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(50) code?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsInt() corridorM?: number;
  @IsArray() @ArrayMinSize(ROUTE_LIMITS.minStops) @ArrayMaxSize(ROUTE_LIMITS.maxStops) @ValidateNested({ each: true }) @Type(() => RouteStopBody)
  stops!: RouteStopBody[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateRouteDto extends PartialType(CreateRouteDto) {}

export class LatLngBody {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
}

export class PreviewPathDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(ROUTE_LIMITS.maxStops) @ValidateNested({ each: true }) @Type(() => LatLngBody)
  points!: LatLngBody[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateScheduleDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @IsInt() @Min(0) @Max(1439) startMin!: number;
  @IsOptional() @IsUUID() objectId?: string | null;
  @IsOptional() @IsUUID() driverId?: string | null;
  @IsOptional() @Matches(DAY, { message: 'validFrom must be YYYY-MM-DD' }) validFrom?: string | null;
  @IsOptional() @Matches(DAY, { message: 'validTo must be YYYY-MM-DD' }) validTo?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateScheduleDto extends PartialType(CreateScheduleDto) {}
