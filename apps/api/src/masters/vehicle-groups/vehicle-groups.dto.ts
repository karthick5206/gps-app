import { PartialType } from '@nestjs/mapped-types';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class VehicleGroupListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() objectId?: string;
}

export class CreateVehicleGroupDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) objectIds?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Higher wins when an object's groups have conflicting alert settings (M2a). */
  @IsOptional() @IsInt() @Min(0) @Max(1000) alertPriority?: number;
}

export class UpdateVehicleGroupDto extends PartialType(CreateVehicleGroupDto) {}
