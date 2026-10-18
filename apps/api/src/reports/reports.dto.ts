import { REPORT_TYPES, ReportFormat, ReportPeriod, ReportRequest, ReportScope, ReportType } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID, Matches, ValidateNested } from 'class-validator';

export class ReportScopeDto implements ReportScope {
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) branchIds: string[] = [];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) groupIds: string[] = [];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) objectIds: string[] = [];
}

export class ReportRequestDto implements ReportRequest {
  @IsIn(REPORT_TYPES) type!: ReportType;
  @IsOptional() @ValidateNested() @Type(() => ReportScopeDto) scope: ReportScopeDto = new ReportScopeDto();
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to!: string;
  @IsOptional() @IsIn(['DAY', 'WEEK', 'MONTH']) period?: ReportPeriod;
}

export class ReportExportDto extends ReportRequestDto {
  @IsIn(['XLSX', 'PDF', 'CSV']) format!: ReportFormat;
}

export function normalizeScope(scope: Partial<ReportScope> | null | undefined): ReportScope {
  return { branchIds: scope?.branchIds ?? [], groupIds: scope?.groupIds ?? [], objectIds: scope?.objectIds ?? [] };
}
