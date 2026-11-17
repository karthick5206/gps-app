import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { VEHICLE_IMPORT_MAX_ROWS } from '@veetracer/shared';
import { CreateDeviceDto, DeviceListQuery } from '../devices/devices.dto';

export class AdminDeviceListQuery extends DeviceListQuery {
  @IsOptional() @IsUUID() companyId?: string;
}

export class CreateAdminDeviceDto extends CreateDeviceDto {
  /** Owning company; null keeps the device in platform stock. */
  @IsOptional() @IsUUID() companyId?: string | null;
}

export class UpdateAdminDeviceDto extends PartialType(CreateAdminDeviceDto) {}

/** Super Admin "Import vehicles" (vehicle-import.service.ts). Rows come from the sheet, read in the browser. */
export class VehicleImportRowDto {
  @Type(() => Number) @IsInt() @Min(1) row!: number;
  @IsString() @MaxLength(200) vehicleName!: string;
  @IsOptional() @IsString() @MaxLength(100) plate?: string | null;
  @IsString() @MaxLength(60) imei!: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string | null;
  @IsOptional() @IsString() @MaxLength(40) sim?: string | null;
  @IsOptional() @IsString() @MaxLength(200) company?: string | null;
  @IsOptional() @IsString() @MaxLength(200) branch?: string | null;
  @IsOptional() @IsString() @MaxLength(200) vendor?: string | null;
  @IsOptional() @IsString() @MaxLength(100) driverName?: string | null;
  @IsOptional() @IsString() @MaxLength(30) driverMobile?: string | null;
  @IsOptional() @IsString() @MaxLength(20) licenceFrom?: string | null;
  @IsOptional() @IsString() @MaxLength(20) licenceUntil?: string | null;
}

export class VehicleImportDto {
  @IsOptional() @IsUUID() companyId?: string | null;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsUUID() defaultModelId?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(VEHICLE_IMPORT_MAX_ROWS) @ValidateNested({ each: true }) @Type(() => VehicleImportRowDto) rows!: VehicleImportRowDto[];
  @IsOptional() @IsString() @MaxLength(200) overrideReason?: string | null;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) licenceFrom?: string | null;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) licenceUntil?: string | null;
}
