import { PartialType } from '@nestjs/mapped-types';
import { REPORT_TYPES, ReportFormat, ReportPeriod, ReportType, SINGLE_OBJECT_REPORT_TYPES } from '@veetracer/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../common/list-query';
import { ReportScopeDto } from '../reports/reports.dto';

/** Raw single-vehicle reports (Positions) can't be scheduled for a whole scope. */
const SCHEDULABLE_TYPES = REPORT_TYPES.filter((t) => !SINGLE_OBJECT_REPORT_TYPES.includes(t));

export class ReportScheduleListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() ownerId?: string;
  @IsOptional() @IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
}

export class CreateReportScheduleDto {
  @IsString() @Length(1, 100) name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(SCHEDULABLE_TYPES.length) @IsIn(SCHEDULABLE_TYPES, { each: true, message: 'Report type can not be scheduled' }) reportTypes!: ReportType[];
  @IsOptional() @ValidateNested() @Type(() => ReportScopeDto) scope?: ReportScopeDto;
  @IsOptional() @IsIn(['DAY', 'WEEK', 'MONTH']) period?: ReportPeriod;
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency!: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  @IsOptional() @IsInt() @Min(1) @Max(7) dayOfWeek?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(28) dayOfMonth?: number | null;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'timeOfDay must be HH:mm' }) timeOfDay!: string;
  @IsOptional() @IsIn(['XLSX', 'PDF', 'CSV']) format?: ReportFormat;
  @IsArray() @ArrayMinSize(1, { message: 'At least one recipient is required' }) @ArrayMaxSize(50)
  @IsEmail({}, { each: true, message: 'Invalid e-mail address in recipients' })
  recipients!: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateReportScheduleDto extends PartialType(CreateReportScheduleDto) {}

export class ReportRunsQuery {
  @IsOptional() @IsUUID() scheduleId?: string;
}
