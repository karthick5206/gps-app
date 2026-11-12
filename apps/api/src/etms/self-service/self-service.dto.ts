import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import {
  ME_CONFIRM_KINDS,
  ME_REPORT_CATEGORIES,
  TRANSPORT_DIRECTIONS,
  TRANSPORT_SELF_LIMITS as L,
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
