import {
  TRANSPORT_ADHOC_LIMITS,
  TRANSPORT_BOOKING_JOURNEYS,
  TRANSPORT_BOOKING_SOURCES,
  TRANSPORT_BOOKING_STATUSES,
  TRANSPORT_DIRECTIONS,
  TRANSPORT_E3_LIMITS as L,
  TRANSPORT_EXCEPTION_KINDS,
  TRANSPORT_PASSENGER_OUTCOMES,
  TRANSPORT_PICKUP_MODES,
  TRANSPORT_TRIP_DERIVED_STATES,
  type BulkApproveTransportBookingsInput,
  type CreateTransportBookingInput,
  type CreateTransportScheduleExceptionInput,
  type CreateTransportSchedulesInput,
  type CreateTransportShiftInput,
  type DispatchBoardQuery,
  type DispatchCandidatesInput,
  type DispatchChangeOp,
  type DispatchChangeSetInput,
  type MeTransportRangeQuery,
  type RepeatTransportTripInput,
  type TransportBookingCommandInput,
  type TransportBookingJourney,
  type TransportBookingSource,
  type TransportBookingStatus,
  type TransportDirection,
  type TransportExceptionKind,
  type TransportPassengerOutcome,
  type TransportPassengerOutcomeInput,
  type TransportPickupMode,
  type TransportScheduleOverride,
  type TransportTripArriveInput,
  type TransportTripCancelInput,
  type TransportTripCommandInput,
  type TransportTripDerivedState,
  type UpdateTransportBookingInput,
  type UpdateTransportScheduleInput,
  type UpdateTransportShiftInput,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MSG = { message: 'must be a date YYYY-MM-DD' };
const nullable = (_: object, v: unknown) => v !== null;

export class GeoPointDto {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsString() @MaxLength(L.nameMax) label?: string | null;
  @IsOptional() @IsUUID() poiId?: string | null;
}

// ───────────────────────────── Shifts ─────────────────────────────

export class ShiftListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() siteId?: string;
  declare sort?: 'name' | 'startMin' | 'createdAt';
}

export class CreateShiftDto implements CreateTransportShiftInput {
  @IsString() @IsNotEmpty() @MaxLength(L.nameMax) name!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() sitePoiId?: string | null;
  @IsInt() @Min(0) @Max(1439) startMin!: number;
  @IsInt() @Min(0) @Max(1439) endMin!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
}

export class UpdateShiftDto implements UpdateTransportShiftInput {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(L.nameMax) name?: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() sitePoiId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1439) startMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1439) endMin?: number;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days?: number[];
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ───────────────────────────── Schedules ─────────────────────────────

export class ScheduleListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @IsUUID() shiftId?: string;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  declare sort?: 'createdAt' | 'validFrom' | 'passenger';
}

export class CreateSchedulesDto implements CreateTransportSchedulesInput {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(L.maxBulk) @IsUUID('all', { each: true }) profileIds!: string[];
  @IsUUID() shiftId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2) @IsIn(TRANSPORT_DIRECTIONS, { each: true }) directions!: TransportDirection[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days?: number[];
  @IsIn(TRANSPORT_PICKUP_MODES) pickupMode!: TransportPickupMode;
  @IsOptional() @ValidateIf(nullable) @IsUUID() stopPoiId?: string | null;
  @Matches(DAY, DAY_MSG) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY, DAY_MSG) validTo?: string | null;
}

export class UpdateScheduleDto implements UpdateTransportScheduleInput {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsUUID() shiftId?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days?: number[];
  @IsOptional() @IsIn(TRANSPORT_PICKUP_MODES) pickupMode?: TransportPickupMode;
  @IsOptional() @ValidateIf(nullable) @IsUUID() stopPoiId?: string | null;
  @IsOptional() @Matches(DAY, DAY_MSG) validFrom?: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY, DAY_MSG) validTo?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ScheduleOverrideDto implements TransportScheduleOverride {
  @IsOptional() @IsInt() @Min(0) @Max(1439) timeMin?: number;
  @IsOptional() @ValidateNested() @Type(() => GeoPointDto) pickup?: GeoPointDto;
}

export class CreateExceptionDto implements CreateTransportScheduleExceptionInput {
  @Matches(DAY, DAY_MSG) date!: string;
  @IsIn(TRANSPORT_EXCEPTION_KINDS) kind!: TransportExceptionKind;
  @IsOptional() @ValidateNested() @Type(() => ScheduleOverrideDto) override?: ScheduleOverrideDto;
  @IsOptional() @IsString() @MaxLength(L.reasonMax) reason?: string;
}

export class SchedulePreviewQuery {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

// ───────────────────────────── Bookings ─────────────────────────────

export class BookingListQuery extends ListQueryDto {
  @IsOptional() @Matches(DAY, DAY_MSG) serviceDate?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) from?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) to?: string;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  @IsOptional() @IsUUID() shiftId?: string;
  @IsOptional() @IsUUID() siteId?: string;
  @IsOptional() @IsUUID() passengerId?: string;
  @IsOptional() @IsIn(TRANSPORT_BOOKING_STATUSES) bookingStatus?: TransportBookingStatus;
  @IsOptional() @IsIn(TRANSPORT_BOOKING_SOURCES) source?: TransportBookingSource;
  @IsOptional() @IsIn(['true', 'false']) unassigned?: 'true' | 'false';
  @IsOptional() @IsIn(TRANSPORT_BOOKING_JOURNEYS) journey?: TransportBookingJourney;
  @IsOptional() @IsIn(['true', 'false']) afterCutoff?: 'true' | 'false';
  @IsOptional() @IsUUID() groupId?: string;
  declare sort?: 'windowStart' | 'serviceDate' | 'createdAt' | 'status' | 'passenger';
}

export class CreateBookingDto implements CreateTransportBookingInput {
  @IsUUID() passengerId!: string;
  @Matches(DAY, DAY_MSG) serviceDate!: string;
  /** Required for COMMUTE (checked by the service); ignored for POINT_TO_POINT. */
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  @IsOptional() @IsIn(TRANSPORT_BOOKING_JOURNEYS) journey?: TransportBookingJourney;
  @IsOptional() @ValidateIf(nullable) @IsUUID() shiftId?: string | null;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => GeoPointDto) pickup?: GeoPointDto | null;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => GeoPointDto) drop?: GeoPointDto | null;
  @IsOptional() @IsISO8601() windowStart?: string;
  @IsOptional() @IsISO8601() windowEnd?: string;
  @IsOptional() @IsInt() @Min(1) @Max(L.maxPassengerCount) passengerCount?: number;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(L.noteMax) note?: string | null;
  @IsOptional() @IsBoolean() hold?: boolean;
  /** D-A1: trimmed length lateReasonMin..lateReasonMax is checked by the service (409 LATE_REASON_REQUIRED). */
  @IsOptional() @IsString() @MaxLength(1000) lateReason?: string;
}

/** D-A8 group pickup: COMMON (one point) or OWN (each passenger's routing pickup). */
export class GroupPickupDto {
  @IsIn(['COMMON', 'OWN']) mode!: 'COMMON' | 'OWN';
  @IsOptional() @ValidateNested() @Type(() => GeoPointDto) point?: GeoPointDto;
}

/** POST /transport/bookings/group (CreateTransportGroupBookingInput). */
export class CreateGroupBookingDto {
  @IsArray() @ArrayMinSize(TRANSPORT_ADHOC_LIMITS.groupMin) @ArrayMaxSize(TRANSPORT_ADHOC_LIMITS.groupMax) @IsUUID('all', { each: true }) passengerIds!: string[];
  @Matches(DAY, DAY_MSG) serviceDate!: string;
  @IsIn(TRANSPORT_BOOKING_JOURNEYS) journey!: TransportBookingJourney;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  @IsOptional() @ValidateIf(nullable) @IsUUID() shiftId?: string | null;
  @ValidateNested() @Type(() => GroupPickupDto) pickup!: GroupPickupDto;
  @ValidateNested() @Type(() => GeoPointDto) drop!: GeoPointDto;
  @IsOptional() @IsISO8601() windowStart?: string;
  @IsOptional() @IsISO8601() windowEnd?: string;
  @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.purposeMax) purpose!: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(L.noteMax) note?: string | null;
  @IsOptional() @IsBoolean() hold?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) lateReason?: string;
}

export class UpdateBookingDto implements UpdateTransportBookingInput {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => GeoPointDto) pickup?: GeoPointDto | null;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => GeoPointDto) drop?: GeoPointDto | null;
  @IsOptional() @IsISO8601() windowStart?: string;
  @IsOptional() @IsISO8601() windowEnd?: string;
  @IsOptional() @IsInt() @Min(1) @Max(L.maxPassengerCount) passengerCount?: number;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(L.noteMax) note?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) lateReason?: string;
}

export class BookingCommandDto implements TransportBookingCommandInput {
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
  @IsOptional() @IsString() @MaxLength(L.reasonMax) reason?: string;
}

export class BulkApproveDto implements BulkApproveTransportBookingsInput {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(L.maxBulk) @IsUUID('all', { each: true }) ids!: string[];
}

// ───────────────────────────── Dispatch ─────────────────────────────

export class BoardQuery implements DispatchBoardQuery {
  @Matches(DAY, DAY_MSG) serviceDate!: string;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  @IsOptional() @IsUUID() shiftId?: string;
  @IsOptional() @IsUUID() siteId?: string;
}

export class CandidatesDto implements DispatchCandidatesInput {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) bookingIds!: string[];
  @IsOptional() @IsISO8601() at?: string;
}

/** Ops are validated by parseChangeOps (a discriminated union class-validator cannot express). */
export class ChangeSetDto implements DispatchChangeSetInput {
  @Matches(DAY, DAY_MSG) serviceDate!: string;
  @IsIn(TRANSPORT_DIRECTIONS) direction!: TransportDirection;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(L.maxChanges) @IsObject({ each: true }) changes!: DispatchChangeOp[];
  @IsOptional() @IsObject() expectedVersions?: Record<string, number>;
  @IsOptional() @IsString() @MaxLength(L.reasonMax) reason?: string;
  @IsOptional() @IsBoolean() draft?: boolean;
}

export class ChangeSetListQuery {
  @IsOptional() @Matches(DAY, DAY_MSG) serviceDate?: string;
  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED', 'REJECTED']) status?: 'DRAFT' | 'PUBLISHED' | 'REJECTED';
}

// ───────────────────────────── Trips ─────────────────────────────

export class TripListQuery extends ListQueryDto {
  @IsOptional() @Matches(DAY, DAY_MSG) serviceDate?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) from?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) to?: string;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  @IsOptional() @IsIn(TRANSPORT_TRIP_DERIVED_STATES) derivedState?: TransportTripDerivedState;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsUUID() shiftId?: string;
  @IsOptional() @IsUUID() siteId?: string;
  declare sort?: 'plannedStart' | 'serviceDate' | 'createdAt';
}

export class TripCommandDto implements TransportTripCommandInput {
  @IsOptional() @IsUUID() clientEventId?: string;
  @IsOptional() @IsString() @MaxLength(L.reasonMax) note?: string;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class TripCancelDto extends TripCommandDto implements TransportTripCancelInput {
  @IsString() @IsNotEmpty() @MaxLength(L.reasonMax) reason!: string;
  @IsOptional() @IsBoolean() cancelBookings?: boolean;
}

export class TripArriveDto extends TripCommandDto implements TransportTripArriveInput {
  @IsInt() @Min(0) stopSeq!: number;
  @IsOptional() @IsISO8601() occurredAt?: string;
}

export class PassengerOutcomeDto implements TransportPassengerOutcomeInput {
  @IsIn(TRANSPORT_PASSENGER_OUTCOMES) outcome!: TransportPassengerOutcome;
  @IsOptional() @IsUUID() clientEventId?: string;
  @IsOptional() @IsString() @MaxLength(60) reasonCode?: string;
  @IsOptional() @IsISO8601() occurredAt?: string;
  @IsOptional() @IsString() @MaxLength(L.reasonMax) note?: string;
}

export class RepeatTripDto implements RepeatTransportTripInput {
  @Matches(DAY, DAY_MSG) toDate!: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days?: number[];
}

export class MeRangeQuery implements MeTransportRangeQuery {
  @IsOptional() @Matches(DAY, DAY_MSG) from?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) to?: string;
}

/** GET /api/transport/bookings/places?q= (WP 3.9). */
export class BookingPlacesQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}
