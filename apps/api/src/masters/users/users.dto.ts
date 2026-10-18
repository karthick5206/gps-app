import { PartialType } from '@nestjs/mapped-types';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { ListQueryDto } from '../../common/list-query';
import { MOBILE_MESSAGE, MOBILE_PATTERN, PASSWORD_MESSAGE, PASSWORD_PATTERN } from '../../common/secrets';

export class UserListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

export class CreateUserDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE }) mobile?: string | null;
  @IsOptional() @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE }) password?: string;
  @IsOptional() @IsUUID() managerId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) roleIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) branchIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) objectIds?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {}
