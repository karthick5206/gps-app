import { REPORT_TYPES, ReportFormat, ReportOptions, ReportPeriod, ReportRequest, ReportScope, ReportType, ROW_KEY_LENGTH, VIEW_MAX_ROWS } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ReportScopeDto implements ReportScope {
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) branchIds: string[] = [];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) groupIds: string[] = [];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) objectIds: string[] = [];
}

export class ReportOptionsDto implements ReportOptions {
  @IsOptional() @IsInt() @Min(1) @Max(10_080) minDurationMin?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(40, { each: true }) alertTypes?: string[];
  @IsOptional() @IsInt() @Min(30) @Max(1440) drivingMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(240) breakMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3600) minOverspeedSec?: number;
  @IsOptional() @IsInt() @Min(5) @Max(43_200) inactiveAfterMin?: number;
}

export class ReportRequestDto implements ReportRequest {
  @IsIn(REPORT_TYPES) type!: ReportType;
  @IsOptional() @ValidateNested() @Type(() => ReportScopeDto) scope: ReportScopeDto = new ReportScopeDto();
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to!: string;
  @IsOptional() @IsIn(['DAY', 'WEEK', 'MONTH']) period?: ReportPeriod;
  @IsOptional() @ValidateNested() @Type(() => ReportOptionsDto) options?: ReportOptionsDto;
}

/** "Export filtered view": the rows the page shows (in its order), its hidden columns and a label for the filter. */
export class ReportViewDto {
  /** Row keys (reportRowKey, 8 characters each) concatenated in the page's order. */
  @IsString() @MaxLength(VIEW_MAX_ROWS * ROW_KEY_LENGTH) @Matches(/^[0-9a-z]*$/, { message: 'view.rows must be row keys' }) rows!: string;
  /** Headers (English) of columns hidden on the page; matching file columns are left out. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(80, { each: true }) hiddenColumns?: string[];
  /** What the page filtered by, e.g. "Vehicle: Bus 07 · “depot”" (shown as text in the file). */
  @IsOptional() @IsString() @MaxLength(200) label?: string;
}

export class ReportExportDto extends ReportRequestDto {
  @IsIn(['XLSX', 'PDF', 'CSV']) format!: ReportFormat;
  /** PDF cover page / XLSX Summary sheet with filters, key figures and charts (ignored for CSV). */
  @IsOptional() @IsBoolean() summary?: boolean;
  @IsOptional() @ValidateNested() @Type(() => ReportViewDto) view?: ReportViewDto;
}

export function normalizeScope(scope: Partial<ReportScope> | null | undefined): ReportScope {
  return { branchIds: scope?.branchIds ?? [], groupIds: scope?.groupIds ?? [], objectIds: scope?.objectIds ?? [] };
}
