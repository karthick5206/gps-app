import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import {
  BOOKING_HOLD_REASON_MAX,
  DISPATCH_REQUEST_STATUSES,
  DISPATCH_TRIGGERS,
  LIVE_DISPATCH_POLICIES,
  SHARING_POLICY_TEXT_MAX,
  VEHICLE_AVAILABILITY_KINDS,
  VEHICLE_AVAILABILITY_LIMITS,
  type DispatchRequestListQuery,
  type DispatchRequestStatus,
  type DispatchTrigger,
  type DriverHoursPolicy,
  type DriverRouteAckInput,
  type LiveDispatchDecideInput,
  type LiveDispatchPolicy,
  type PutVehicleAvailabilityInput,
  type RidePreference,
  type SharingLimits,
  type TransportBookingHoldInput,
  type UpdatePoolingSettingsInput,
  type UpdateTransportSharingPolicyInput,
  type VehicleAvailabilityKind,
} from '@veetracer/shared';

const nullable = (_o: unknown, v: unknown) => v !== null;

export class HoldDto implements TransportBookingHoldInput {
  @IsBoolean() hold!: boolean;
  @IsOptional() @IsString() @MaxLength(BOOKING_HOLD_REASON_MAX) reason?: string;
  @IsInt() @Min(1) expectedVersion!: number;
}

export class SharingLimitsPairDto {
  @IsObject() SHARED!: SharingLimits;
  @IsObject() FLEXIBLE!: SharingLimits;
}

export class SharingPolicyBody implements UpdateTransportSharingPolicyInput {
  @IsString() @MaxLength(SHARING_POLICY_TEXT_MAX) text!: string;
  @IsOptional() @IsBoolean() allowFlexible?: boolean;
  @ValidateNested() @Type(() => SharingLimitsPairDto) limits!: SharingLimitsPairDto;
  @IsOptional() @IsObject() priority?: Partial<Record<RidePreference, number>>;
}

export class DriverHoursDto implements DriverHoursPolicy {
  @ValidateIf(nullable) @IsInt() maxDutyS!: number | null;
  @ValidateIf(nullable) @IsInt() maxDrivingS!: number | null;
  @ValidateIf(nullable) @IsInt() breakAfterS!: number | null;
  @ValidateIf(nullable) @IsInt() breakS!: number | null;
  @ValidateIf(nullable) @IsInt() minRestS!: number | null;
}

export class PoolingSettingsBody implements UpdatePoolingSettingsInput {
  @IsOptional() @IsBoolean() liveDispatch?: boolean;
  @IsOptional() @IsIn(LIVE_DISPATCH_POLICIES) scheduledPolicy?: LiveDispatchPolicy;
  @IsOptional() @IsIn(LIVE_DISPATCH_POLICIES) delayPolicy?: LiveDispatchPolicy;
  @IsOptional() @IsInt() @Min(60) @Max(7200) delayThresholdS?: number;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => DriverHoursDto) driverHours?: DriverHoursDto | null;
}

/** PUT /transport/driver-policy: the policy itself, or `{ policy: null }` to clear it. */
export class DriverPolicyBody {
  @ValidateIf(nullable) @ValidateNested() @Type(() => DriverHoursDto) policy!: DriverHoursDto | null;
}

export class AvailabilityWindowDto {
  @IsIn(VEHICLE_AVAILABILITY_KINDS) kind!: VehicleAvailabilityKind;
  @IsISO8601() startsAt!: string;
  @IsISO8601() endsAt!: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(VEHICLE_AVAILABILITY_LIMITS.reasonMax) reason?: string | null;
}

export class PutAvailabilityDto implements PutVehicleAvailabilityInput {
  @IsOptional() @ValidateIf(nullable) @IsInt() @Min(0) @Max(VEHICLE_AVAILABILITY_LIMITS.turnaroundMaxS) turnaroundS?: number | null;
  @IsOptional() @IsISO8601() from?: string;
  @IsArray() @ArrayMaxSize(VEHICLE_AVAILABILITY_LIMITS.maxWindows) @ValidateNested({ each: true }) @Type(() => AvailabilityWindowDto) windows!: AvailabilityWindowDto[];
}

export class LiveDecideDto implements LiveDispatchDecideInput {
  @IsUUID() bookingId!: string;
  @IsOptional() @IsBoolean() apply?: boolean;
  @IsOptional() @IsString() @MaxLength(80) optionId?: string;
  @IsOptional() @IsUUID() requestId?: string;
}

export class DispatchRequestQuery implements DispatchRequestListQuery {
  @IsOptional() @IsIn(DISPATCH_REQUEST_STATUSES) status?: DispatchRequestStatus;
  @IsOptional() @IsIn(DISPATCH_TRIGGERS) trigger?: DispatchTrigger;
  @IsOptional() @IsUUID() bookingId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(200) limit?: number;
}

export class RouteAckDto implements DriverRouteAckInput {
  @IsInt() @Min(0) routeVersion!: number;
  @IsUUID() clientEventId!: string;
}
