import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ThemePreference } from '@veetracer/shared';
import { MOBILE_MESSAGE, MOBILE_PATTERN, PASSWORD_MESSAGE, PASSWORD_PATTERN } from '../../common/secrets';

export class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MaxLength(128) password!: string;
}

export class OtpRequestDto {
  @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE }) mobile!: string;
}

export class OtpVerifyDto {
  @Matches(MOBILE_PATTERN, { message: MOBILE_MESSAGE }) mobile!: string;
  @Matches(/^\d{6}$/, { message: 'Code must be 6 digits' }) code!: string;
}

export class RefreshDto {
  @IsString() @Length(20, 200) refreshToken!: string;
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(254) email!: string;
}

export class ResetPasswordDto {
  @IsString() @Length(20, 200) token!: string;
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE }) password!: string;
}

/** Expo push token of the mobile app, e.g. ExponentPushToken[xxxx]. */
export class PushTokenDto {
  @Matches(/^(Exponent|Expo)PushToken[[A-Za-z0-9_-]{10,100}]$/, { message: 'Invalid push token' }) token!: string;
  @IsIn(['android', 'ios']) platform!: 'android' | 'ios';
  @IsOptional() @IsString() @MaxLength(100) deviceName?: string;
}

export class RemovePushTokenDto {
  @IsString() @MaxLength(200) token!: string;
}

export class PreferencesDto {
  @IsIn(['light', 'dark', 'system']) theme!: ThemePreference;
}
