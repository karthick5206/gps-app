import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsObject, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class TrackerRequestCodeBody {
  @IsString() @MaxLength(24) mobile!: string;
  /** Needed when the number isn't registered yet: the phone joins (or creates) the personal account of this e-mail. */
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
}

/** Activation screen: is this number registered, and with which e-mail / name (full only on the same phone). */
export class TrackerLookupBody {
  @IsString() @MaxLength(24) mobile!: string;
  @IsOptional() @IsString() @MaxLength(64) installId?: string;
}

/** Reinstall on the same phone: the install id of its last activation gets a new token without a code. */
export class TrackerRestoreBody {
  @IsString() @Length(8, 64) installId!: string;
  @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
  @IsOptional() @IsString() @MaxLength(20) appVersion?: string;
  @IsOptional() @IsIn(['android', 'ios']) platform?: string;
}

export class TrackerVerifyBody {
  @IsString() @MaxLength(24) mobile!: string;
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
  @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
  @IsOptional() @IsString() @MaxLength(20) appVersion?: string;
  @IsOptional() @IsIn(['android', 'ios']) platform?: string;
  @IsOptional() @IsString() @MaxLength(64) installId?: string;
}

/** Points are validated one by one in the service (a bad point is skipped, not the whole batch). */
export class TrackerPositionsBody {
  @IsArray() @ArrayMaxSize(500) positions!: unknown[];
  /** Phone health report (app 1.1.7+), sanitised in the service. */
  @IsOptional() @IsObject() health?: Record<string, unknown>;
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
