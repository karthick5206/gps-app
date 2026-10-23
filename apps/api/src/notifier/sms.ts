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

/**
 * Smartping (DLT, India): GET {SMARTPING_URL}?username&password&from&to&text&unicode&dltPrincipalEntityId&dltContentId.
 * The text must match the registered DLT template exactly, with only the {#var#} slots filled. The response is JSON
 * { transactionId, state, statusCode, description }; e.g. state SUBMIT_FAILED / statusCode 2070 = authentication failure.
 * Env: SMARTPING_USERNAME, SMARTPING_PASSWORD (transactional account for OTPs), SMARTPING_SENDER (6-letter header),
 * SMARTPING_ENTITY_ID (DLT principal entity id), optional SMARTPING_URL.
 */
export class SmartpingSmsProvider implements SmsProvider {
  readonly name = 'smartping';
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(m: SmsMessage): Promise<SmsResult> {
    const { SMARTPING_USERNAME: username, SMARTPING_PASSWORD: password, SMARTPING_ENTITY_ID: entityId } = this.env;
    if (!username || !password || !entityId) throw new Error('Smartping is not configured (SMARTPING_USERNAME / SMARTPING_PASSWORD / SMARTPING_ENTITY_ID)');
    const sender = m.senderId || this.env.SMARTPING_SENDER;
    if (!sender) throw new Error('No SMS sender id (template senderId or SMARTPING_SENDER)');
    if (!m.dltTemplateId || m.dltTemplateId.startsWith('DLT-PENDING')) throw new Error('The SMS template has no registered DLT template id');
    const digits = m.to.replace(/\D/g, '');
    const params = new URLSearchParams({
      username,
      password,
      from: sender,
      to: digits.length === 10 ? `91${digits}` : digits,
      text: m.text,
      unicode: /[^\u0000-\u007f]/.test(m.text) ? 'true' : 'false',
      dltPrincipalEntityId: entityId,
      dltContentId: m.dltTemplateId,
    });
    const url = this.env.SMARTPING_URL || 'https://pgapi.smartping.io/fe/api/v1/send';
    const res = await this.fetchImpl(`${url}?${params.toString()}`, { method: 'GET', signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    let json: { transactionId?: unknown; state?: string; statusCode?: number; description?: string; detail?: string } = {};
    try {
      json = JSON.parse(body);
    } catch {
      // non-JSON error page
    }
    const state = json.state ?? '';
    if (!res.ok || /FAIL|REJECT|ERROR/i.test(state)) {
      throw new Error(`Smartping ${res.status} ${state} ${json.statusCode ?? ''}: ${json.description ?? json.detail ?? body.slice(0, 200)}`.replace(/\s+/g, ' ').trim());
    }
    return { provider: this.name, messageId: json.transactionId != null ? String(json.transactionId) : null };
  }
}

export function createSmsProvider(name = process.env.SMS_PROVIDER ?? 'console'): SmsProvider {
  switch (name.toLowerCase()) {
    case 'smartping':
      return new SmartpingSmsProvider();
    case 'msg91':
    case 'gupshup':
      return new Msg91SmsProvider();
    default:
      return new ConsoleSmsProvider();
  }
}
