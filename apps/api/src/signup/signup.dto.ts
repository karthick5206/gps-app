import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MESSAGE, PASSWORD_PATTERN } from '../common/secrets';

export class SignupRequestBody {
  @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email!: string;
}

export class SignupCompleteBody {
  @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email!: string;
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/, { message: 'The code has 6 digits' }) code!: string;
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(24) mobile?: string;
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE }) password!: string;
  @IsString() @Length(2, 2) stateCode!: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
}
