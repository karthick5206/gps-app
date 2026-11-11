import {
  CONSENT_EVIDENCE_REF_MAX,
  CONSENT_NOTE_MAX,
  CONSENT_NOTICE_BODY_MAX,
  CONSENT_NOTICE_TITLE_MAX,
  CONSENT_PURPOSES,
  LOGIN_REMOVAL_MODES,
  HOME_LOCATION_SOURCES,
  TRANSPORT_VEHICLE_CATEGORIES,
  type AdminRecordConsentInput,
  type ConsentPurpose,
  type CreatePassengerInput,
  type DriverLoginInput,
  type EmergencyContact,
  type ErasePassengerInput,
  type HomeLocationSource,
  type LoginRemovalMode,
  type PassengerAccessibility,
  type PassengerAppAccessInput,
  type PassengerHomeInput,
  type PassengerImportOptions,
  type PassengerListQuery as PassengerListQueryShape,
  type PublishConsentNoticeInput,
  type RecordConsentInput,
  type TransportVehicleCategory,
  type TransportVehicleListQuery as TransportVehicleListQueryShape,
  type TransportVehicleProfileInput,
  type UpdatePassengerInput,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
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
import { PASSWORD_MESSAGE, PASSWORD_PATTERN } from '../../common/secrets';
import { ADDRESS_MAX, CODE_MAX, NAME_MAX, NOTES_MAX } from './passenger-import';

const nullable = (_: object, v: unknown) => v !== null;

export class PassengerListQuery extends ListQueryDto implements PassengerListQueryShape {
  @IsOptional() @IsUUID() siteId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(['true', 'false']) needsLocation?: 'true' | 'false';
  @IsOptional() @IsIn(['true', 'false']) appAccess?: 'true' | 'false';
  @IsOptional() @IsIn(['true', 'false']) routingConsent?: 'true' | 'false';
  declare sort?: PassengerListQueryShape['sort'];
}

export class PassengerHomeDto implements PassengerHomeInput {
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(ADDRESS_MAX) address?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-90) @Max(90) lat?: number | null;
  @IsOptional() @ValidateIf(nullable) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-180) @Max(180) lng?: number | null;
  @IsOptional() @IsIn(HOME_LOCATION_SOURCES) source?: HomeLocationSource;
  @IsOptional() @ValidateIf(nullable) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1) confidence?: number | null;
  @IsOptional() @IsBoolean() geocode?: boolean;
}

export class PassengerAccessibilityDto implements PassengerAccessibility {
  @IsOptional() @IsBoolean() wheelchair?: boolean;
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class EmergencyContactDto implements EmergencyContact {
  @IsString() @IsNotEmpty() @MaxLength(NAME_MAX) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(20) phone!: string;
  @IsOptional() @IsString() @MaxLength(50) relation?: string;
}

export class CreatePassengerDto implements CreatePassengerInput {
  @IsString() @IsNotEmpty() @MaxLength(CODE_MAX) employeeCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(NAME_MAX) displayName!: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(25) mobile?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() branchId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() officePoiId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() defaultStopPoiId?: string | null;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => PassengerHomeDto) home?: PassengerHomeDto | null;
  @IsOptional() @ValidateNested() @Type(() => PassengerAccessibilityDto) accessibility?: PassengerAccessibilityDto;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => EmergencyContactDto) emergencyContacts?: EmergencyContactDto[];
}

export class UpdatePassengerDto implements UpdatePassengerInput {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(CODE_MAX) employeeCode?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(NAME_MAX) displayName?: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(25) mobile?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() branchId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() officePoiId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() defaultStopPoiId?: string | null;
  @IsOptional() @ValidateIf(nullable) @ValidateNested() @Type(() => PassengerHomeDto) home?: PassengerHomeDto | null;
  @IsOptional() @ValidateNested() @Type(() => PassengerAccessibilityDto) accessibility?: PassengerAccessibilityDto;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => EmergencyContactDto) emergencyContacts?: EmergencyContactDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GeocodeQuery {
  @IsString() @MaxLength(120) q!: string;
}

export class PassengerImportOptionsDto implements PassengerImportOptions {
  @IsOptional() @IsIn(['true', 'false']) geocode?: 'true' | 'false';
  @IsOptional() @IsString() @MaxLength(20000) rows?: string;
}

export class PassengerAppAccessDto implements PassengerAppAccessInput {
  @IsOptional() @ValidateIf(nullable) @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(25) mobile?: string | null;
  @IsOptional() @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE }) password?: string;
}

export class DriverLoginDto implements DriverLoginInput {
  @IsOptional() @ValidateIf(nullable) @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(25) mobile?: string | null;
  @IsOptional() @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE }) password?: string;
}

export class RecordConsentDto implements RecordConsentInput {
  @IsIn(CONSENT_PURPOSES) purpose!: ConsentPurpose;
  @IsBoolean() granted!: boolean;
  /** The version the person was shown; the server records the current one and refuses a stale one. */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) noticeVersion?: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
}

/** Admin on the passenger's behalf (M2): withdraw, or a recorded offline grant with evidenceRef + note. */
export class AdminRecordConsentDto extends RecordConsentDto implements AdminRecordConsentInput {
  @IsOptional() @IsString() @MaxLength(CONSENT_EVIDENCE_REF_MAX) evidenceRef?: string;
  @IsOptional() @IsString() @MaxLength(CONSENT_NOTE_MAX) note?: string;
}

/** Erasure confirmation (M5): the employee code, typed. */
export class ErasePassengerDto implements ErasePassengerInput {
  @IsString() @IsNotEmpty() @MaxLength(CODE_MAX) confirm!: string;
}

export class VehicleProfileDto implements TransportVehicleProfileInput {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) seats!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(20) wheelchairSpaces?: number;
  @IsOptional() @ValidateIf(nullable) @IsBoolean() hasAc?: boolean | null;
  @IsOptional() @ValidateIf(nullable) @IsIn(TRANSPORT_VEHICLE_CATEGORIES) category?: TransportVehicleCategory | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) notes?: string | null;
}

export class PublishConsentNoticeDto implements PublishConsentNoticeInput {
  @IsIn(CONSENT_PURPOSES) purpose!: ConsentPurpose;
  @IsString() @IsNotEmpty() @MaxLength(CONSENT_NOTICE_TITLE_MAX) title!: string;
  @IsString() @IsNotEmpty() @MaxLength(CONSENT_NOTICE_BODY_MAX) body!: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
}


export class LoginRemovalQuery {
  @IsOptional() @IsIn(LOGIN_REMOVAL_MODES) mode?: LoginRemovalMode;
}

export class TransportVehicleListQuery extends ListQueryDto implements TransportVehicleListQueryShape {
  @IsOptional() @IsIn(['set', 'unset']) seats?: 'set' | 'unset';
  declare sort?: TransportVehicleListQueryShape['sort'];
}
