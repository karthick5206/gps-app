import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

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
