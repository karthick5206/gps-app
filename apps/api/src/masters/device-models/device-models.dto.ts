import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class DeviceModelListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(20) protocol?: string;
}

export class DeviceFieldDto {
  @IsString() @Length(1, 40) key!: string;
  @IsString() @Length(1, 60) label!: string;
  @IsOptional() @IsString() @MaxLength(10) unit?: string;
  @IsIn(['number', 'boolean', 'string']) type!: 'number' | 'boolean' | 'string';
}

export class DeviceCommandDto {
  @IsString() @Length(1, 40) key!: string;
  @IsString() @Length(1, 60) label!: string;
}

export class CreateDeviceModelDto {
  @IsString() @Length(1, 50) brand!: string;
  @IsString() @Length(1, 50) model!: string;
  @IsString() @Length(1, 20) protocol!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) capabilities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DeviceFieldDto)
  fields?: DeviceFieldDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => DeviceCommandDto)
  commands?: DeviceCommandDto[];
  @IsOptional() @IsInt() @Min(-720) @Max(840) timeOffsetMinutes?: number;
  @IsOptional() @IsObject() filterDefaults?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDeviceModelDto extends PartialType(CreateDeviceModelDto) {}
