import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsTimeZone,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../common/list-query';
import { MOBILE_MESSAGE, MOBILE_PATTERN, PASSWORD_MESSAGE, PASSWORD_PATTERN } from '../../common/secrets';

const ACCOUNT_TYPES = ['BUSINESS', 'INDIVIDUAL'] as const;
type AccountTypeValue = (typeof ACCOUNT_TYPES)[number];

export class CompanyListQuery extends ListQueryDto {
  @IsOptional() @IsIn(ACCOUNT_TYPES) accountType?: AccountTypeValue;
}

export class CompanyAdminDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE }) mobile?: string;
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE }) password!: string;
}

export class CreateCompanyDto {
  @IsString() @Length(1, 120) name!: string;
  @IsIn(ACCOUNT_TYPES) accountType!: AccountTypeValue;
  @IsOptional() @IsTimeZone() timezone?: string;
  @ValidateNested() @Type(() => CompanyAdminDto) admin!: CompanyAdminDto;
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsIn(ACCOUNT_TYPES) accountType?: AccountTypeValue;
  @IsOptional() @IsTimeZone() timezone?: string;
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
}
