import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import {
  DRIVER_LIMITS as L,
  type DriverDutyEndInput,
  type DriverDutyStartInput,
  type DriverStartTripInput,
  type DriverTripEventBatchInput,
  type DriverTripEventInput,
  type DriverTripListQuery,
  type DriverTripEventType,
  type MeBookingCancelInput,
  type TransportNotificationKind,
  type TransportNotificationListQuery,
  type TransportNotificationPreferences,
  type TransportNotificationReadInput,
} from '@veetracer/shared';

export class DriverDutyStartDto implements DriverDutyStartInput {
  @IsUUID() clientEventId!: string;
  @IsISO8601() occurredAt!: string;
  @IsOptional() @IsUUID() objectId?: string | null;
}

export class DriverDutyEndDto implements DriverDutyEndInput {
  @IsUUID() clientEventId!: string;
  @IsISO8601() occurredAt!: string;
}

export class DriverTripListDto implements DriverTripListQuery {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class DriverStartTripDto implements DriverStartTripInput {
  @IsUUID() clientEventId!: string;
  @IsISO8601() occurredAt!: string;
}

/**
 * One queued event. `type` is a free string on purpose: an unknown type (or START_TRIP, which is online-only) is a
 * per-event REJECTED outcome, not a 400 for the whole batch, so the rest of the driver's queue still drains.
 */
export class DriverTripEventDto implements Omit<DriverTripEventInput, 'type'> {
  @IsUUID() clientEventId!: string;
  @IsInt() @Min(0) @Max(1_000_000_000) seq!: number;
  @IsString() @MaxLength(30) type!: DriverTripEventType;
  @IsISO8601() occurredAt!: string;
  @IsOptional() @IsNumber() @Min(-86_400_000) @Max(86_400_000) clockOffsetMs?: number;
  @IsOptional() @IsInt() @Min(0) stopSeq?: number;
  @IsOptional() @IsUUID() passengerTripId?: string;
  /** Checked per event against the type's closed list (driverReasonAllowed): REJECTED VALIDATION_FAILED, not a 400. */
  @IsOptional() @IsString() @MaxLength(L.reasonCodeMax) reasonCode?: string;
  @IsOptional() @IsInt() @Min(0) @Max(L.etaMaxMin) etaMin?: number;
  @IsOptional() @IsString() @MaxLength(L.noteMax) note?: string;
}

export class DriverTripEventBatchDto implements DriverTripEventBatchInput {
  /** L6: a clientEventId appears at most once per batch (400 otherwise; the unique index would abort the whole batch). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(L.maxBatch)
  @ArrayUnique((e: DriverTripEventDto) => e?.clientEventId, { message: 'events: each clientEventId may appear only once per batch' })
  @ValidateNested({ each: true })
  @Type(() => DriverTripEventDto)
  events!: DriverTripEventDto[];
}

export class DriverSyncQuery {
  @IsOptional() @IsISO8601() since?: string;
}

export class MeBookingCancelDto implements MeBookingCancelInput {
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class NotificationListDto implements TransportNotificationListQuery {
  @IsOptional() @IsISO8601() before?: string;
  @IsOptional() @IsIn(['true', 'false']) unread?: 'true' | 'false';
}

export class NotificationReadDto implements TransportNotificationReadInput {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids?: string[];
  @IsOptional() @IsBoolean() all?: boolean;
}

export class NotificationPreferencesDto implements TransportNotificationPreferences {
  @IsBoolean() push!: boolean;
  /** Validated in the service against TRANSPORT_NOTIFICATION_KINDS (booleans only). */
  @IsOptional() kinds!: Partial<Record<TransportNotificationKind, boolean>>;
}
