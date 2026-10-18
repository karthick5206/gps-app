import { ALERT_SEVERITIES, ALERT_TYPE_CODES, AlertSeverity, AlertStatus, AlertTypeCode } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class AlertListQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(ALERT_TYPE_CODES) type?: AlertTypeCode;
  @IsOptional() @IsIn(ALERT_SEVERITIES) severity?: AlertSeverity;
  @IsOptional() @IsIn(['NEW', 'ACKNOWLEDGED', 'RESOLVED']) status?: AlertStatus;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsIn(['occurredAt', 'severity', 'type', 'status']) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class AckDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class AckAllDto {
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) ids?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
