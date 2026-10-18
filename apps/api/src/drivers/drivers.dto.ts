import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ListQueryDto } from '../common/list-query';
import { MOBILE_MESSAGE, MOBILE_PATTERN } from '../common/secrets';

export class DriverListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  /** `on` = currently driving a vehicle, `off` = not. */
  @IsOptional() @Matches(/^(on|off)$/) driving?: 'on' | 'off';
}

export class CreateDriverDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE }) mobile?: string | null;
  @IsOptional() @IsString() @MaxLength(40) employeeId?: string | null;
  @IsOptional() @IsString() @MaxLength(40) licenseNo?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() licenseExpiry?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^[0-9A-Fa-f:\s-]{1,40}$/, { message: 'RFID tag must be the hex id printed on / reported for the card' })
  rfidTag?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() branchId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDriverDto extends PartialType(CreateDriverDto) {}

export class AssignDriverDto {
  @IsUUID() objectId!: string;
  @ValidateIf((_, v) => v !== null) @IsUUID() driverId!: string | null;
}

export class AssignmentQuery {
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsUUID() objectId?: string;
}
