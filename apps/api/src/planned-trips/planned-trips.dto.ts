import { PLANNED_TRIP_STATUSES, PlannedTripStatus } from '@veetracer/shared';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { ListQueryDto } from '../common/list-query';

export class PlannedTripListQuery extends ListQueryDto {
  /** Planned start ≥ from (ISO instant). */
  @IsOptional() @IsDateString() from?: string;
  /** Planned start < to (ISO instant). */
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() routeId?: string;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  /** One or more statuses, comma-separated (`status` is the common ACTIVE / INACTIVE filter). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @ArrayMaxSize(PLANNED_TRIP_STATUSES.length)
  @IsIn(PLANNED_TRIP_STATUSES, { each: true })
  tripStatus?: PlannedTripStatus[];
}

export class CreatePlannedTripDto {
  @IsUUID() routeId!: string;
  @IsUUID() objectId!: string;
  @IsOptional() @IsUUID() driverId?: string | null;
  @IsDateString() plannedStart!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}

export class UpdatePlannedTripDto {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsUUID() driverId?: string | null;
  @IsOptional() @IsDateString() plannedStart?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}

export class CancelPlannedTripDto {
  @IsString() @Length(1, 300) reason!: string;
}

export class ManualTripActionDto {
  /** Optional note kept in the audit trail. */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
