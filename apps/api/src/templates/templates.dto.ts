import { NOTIFY_CHANNELS } from '@veetracer/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { APPROVAL_STATUSES, TEMPLATE_PURPOSES } from './render';

const bool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export class TemplateListQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['EMAIL', 'SMS', 'PUSH', 'WHATSAPP']) channel?: string;
  @IsOptional() @IsIn(TEMPLATE_PURPOSES) purpose?: string;
  @IsOptional() @IsIn(['SYSTEM', 'COMPANY']) level?: 'SYSTEM' | 'COMPANY';
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @Transform(bool) @IsBoolean() overridden?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() notApproved?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) pageSize?: number;
  @IsOptional() @IsIn(['name', 'purpose', 'channel', 'updatedAt', 'level']) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @Length(1, 150) name?: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string | null;
  @IsOptional() @IsString() @Length(1, 100_000) body?: string;
  @IsOptional() @IsString() @MaxLength(50) dltTemplateId?: string | null;
  @IsOptional() @IsString() @MaxLength(20) senderId?: string | null;
  @IsOptional() @IsIn(APPROVAL_STATUSES) approvalStatus?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class DuplicateTemplateDto {
  @IsOptional() @IsString() @Length(2, 10) language?: string;
  @IsOptional() @IsString() @Length(1, 150) name?: string;
}

export class PreviewTemplateDto {
  @IsOptional() @IsUUID() templateId?: string;
  @IsOptional() @IsIn(TEMPLATE_PURPOSES) purpose?: string;
  @IsOptional() @IsIn(NOTIFY_CHANNELS) channel?: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string | null;
  @IsOptional() @IsString() @MaxLength(100_000) body?: string;
  @IsOptional() @IsUUID() alertId?: string;
}

export class TestTemplateDto {
  @IsString() @Length(3, 200) to!: string;
}

export class PlaceholdersQuery {
  @IsOptional() @IsIn(TEMPLATE_PURPOSES) purpose?: string;
}
