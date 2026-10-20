import { ALERT_SEVERITIES, ALERT_TYPE_CODES, AlertSeverity, AlertStatus, AlertTypeCode } from '@veetracer/shared';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const toBool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export class AlertListQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(ALERT_TYPE_CODES) type?: AlertTypeCode;
  @IsOptional() @IsIn(ALERT_SEVERITIES) severity?: AlertSeverity;
  @IsOptional() @IsIn(['NEW', 'ACKNOWLEDGED', 'RESOLVED']) status?: AlertStatus;
  /** Read by the caller (`read=true|false`). */
  @IsOptional() @Transform(toBool) @IsBoolean() read?: boolean;
  /** `pendingAck=true`: still NEW and needs acknowledgement (`ackRequired`). */
  @IsOptional() @Transform(toBool) @IsBoolean() pendingAck?: boolean;
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

export class ReadAllDto {
  /** Omitted = every alert up to now (the caller's watermark). */
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) ids?: string[];
}
