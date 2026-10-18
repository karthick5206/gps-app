import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
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
import { ListQueryDto } from '../../common/list-query';

export const GEOFENCE_MODES = ['NORMAL', 'NO_GO', 'KEEP_IN'] as const;

export class GeofenceListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(50) category?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(GEOFENCE_MODES) mode?: (typeof GEOFENCE_MODES)[number];
  @IsOptional() @IsIn(['CIRCLE', 'POLYGON', 'RECTANGLE']) type?: string;
}

export class AppliesToDto {
  @IsBoolean() all!: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) branchIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) groupIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) objectIds?: string[];
}

export class CreateGeofenceDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @Length(1, 50) category?: string;
  /** {type:'CIRCLE', center:{lat,lng}, radiusM} | {type:'POLYGON'|'RECTANGLE', points:[{lat,lng}]} — validated in the service. */
  @IsObject() geometry!: Record<string, unknown>;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Colour must be #RRGGBB' }) color?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsIn(GEOFENCE_MODES) mode?: (typeof GEOFENCE_MODES)[number];
  @IsOptional() @IsBoolean() notifyEnter?: boolean;
  @IsOptional() @IsBoolean() notifyExit?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(43_200) maxStayMin?: number | null;
  @IsOptional() @IsInt() @Min(5) @Max(250) speedLimitKph?: number | null;
  /** TimeWindow[]; empty = always active. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) timeWindows?: unknown[];
  @IsOptional() @ValidateNested() @Type(() => AppliesToDto) appliesTo?: AppliesToDto;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateGeofenceDto extends PartialType(CreateGeofenceDto) {}

export class ImportGeofencesDto {
  /** File content (GeoJSON FeatureCollection or CSV `name,lat,lng,radiusM`) when not uploading multipart `file`. */
  @IsOptional() @IsString() @MaxLength(5_000_000) content?: string;
  @IsOptional() @IsIn(['geojson', 'csv']) format?: 'geojson' | 'csv';
  @IsOptional() @IsString() @Length(1, 50) category?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string;
}

export class VisitsQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() objectId?: string;
}
