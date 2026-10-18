import { PartialType } from '@nestjs/mapped-types';
import { OBJECT_TYPES, ObjectType, VEHICLE_TYPES, VehicleType } from '@veetracer/shared';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class ObjectListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsIn(OBJECT_TYPES) type?: ObjectType;
  @IsOptional() @IsIn(VEHICLE_TYPES) vehicleType?: VehicleType;
}

export class CreateObjectDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsIn(OBJECT_TYPES) type?: ObjectType;
  @IsOptional() @IsIn(VEHICLE_TYPES) vehicleType?: VehicleType | null;
  @IsOptional() @IsString() @MaxLength(20) plateNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(50) make?: string | null;
  @IsOptional() @IsString() @MaxLength(50) model?: string | null;
  @IsOptional() @IsString() @MaxLength(30) color?: string | null;
  @IsOptional() @IsString() @MaxLength(50) icon?: string | null;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(300) speedLimitKph?: number | null;
  @IsOptional() @IsNumber() @Min(0) odometerOffsetKm?: number;
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Fit this device to the object (closes the device's and the object's previous assignment). null = remove. */
  @IsOptional() @IsUUID() deviceId?: string | null;
}

export class UpdateObjectDto extends PartialType(CreateObjectDto) {}

export class MaintenanceDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
