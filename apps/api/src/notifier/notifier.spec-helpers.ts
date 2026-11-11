/* Test-only fakes for NotifierService unit tests (not a spec file; never imported by production code). */
import { claimDecision, finalAttempts, LEASE_MS } from './delivery-state';
import type { ClaimInput, ClaimResult, FinishInput } from './notification-ledger';
import { NotifierService } from './notifier.service';
import type { SmsMessage, SmsProvider, SmsResult } from './sms';
import type { PushMessage, PushProvider, PushResult } from './push';
import type { MailMessage, MailResult } from '../auth/mailer.service';

export interface FakeRow extends ClaimInput {
  id: string;
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  nextAttemptAt: Date | null;
  error: string | null;
  provider: string | null;
  providerMessageId: string | null;
}

/** In-memory ledger with the same state machine as NotificationLedger (unique dedupe key, lease, takeovers). */
export class FakeLedger {
  rows = new Map<string, FakeRow>();
  now = () => new Date();
  private seq = 0;

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const row = this.rows.get(input.dedupeKey);
    if (!row) {
      const id = `log-${++this.seq}`;
      this.rows.set(input.dedupeKey, { ...input, id, status: 'QUEUED', attempts: 1, nextAttemptAt: new Date(this.now().getTime() + LEASE_MS), error: null, provider: null, providerMessageId: null });
      return { kind: 'claimed', id, attempts: 1, takeover: false };
    }
    const d = claimDecision(row, this.now());
    if (d === 'takeover') {
      row.attempts++;
      row.nextAttemptAt = new Date(this.now().getTime() + LEASE_MS);
      return { kind: 'claimed', id: row.id, attempts: row.attempts, takeover: true };
    }
    if (d === 'abandon') {
      row.status = 'FAILED';
      row.error = 'abandoned after 3 lease takeovers';
      return { kind: 'abandoned' };
    }
    return { kind: d };
  }

  async claimQueued(): Promise<number | null> {
    return 1;
  }

  async finish(id: string, claimed: number, r: FinishInput): Promise<boolean> {
    const row = [...this.rows.values()].find((x) => x.id === id);
    if (!row || row.status !== 'QUEUED') return false;
    Object.assign(row, { status: r.status, error: r.error, provider: r.provider, providerMessageId: r.providerMessageId ?? null, attempts: finalAttempts(claimed, r.sendAttempts), nextAttemptAt: null });
    return true;
  }

  /** Simulates lease expiry (time passing beyond LEASE_MS). */
  expireLeases(): void {
    for (const r of this.rows.values()) if (r.status === 'QUEUED') r.nextAttemptAt = new Date(this.now().getTime() - 1);
  }

  get list(): FakeRow[] {
    return [...this.rows.values()];
  }
}

/** SMS provider that records accepted messages; behaviour per call. */
export class FakeSms implements SmsProvider {
  readonly name: string;
  accepted: SmsMessage[] = [];
  calls = 0;
  constructor(
    readonly configured: boolean,
    private readonly behave: (m: SmsMessage, call: number) => Promise<SmsResult> | SmsResult = (_m, n) => ({ provider: 'fake', messageId: `SMS-${n}` }),
    name = configured ? 'fake' : 'console',
  ) {
    this.name = name;
  }
  async send(m: SmsMessage): Promise<SmsResult> {
    const n = ++this.calls;
    const r = await this.behave(m, n);
    this.accepted.push(m);
    return r;
  }
}

export class FakePush implements PushProvider {
  readonly name = 'expo';
  calls = 0;
  constructor(
    readonly enabled: boolean,
    private readonly behave: () => Promise<PushResult> | PushResult = () => ({ sent: 1, invalidTokens: [], error: null, ticketIds: ['TKT-1'] }),
  ) {}
  async send(_tokens: string[], _m: PushMessage): Promise<PushResult> {
    this.calls++;
    return this.behave();
  }
}

export class FakeMailer {
  sent: MailMessage[] = [];
  constructor(
    public provider: string | null,
    private readonly behave: (m: MailMessage) => Promise<MailResult> | MailResult = (m) => ({ provider: this.provider, messageId: m.messageId ?? 'zoho-req-1', file: '' }),
  ) {}
  async sendWithResult(m: MailMessage): Promise<MailResult> {
    const r = await this.behave(m);
    this.sent.push(m);
    return r;
  }
  async send(m: MailMessage): Promise<string> {
    return (await this.sendWithResult(m)).file;
  }
}

export function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    alert: { findUnique: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    notificationLog: { count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })), findMany: jest.fn(async () => []) },
    messagingSettings: { findUnique: jest.fn(async () => null) },
    pushToken: { findMany: jest.fn(async () => [{ token: 'ExponentPushToken[a]' }]), deleteMany: jest.fn() },
    messageTemplate: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    ...over,
  };
}

export function fakeRedis() {
  return { client: { xack: jest.fn(async () => 1), pipeline: () => ({ xpending: jest.fn(), exec: jest.fn(async () => []) }) } };
}

/** NotifierService wired to fakes. */
export function makeNotifier(opts: { prisma?: ReturnType<typeof fakePrisma>; redis?: ReturnType<typeof fakeRedis>; mailer?: FakeMailer; sms?: SmsProvider; push?: PushProvider; webhooks?: unknown } = {}) {
  const prisma = opts.prisma ?? fakePrisma();
  const redis = opts.redis ?? fakeRedis();
  const mailer = opts.mailer ?? new FakeMailer(null);
  const geocoding = { enabled: false };
  const svc = new NotifierService(prisma as never, redis as never, mailer as never, geocoding as never, opts.webhooks as never);
  const ledger = new FakeLedger();
  const internals = svc as unknown as Record<string, unknown>;
  internals.ledger = ledger;
  if (opts.sms) internals.sms = opts.sms;
  if (opts.push) internals.push = opts.push;
  return { svc, prisma, redis, mailer, ledger, internals };
}
