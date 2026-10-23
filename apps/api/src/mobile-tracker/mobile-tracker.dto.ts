import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class TrackerRequestCodeBody {
  @IsString() @MaxLength(24) mobile!: string;
}

export class TrackerVerifyBody {
  @IsString() @MaxLength(24) mobile!: string;
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
  @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
  @IsOptional() @IsString() @MaxLength(20) appVersion?: string;
  @IsOptional() @IsIn(['android', 'ios']) platform?: string;
}

/** Points are validated one by one in the service (a bad point is skipped, not the whole batch). */
export class TrackerPositionsBody {
  @IsArray() @ArrayMaxSize(500) positions!: unknown[];
}

/** Crash report the app sends on the next start after a crash (no token: it may crash before activation). */
export class TrackerDiagnosticsBody {
  @IsOptional() @IsString() @MaxLength(20) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(20) platform?: string;
  @IsOptional() @IsString() @MaxLength(160) device?: string;
  @IsOptional() @IsString() @MaxLength(10_000) nativeCrash?: string | null;
  @IsOptional() @IsString() @MaxLength(10_000) jsCrash?: string | null;
}

/** Devices → edit → Tracker app: extra address for the activation code; null / empty clears it. */
export class TrackerActivationEmailBody {
  @IsOptional() @IsEmail() @MaxLength(254) activationEmail?: string | null;
}
