import { ALERT_TYPE_MAP, SYSTEM_TEMPLATE_PURPOSES, type AlertTypeCode, type MessageTemplateDto, type TemplateApproval, type TemplatePurpose } from '@veetracer/shared';

/** The API adds the generated DLT text and variable order to each template. */
export type TemplateRow = MessageTemplateDto & { dltText?: string | null; variables?: string[] };

export interface PreviewResponse {
  subject: string | null;
  body: string;
  text: string;
  missing: string[];
  unknown: string[];
  sms: { dltText: string; values: string[]; encoding: 'GSM' | 'UNICODE'; length: number; parts: number } | null;
}

export interface TemplateVersionDto {
  version: number;
  subject: string | null;
  body: string;
  changedByName: string | null;
  createdAt: string;
  current: boolean;
}

const SYSTEM_LABEL: Record<(typeof SYSTEM_TEMPLATE_PURPOSES)[number], string> = {
  SYSTEM_OTP: 'Login OTP',
  SYSTEM_PASSWORD_RESET: 'Password reset',
  SYSTEM_WELCOME: 'Welcome',
  SYSTEM_SCHEDULED_REPORT: 'Scheduled report',
};

export function purposeLabel(p: TemplatePurpose | string): string {
  return ALERT_TYPE_MAP[p as AlertTypeCode]?.label ?? SYSTEM_LABEL[p as keyof typeof SYSTEM_LABEL] ?? p;
}

export const isAlertPurpose = (p: string) => p in ALERT_TYPE_MAP;

export const CHANNEL_NAME: Record<MessageTemplateDto['channel'], string> = { EMAIL: 'Email', SMS: 'SMS', PUSH: 'Push', WHATSAPP: 'WhatsApp' };

export const APPROVAL_LABEL: Record<TemplateApproval, string> = { NA: 'Not required', DRAFT: 'Draft', PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' };
export const APPROVAL_VARIANT: Record<TemplateApproval, 'muted' | 'secondary' | 'warning' | 'success' | 'destructive'> = {
  NA: 'muted',
  DRAFT: 'secondary',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
};

/** SMS (DLT) and WhatsApp (Meta) templates need provider approval before they can be activated. */
export const needsApproval = (channel: MessageTemplateDto['channel']) => channel === 'SMS' || channel === 'WHATSAPP';
export const LANGUAGE_NAME: Record<string, string> = { en: 'English', ta: 'Tamil', hi: 'Hindi' };
