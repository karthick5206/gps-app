import { REPORT_TYPES, ReportFormat, ReportOptions, ReportPeriod, ReportRequest, ReportScope, ReportType } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

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

export class ReportExportDto extends ReportRequestDto {
  @IsIn(['XLSX', 'PDF', 'CSV']) format!: ReportFormat;
}

export function normalizeScope(scope: Partial<ReportScope> | null | undefined): ReportScope {
  return { branchIds: scope?.branchIds ?? [], groupIds: scope?.groupIds ?? [], objectIds: scope?.objectIds ?? [] };
}
