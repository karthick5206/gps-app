import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class BranchListQuery extends ListQueryDto {}

export class CreateBranchDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(20) code?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {}
