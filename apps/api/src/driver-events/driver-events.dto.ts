import { DRIVER_EVENT_LIMITS, DRIVER_EVENT_STATUSES, DriverEventReviewRequest, DriverEventSettings, DriverEventStatus } from '@veetracer/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const list = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);

export class DriverEventQuery {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  /** Comma-separated alert types. */
  @IsOptional() @Transform(list) @IsString({ each: true }) type?: string[];
  @IsOptional() @Transform(list) @IsIn(DRIVER_EVENT_STATUSES, { each: true }) status?: DriverEventStatus[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) minLevel?: number;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)) @IsBoolean() hasPhoto?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsIn(['CSV', 'XLSX']) format?: 'CSV' | 'XLSX';
}

export class ReviewDriverEventDto implements DriverEventReviewRequest {
  @IsIn(DRIVER_EVENT_STATUSES) status!: DriverEventStatus;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
}

const L = DRIVER_EVENT_LIMITS;
export class DriverEventSettingsDto implements Partial<DriverEventSettings> {
  @IsOptional() @IsBoolean() snapshot?: boolean;
  @IsOptional() @IsInt() @Min(L.channel[0]) @Max(L.channel[1]) cabinChannel?: number;
  @IsOptional() @IsInt() @Min(L.channel[0]) @Max(L.channel[1]) roadChannel?: number;
  @IsOptional() @IsInt() @Min(L.maxPhotos[0]) @Max(L.maxPhotos[1]) maxPhotos?: number;
  @IsOptional() @IsInt() @Min(L.retentionDays[0]) @Max(L.retentionDays[1]) retentionDays?: number;
  @IsOptional() @IsInt() @Min(L.quotaMb[0]) @Max(L.quotaMb[1]) quotaMb?: number;
}

export class MediaTokenQuery {
  @IsString() @MaxLength(600) token!: string;
}
