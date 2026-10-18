import { PartialType } from '@nestjs/mapped-types';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class VehicleGroupListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() objectId?: string;
}

export class CreateVehicleGroupDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsUUID('all', { each: true }) objectIds?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateVehicleGroupDto extends PartialType(CreateVehicleGroupDto) {}
