import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { HISTORY_IMPORT_CHUNK, HISTORY_IMPORT_MAX_POINTS, type HistoryImportRow } from '@veetracer/shared';

const LOCAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export class HistoryImportPreviewDto {
  @IsOptional() @IsUUID() objectId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) deviceName?: string | null;
}

export class HistoryImportStartDto {
  @IsUUID() objectId!: string;
  @IsString() @MaxLength(200) fileName!: string;
  @Matches(LOCAL) firstLocal!: string;
  @Matches(LOCAL) lastLocal!: string;
  @IsInt() @Min(1) points!: number;
  @IsOptional() @IsNumber() oldKm?: number | null;
  @IsOptional() @IsNumber() @Min(0) odometerKm?: number | null;
}

/** Compact rows: [local time, lat, lng, speed km/h, ignition 1/0/null]; each row is checked again in the service. */
export class HistoryImportPointsDto {
  @IsArray() @ArrayMaxSize(HISTORY_IMPORT_CHUNK) rows!: HistoryImportRow[];
}

export const MAX_POINTS = HISTORY_IMPORT_MAX_POINTS;
