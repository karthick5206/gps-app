import { ALERT_LEVELS, ALERT_SEVERITIES, ALERT_TYPE_CODES, AlertLevel, AlertSeverity, AlertTypeCode } from '@veetracer/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class LevelTargetQuery {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsUUID() targetId!: string;
}

export class OptionalLevelTargetQuery {
  @IsOptional() @IsIn(ALERT_LEVELS) level?: AlertLevel;
  @IsOptional() @IsUUID() targetId?: string;
}

export class ObjectQuery {
  @IsUUID() objectId!: string;
}

/** Upsert body. Absent field = keep the stored value; null = inherit (remove the override). */
export class PutAlertSettingDto {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsUUID() targetId!: string;
  @IsIn(ALERT_TYPE_CODES) alertType!: AlertTypeCode;
  @IsOptional() @IsBoolean() enabled?: boolean | null;
  /** Only overridden keys; a key set to null is removed. `params: null` clears all param overrides. */
  @IsOptional() @IsObject() params?: Record<string, unknown> | null;
  @IsOptional() @IsObject() schedule?: Record<string, unknown> | null;
  @IsOptional() @IsInt() cooldownMin?: number | null;
  @IsOptional() @IsIn(ALERT_SEVERITIES) severity?: AlertSeverity | null;
  /** Per severity; a severity set to null is removed. `channels: null` clears all channel overrides. */
  @IsOptional() @IsObject() channels?: Record<string, unknown> | null;
}

export class CopySettingsDto {
  @IsUUID() fromObjectId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) toObjectIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) toGroupIds?: string[];
}

export class BulkEnableDto {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @IsUUID('all', { each: true }) targetIds!: string[];
  @IsIn(ALERT_TYPE_CODES) alertType!: AlertTypeCode;
  @IsBoolean() enabled!: boolean;
}
