import { Logger } from '@nestjs/common';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ROOT } from '../config/env';

export interface SmsMessage {
  to: string; // E.164
  text: string;
  dltTemplateId?: string | null;
  senderId?: string | null;
  /** Values for the DLT `{#var#}` slots, in order (what Indian gateways expect alongside the template id). */
  variables?: string[];
}

export interface SmsResult {
  provider: string;
  messageId: string | null;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsResult>;
}

/** Development provider: logs the message and appends it to var/sms/sms.log. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  private readonly logger = new Logger('SMS');
  private readonly file = join(APP_ROOT, 'var', 'sms', 'sms.log');

  async send(m: SmsMessage): Promise<SmsResult> {
    const line = `[SMS] to=${m.to} sender=${m.senderId ?? '-'} dlt=${m.dltTemplateId ?? '-'} vars=${JSON.stringify(m.variables ?? [])} text="${m.text}"`;
    this.logger.log(line);
    await mkdir(join(APP_ROOT, 'var', 'sms'), { recursive: true });
    await appendFile(this.file, `${new Date().toISOString()} ${line}\n`, 'utf8');
    return { provider: this.name, messageId: null };
  }
}

/**
 * Placeholder for a real Indian SMS gateway (MSG91 / Gupshup): DLT template id + sender id + variables.
 * Configure with SMS_PROVIDER=msg91 and MSG91_AUTH_KEY once implemented.
 */
export class Msg91SmsProvider implements SmsProvider {
  readonly name = 'msg91';
  constructor(private readonly authKey = process.env.MSG91_AUTH_KEY ?? '') {}

  async send(_m: SmsMessage): Promise<SmsResult> {
    if (!this.authKey) throw new Error('MSG91_AUTH_KEY is not configured');
    // POST https://control.msg91.com/api/v5/flow/ with { template_id, sender, recipients: [{ mobiles, var1.. }] }
    throw new Error('MSG91 provider is not implemented yet');
  }
}

export function createSmsProvider(name = process.env.SMS_PROVIDER ?? 'console'): SmsProvider {
  switch (name.toLowerCase()) {
    case 'msg91':
    case 'gupshup':
      return new Msg91SmsProvider();
    default:
      return new ConsoleSmsProvider();
  }
}
