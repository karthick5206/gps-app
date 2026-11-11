import {
  CONSENT_PURPOSES,
  HOME_LOCATION_SOURCES,
  TRANSPORT_VEHICLE_CATEGORIES,
  type ConsentPurpose,
  type CreatePassengerInput,
  type DriverLoginInput,
  type EmergencyContact,
  type HomeLocationSource,
  type PassengerAccessibility,
  type PassengerAppAccessInput,
  type PassengerHomeInput,
  type PassengerImportOptions,
  type PassengerListQuery as PassengerListQueryShape,
  type RecordConsentInput,
  type TransportVehicleCategory,
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
  @IsString() @IsNotEmpty() @MaxLength(40) noticeVersion!: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
}

export class VehicleProfileDto implements TransportVehicleProfileInput {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) seats!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(20) wheelchairSpaces?: number;
  @IsOptional() @ValidateIf(nullable) @IsBoolean() hasAc?: boolean | null;
  @IsOptional() @ValidateIf(nullable) @IsIn(TRANSPORT_VEHICLE_CATEGORIES) category?: TransportVehicleCategory | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) notes?: string | null;
}
