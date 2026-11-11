import { createHash, createHmac } from 'node:crypto';

/**
 * D6 G2 delivery guarantee (owner correction A, 2026-11-11). NOT exactly-once. What VeeTrax guarantees:
 *
 * 1. Durable job recovery: every committed Alert gets a notification job (stream or sweeper) until it is notifiedAt
 *    or DEAD.
 * 2. Per-recipient deduplication inside VeeTrax: at most one NotificationLog row per alertId + channel + recipient
 *    (unique "dedupeKey"). Duplicate DB records = 0.
 * 3. At-least-once delivery attempts: a failed or interrupted job is redelivered (MAX_DELIVERIES), an interrupted
 *    send is taken over after its lease (MAX_TAKEOVERS).
 * 4. Bounded duplicate risk at the external-provider boundary: if a process dies after the provider accepted a
 *    message but before the status UPDATE, or a lease is taken over after a send slower than LEASE_MS, the recipient
 *    can get the same message again. Bound: one extra message per lease takeover, at most MAX_TAKEOVERS per dedupeKey.
 * 5. Provider idempotency keys where the provider supports one (providerRef(dedupeKey), stable across retries).
 */

/** Stream deliveries of one job before it is declared DEAD (owner decision Q5). */
export const MAX_DELIVERIES = 5;
/** Lease of a worker on a QUEUED NotificationLog row. Far above the slowest send (3 tries × 20 s timeout + backoff). */
export const LEASE_MS = 5 * 60_000;
/** Lease takeovers of one row before it is given up as FAILED. */
export const MAX_TAKEOVERS = 3;

export type Channel = 'EMAIL' | 'SMS' | 'PUSH' | 'WHATSAPP' | 'ARATTAI' | 'INAPP';

/** Domain separation for the recipient hash (a different purpose than the JWT signatures sharing the secret). */
const DEDUPE_CONTEXT = 'veetrax:notify-dedupe:v1';
let pepperCache: { secret: string; key: Buffer } | null = null;

/**
 * Server-side pepper for recipient hashes: HMAC(JWT_SECRET, DEDUPE_CONTEXT). Every API / notifier process requires
 * JWT_SECRET (loadEnv), so production keys are always peppered. Without a secret (unit tests, scripts) the context
 * string itself is the key, i.e. a plain SHA-256-based hash of the normalised recipient.
 */
function pepper(secret: string | undefined): Buffer {
  const s = secret ?? '';
  if (pepperCache?.secret !== s) pepperCache = { secret: s, key: s ? createHmac('sha256', s).update(DEDUPE_CONTEXT).digest() : Buffer.from(DEDUPE_CONTEXT) };
  return pepperCache.key;
}

/**
 * Opaque recipient reference: HMAC-SHA256 of the normalised (trimmed, lower-case) address with the server-side pepper.
 * A plain SHA-256 of a phone number or e-mail is reversible by enumeration (all 10^10 Indian mobile numbers take
 * minutes), so a keyed hash is used: the dedupe key and log lines reveal nothing without the secret.
 */
export function recipientHash(recipient: string, secret: string | undefined = process.env.JWT_SECRET): string {
  return createHmac('sha256', pepper(secret)).update(recipient.trim().toLowerCase()).digest('hex');
}

/**
 * `alertId:CHANNEL:<recipientHash>`: unique per alert + channel + recipient without the address in clear (no PII in
 * NotificationLog."dedupeKey", in logs or in the SMTP Message-ID). Rotating JWT_SECRET changes the hash: only an alert
 * that is mid-delivery at that moment can then get one extra message per recipient already sent.
 */
export function dedupeKey(alertId: string, channel: string, recipient: string, secret: string | undefined = process.env.JWT_SECRET): string {
  return `${alertId}:${channel}:${recipientHash(recipient, secret)}`;
}

/** Recipient for log lines: `o***@example.com`, `+91*******01`, `user:1234…`. */
export function maskRecipient(recipient: string): string {
  const r = recipient.trim();
  const at = r.indexOf('@');
  if (at > 0) return `${r[0]}***${r.slice(at)}`;
  if (r.startsWith('user:')) return `${r.slice(0, 9)}…`;
  return r.length > 6 ? `${r.slice(0, 3)}${'*'.repeat(r.length - 5)}${r.slice(-2)}` : '***';
}

/** Stable, opaque reference derived from the dedupe key (sent to providers that accept a client reference). */
export function providerRef(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export interface LedgerRow {
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  nextAttemptAt: Date | null;
}

/**
 * What a worker may do with an existing row for its dedupe key:
 * - done: a final status (SENT / FAILED / SKIPPED) is recorded; never send again;
 * - busy: another worker holds a live lease; leave it alone (the alert stays un-notified and is swept again);
 * - takeover: the lease expired (the previous worker died or hung); send again (bounded duplicate risk 4);
 * - abandon: the lease expired too often; record FAILED without sending.
 *
 * A QUEUED row's `attempts` counts the runs that claimed it (1 for the first claim + 1 per takeover), because a run
 * that finishes replaces its placeholder with the real provider attempt count and leaves QUEUED.
 */
export function claimDecision(row: LedgerRow, now: Date): 'done' | 'busy' | 'takeover' | 'abandon' {
  if (row.status !== 'QUEUED') return 'done';
  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return 'busy';
  return row.attempts <= MAX_TAKEOVERS ? 'takeover' : 'abandon';
}

/** Recorded attempts when a run finishes: earlier interrupted runs (one each) + this run's provider attempts. */
export function finalAttempts(claimedAttempts: number, sendAttempts: number): number {
  return Math.max(0, claimedAttempts - 1) + Math.max(0, sendAttempts);
}

/**
 * After a job threw: retry (leave it pending for XAUTOCLAIM) or declare it DEAD. `deliveries` is the stream's
 * times_delivered (1 for the first read).
 */
export function onJobFailure(deliveries: number): 'retry' | 'dead' {
  return deliveries >= MAX_DELIVERIES ? 'dead' : 'retry';
}

/** A re-claimed job that already used its budget (e.g. it crashes the process every time) is DEAD without running. */
export function deadBeforeRun(deliveries: number): boolean {
  return deliveries > MAX_DELIVERIES;
}

export function deadReason(deliveries: number, lastError: string | null): string {
  return `dead after ${deliveries} deliveries${lastError ? `: ${lastError}` : ''}`.slice(0, 500);
}
