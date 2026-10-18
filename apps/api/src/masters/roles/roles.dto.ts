import { PartialType } from '@nestjs/mapped-types';
import { ACTIONS, Action, DataScope } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class RoleListQuery extends ListQueryDto {}

export class RolePermissionDto {
  @IsString() @MaxLength(50) menu!: string;
  @IsArray() @IsIn(ACTIONS, { each: true }) actions!: Action[];
}

export class CreateRoleDto {
  @IsString() @Length(1, 60) name!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @IsIn(['COMPANY', 'ASSIGNED']) dataScope!: DataScope;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RolePermissionDto)
  permissions!: RolePermissionDto[];
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}
