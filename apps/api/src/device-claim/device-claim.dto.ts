import { IsEmail, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class ClaimDeviceBody {
  @IsString() @Length(4, 32) uniqueId!: string;
  @IsOptional() @IsString() @MaxLength(12) claimCode?: string;
  @IsOptional() @IsUUID() modelId?: string;
}

export class ShipDeviceBody {
  @IsString() @Length(2, 80) name!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @IsString() @MaxLength(24) mobile?: string | null;
  @IsOptional() @IsString() @MaxLength(200) note?: string | null;
}

export class HelpSheetQuery {
  /** Comma-separated device ids (one page each). */
  @IsString() @MaxLength(4000) ids!: string;
}
