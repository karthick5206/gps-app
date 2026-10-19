import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomToken } from '../common/secrets';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export const generateWebhookSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomToken(24)}`;

/** Start of the secret shown in lists (`whsec_ab12`). */
export const secretPreview = (secret: string): string => secret.slice(0, WEBHOOK_SECRET_PREFIX.length + 4);

/** Hex HMAC-SHA256 of `<timestamp>.<body>` with the endpoint secret. */
export function signPayload(secret: string, timestampSec: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
}

/** Value of the X-VeeTrax-Signature header: `t=<unix seconds>,v1=<hex>`. */
export function signatureHeader(secret: string, timestampSec: number, body: string): string {
  return `t=${timestampSec},v1=${signPayload(secret, timestampSec, body)}`;
}

/** Receiver-side check (also used in tests and the docs): signature matches and is at most `toleranceSec` old. */
export function verifySignature(secret: string, header: string, body: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(signPayload(secret, t, body), 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
