/**
 * D6 G3: the recorded status of one message is what the provider did with it, never "no exception happened".
 *
 * - SENT: a configured provider accepted the message (there are no delivery receipts, so SENT = "accepted by the
 *   provider", not "delivered").
 * - FAILED: the provider was configured and refused / errored (after the in-process retries).
 * - SKIPPED: no provider is configured for the channel (console SMS, no mail provider, push disabled). In development
 *   a console / file copy may still be written, but the status stays SKIPPED.
 */
export type DeliveryStatus = 'SENT' | 'FAILED' | 'SKIPPED';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  error: string | null;
  providerMessageId: string | null;
}

/** Human channel name used in the SKIPPED reason. */
export function channelLabel(channel: string): string {
  switch (channel) {
    case 'EMAIL':
      return 'E-mail';
    case 'SMS':
      return 'SMS';
    case 'PUSH':
      return 'Push';
    case 'WHATSAPP':
      return 'WhatsApp';
    case 'ARATTAI':
      return 'Arattai';
    default:
      return channel;
  }
}

/** Reason recorded on a SKIPPED row of an unconfigured channel. */
export function notConfiguredReason(channel: string, devCopy = false): string {
  return `${channelLabel(channel)} provider not configured${devCopy ? ' (development copy only)' : ''}`;
}

export function outcome(input: {
  channel: string;
  configured: boolean;
  error?: string | null;
  messageId?: string | null;
  /** A development console / file copy was written although no provider is configured. */
  devCopy?: boolean;
}): DeliveryOutcome {
  if (!input.configured) return { status: 'SKIPPED', error: notConfiguredReason(input.channel, input.devCopy), providerMessageId: null };
  if (input.error) return { status: 'FAILED', error: input.error, providerMessageId: null };
  return { status: 'SENT', error: null, providerMessageId: input.messageId ?? null };
}

/** Whether a development console / file copy of an unconfigured channel is still produced (never in production). */
export function writesDevCopy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}
