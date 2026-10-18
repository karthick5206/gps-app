import { ALERT_LEVELS, ALERT_SEVERITIES, ALERT_TYPE_CODES, AlertLevel, AlertSeverity, AlertTypeCode, NOTIFY_CHANNELS, NotifyChannel, RecipientEntry, RecipientMode } from '@veetracer/shared';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

export class RecipientListQuery {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsUUID() targetId!: string;
}

export class PutRecipientListDto {
  @IsIn(ALERT_LEVELS) level!: AlertLevel;
  @IsUUID() targetId!: string;
  @IsOptional() @IsIn([...ALERT_TYPE_CODES, '*']) alertType?: AlertTypeCode | '*';
  @IsOptional() @IsIn([...ALERT_SEVERITIES, '*']) severity?: AlertSeverity | '*';
  @IsIn(NOTIFY_CHANNELS) channel!: NotifyChannel;
  @IsIn(['DEFAULT', 'ADD', 'ONLY', 'NONE']) mode!: RecipientMode;
  @IsArray() @ArrayMaxSize(200) entries!: RecipientEntry[];
}

export class ResolveRecipientsQuery {
  @IsUUID() objectId!: string;
  @IsIn(ALERT_TYPE_CODES) alertType!: AlertTypeCode;
  @IsOptional() @IsIn(ALERT_SEVERITIES) severity?: AlertSeverity;
}

export class TestRecipientsDto {
  @IsUUID() objectId!: string;
  @IsIn(ALERT_TYPE_CODES) alertType!: AlertTypeCode;
  @IsOptional() @IsIn(ALERT_SEVERITIES) severity?: AlertSeverity;
}
