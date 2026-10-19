import { readFile } from 'node:fs/promises';
import type { MailAttachment } from './mailer.service';

/**
 * Zoho CPaaS (formerly ZeptoMail) transactional e-mail API.
 * Env: ZOHO_MAIL_KEY (send token; with or without the "Zoho-enczapikey " prefix), ZOHO_MAIL_URL (default
 * https://cpaas.zoho.in — use the host of your Zoho data centre), MAIL_FROM ("Name <address>" on a domain verified in Zoho),
 * MAIL_REPLY_TO (optional "Name <address>" where replies go, e.g. a monitored inbox when MAIL_FROM is a no-reply address).
 */
export interface ZohoMailConfig {
  key: string;
  baseUrl: string;
}

export function zohoMailConfig(env: NodeJS.ProcessEnv = process.env): ZohoMailConfig | null {
  const key = env.ZOHO_MAIL_KEY?.trim();
  if (!key) return null;
  return { key: key.startsWith('Zoho-enczapikey ') ? key : `Zoho-enczapikey ${key}`, baseUrl: (env.ZOHO_MAIL_URL || 'https://cpaas.zoho.in').replace(/\/+$/, '') };
}

/** "VeeTrax <alerts@example.com>" → { name, address }. */
export function parseFrom(from: string): { address: string; name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { address: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim() } : {}) } : { address: from.trim() };
}

export async function sendZohoMail(
  cfg: ZohoMailConfig,
  msg: { from: string; replyTo?: string; to: string; subject: string; html: string; text: string; attachments?: MailAttachment[] },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const attachments = await Promise.all(
    (msg.attachments ?? []).map(async (a) => ({
      name: a.filename,
      mime_type: a.contentType ?? 'application/octet-stream',
      content: (a.path ? await readFile(a.path) : Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? '')).toString('base64'),
    })),
  );
  const res = await fetchImpl(`${cfg.baseUrl}/v1.1/email`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: cfg.key },
    body: JSON.stringify({
      from: parseFrom(msg.from),
      ...(msg.replyTo ? { reply_to: [parseFrom(msg.replyTo)] } : {}),
      to: msg.to.split(/[,;]\s*/).filter(Boolean).map((address) => ({ email_address: { address } })),
      subject: msg.subject,
      htmlbody: msg.html,
      textbody: msg.text,
      ...(attachments.length ? { attachments } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Zoho mail HTTP ${res.status}: ${body.slice(0, 300)}`);
  try {
    return (JSON.parse(body) as { request_id?: string }).request_id ?? null;
  } catch {
    return null;
  }
}
