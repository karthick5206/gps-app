/*
 * Platform Settings → Messaging (Super Admin): which channels VeeTrax offers, and the Arattai Business set-up.
 * Customers see only switched-on channels in their alert settings; WhatsApp is never shown to customers for now.
 */

/** GET /messaging/channels: the alert channels a customer may choose (Push and In-app are always there). */
export interface MessagingChannelsDto {
  email: boolean;
  sms: boolean;
  arattai: boolean;
}

export interface MessagingSettingsDto {
  smsEnabled: boolean;
  emailEnabled: boolean;
  /** Super Admin only for now: not offered to customers. */
  whatsappEnabled: boolean;
  arattaiEnabled: boolean;
  arattaiCompanyId: string;
  arattaiBusinessNumberId: string;
  /** Authentication template: {{otp}}, {{validity_minutes}}. */
  arattaiOtpTemplateId: string;
  /** Transactional template for alerts: {{alert}}, {{vehicle}}, {{time}}, {{details}}. */
  arattaiAlertTemplateId: string;
  arattaiLanguage: string;
  arattaiClientId: string;
  /** A client secret is saved (its value is never shown). */
  arattaiClientSecretSet: boolean;
  /** "Connect Arattai" was approved. */
  arattaiConnected: boolean;
  arattaiConnectedAt: string | null;
  arattaiLastSentAt: string | null;
  arattaiLastError: string | null;
  /** Add this exact address as the redirect URI of the client in Arattai's API console. */
  arattaiRedirectUri: string;
}

export type MessagingSettingsInput = Omit<MessagingSettingsDto, 'arattaiClientSecretSet' | 'arattaiConnected' | 'arattaiConnectedAt' | 'arattaiLastSentAt' | 'arattaiLastError' | 'arattaiRedirectUri'> & {
  /** Empty = keep the saved secret. */
  arattaiClientSecret?: string;
};
