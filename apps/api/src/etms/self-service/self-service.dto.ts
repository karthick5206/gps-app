import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import {
  ME_CONFIRM_KINDS,
  ME_REPORT_CATEGORIES,
  TRANSPORT_ADHOC_LIMITS,
  TRANSPORT_BOOKING_JOURNEYS,
  TRANSPORT_DIRECTIONS,
  TRANSPORT_SELF_LIMITS as L,
  type MeAdhocEndRef,
  type MeAdhocRequestInput,
  type MeHomeLocationInput,
  type MeTransportProfileUpdateInput,
  type TransportBookingJourney,
  type MeConfirmKind,
  type MeCreateBookingInput,
  type MePlaceInput,
  type MePlaceRef,
  type MePlaceUpdateInput,
  type MeReportCategory,
  type MeTripConfirmInput,
  type MeTripReportInput,
  type TransportDirection,
} from '@veetracer/shared';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ME_ADHOC_END_KINDS: MeAdhocEndRef['kind'][] = ['HOME', 'SAVED', 'PLACE', 'MAP', 'SHIFT_SITE'];

/** The passenger's end of a self-booked leg: HOME, SAVED (placeId) or STOP (poiId). */
export class MePlaceRefDto {
  @IsIn(['HOME', 'SAVED', 'STOP']) kind!: MePlaceRef['kind'];
  @IsOptional() @IsUUID() placeId?: string;
  @IsOptional() @IsUUID() poiId?: string;
}

export class MeCreateBookingDto implements MeCreateBookingInput {
  @Matches(DAY, { message: 'serviceDate must be a date YYYY-MM-DD' }) serviceDate!: string;
  @IsIn(TRANSPORT_DIRECTIONS) direction!: TransportDirection;
  @IsUUID() shiftId!: string;
  @ValidateNested() @Type(() => MePlaceRefDto) place!: MePlaceRef & MePlaceRefDto;
  @IsOptional() @IsString() @MaxLength(L.bookingNoteMax) note?: string;
}

export class MePlaceDto implements MePlaceInput {
  @IsString() @MaxLength(L.placeLabelMax) label!: string;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
}

export class MePlaceUpdateDto implements MePlaceUpdateInput {
  @IsOptional() @IsString() @MaxLength(L.placeLabelMax) label?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
}

export class MeTripConfirmDto implements MeTripConfirmInput {
  @IsUUID() clientEventId!: string;
  @IsIn(ME_CONFIRM_KINDS) kind!: MeConfirmKind;
}

export class MeTripReportDto implements MeTripReportInput {
  @IsUUID() clientEventId!: string;
  @IsIn(ME_REPORT_CATEGORIES) category!: MeReportCategory;
  @IsOptional() @IsString() @MaxLength(L.reportNoteMax) note?: string;
}

// ───────────────────────────── WP 3.9 wave 2 (D-A7, D-A9) ─────────────────────────────

/** One end of a passenger's ad-hoc request (MeAdhocEndRef): the fields of its kind are checked by the service. */
export class MeAdhocEndRefDto {
  @IsIn(ME_ADHOC_END_KINDS) kind!: MeAdhocEndRef['kind'];
  @IsOptional() @IsUUID() placeId?: string;
  @IsOptional() @IsUUID() poiId?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(L.placeLabelMax) label?: string | null;
}

export class MeAdhocRequestDto implements MeAdhocRequestInput {
  @Matches(DAY, { message: 'serviceDate must be a date YYYY-MM-DD' }) serviceDate!: string;
  @IsIn(TRANSPORT_BOOKING_JOURNEYS) journey!: TransportBookingJourney;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() shiftId?: string | null;
  @ValidateNested() @Type(() => MeAdhocEndRefDto) pickup!: MeAdhocEndRef & MeAdhocEndRefDto;
  @ValidateNested() @Type(() => MeAdhocEndRefDto) destination!: MeAdhocEndRef & MeAdhocEndRefDto;
  @IsOptional() @IsISO8601() windowStart?: string;
  @IsOptional() @IsISO8601() windowEnd?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.purposeMax) purpose?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(L.bookingNoteMax) note?: string | null;
}

export class MeSearchQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
}

export class MeEmergencyContactDto {
  @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.contactNameMax) name!: string;
  @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.contactPhoneMax) phone!: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.contactRelationMax) relation?: string | null;
}

export class MeAccessibilityDto {
  @IsOptional() @IsBoolean() wheelchair?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.accessibilityNotesMax) notes?: string | null;
}

export class MeTransportProfileUpdateDto implements MeTransportProfileUpdateInput {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() defaultStopId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(TRANSPORT_ADHOC_LIMITS.emergencyContactsMax) @ValidateNested({ each: true }) @Type(() => MeEmergencyContactDto) emergencyContacts?: MeEmergencyContactDto[];
  @IsOptional() @ValidateNested() @Type(() => MeAccessibilityDto) accessibility?: MeAccessibilityDto;
}

export class MeHomeLocationDto implements MeHomeLocationInput {
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(TRANSPORT_ADHOC_LIMITS.homeAddressMax) address?: string | null;
  @IsOptional() @IsIn(['PHOTON', 'PIN', 'TYPED']) source?: 'PHOTON' | 'PIN' | 'TYPED';
  @IsOptional() @IsBoolean() clear?: boolean;
}
