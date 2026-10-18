import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

const TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

export class LookupListQuery extends ListQueryDto {
  @IsOptional() @Matches(TYPE_PATTERN, { message: 'type must be UPPER_SNAKE_CASE' }) type?: string;
}

export class CreateLookupDto {
  @Matches(TYPE_PATTERN, { message: 'type must be UPPER_SNAKE_CASE' }) type!: string;
  @Matches(CODE_PATTERN, { message: 'code must be upper-case letters, digits, "_" or "-"' }) code!: string;
  @IsString() @Length(1, 100) label!: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateLookupDto extends PartialType(CreateLookupDto) {}
