import { PartialType } from '@nestjs/mapped-types';
import { POI_IMPORT_MAX_ITEMS, POI_MAX_RADIUS_M, POI_MIN_RADIUS_M } from '@veetracer/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
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
import { ListQueryDto } from '../common/list-query';

const COLOR = /^#[0-9a-fA-F]{6}$/;

export class PoiListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(50) category?: string;
  @IsOptional() @IsUUID() branchId?: string;
  /** Bounding box filter "minLat,minLng,maxLat,maxLng" (map viewport). */
  @IsOptional() @Matches(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/) bbox?: string;
}

export class CreatePoiDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @Length(1, 50) category?: string;
  @Type(() => Number) @IsLatitude() lat!: number;
  @Type(() => Number) @IsLongitude() lng!: number;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsInt() @Min(POI_MIN_RADIUS_M) @Max(POI_MAX_RADIUS_M) radiusM?: number;
  @IsOptional() @IsString() @MaxLength(40) icon?: string | null;
  @IsOptional() @Matches(COLOR, { message: 'Colour must be #RRGGBB' }) color?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdatePoiDto extends PartialType(CreatePoiDto) {}

/** One item to import, as returned by the preview (and possibly edited / unselected by the user). */
export class ImportItemDto {
  @IsInt() @Min(1) index!: number;
  @IsIn(['POI', 'GEOFENCE']) kind!: 'POI' | 'GEOFENCE';
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(50) category?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @Matches(COLOR) color?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsInt() radiusM?: number;
  /** Geofence geometry, validated by the geofences service. */
  @IsOptional() @IsObject() geometry?: Record<string, unknown>;
}

export class ImportCommitDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(POI_IMPORT_MAX_ITEMS) @ValidateNested({ each: true }) @Type(() => ImportItemDto) items!: ImportItemDto[];
  /** Used for items without a (known) category. */
  @IsOptional() @IsString() @Length(1, 50) category?: string;
  @IsOptional() @IsString() @Length(1, 50) geofenceCategory?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsInt() @Min(POI_MIN_RADIUS_M) @Max(POI_MAX_RADIUS_M) radiusM?: number;
}

export class ExportQuery {
  @IsOptional() @IsIn(['kml', 'geojson']) format?: 'kml' | 'geojson';
  /** What to include (default both). */
  @IsOptional() @IsIn(['all', 'pois', 'geofences']) include?: 'all' | 'pois' | 'geofences';
}
