import { randomUUID } from 'node:crypto';
import { NotificationStatus, NotifyChannel, PrismaClient } from '@prisma/client';
import { claimDecision, finalAttempts, LEASE_MS, LedgerRow, MAX_TAKEOVERS } from './delivery-state';

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | 'notificationLog'>;

export interface ClaimInput {
  companyId: string;
  alertId: string;
  channel: NotifyChannel;
  recipient: string;
  templateId: string | null;
  subject: string | null;
  body: string;
  dedupeKey: string;
}

export type ClaimResult =
  | { kind: 'claimed'; id: string; attempts: number; takeover: boolean }
  | { kind: 'done' | 'busy' | 'abandoned' };

export interface FinishInput {
  status: Exclude<NotificationStatus, 'QUEUED'>;
  error: string | null;
  provider: string | null;
  providerMessageId?: string | null;
  /** Provider attempts made by this run (0 when nothing was sent, e.g. SKIPPED). */
  sendAttempts: number;
}

/**
 * Per-recipient ledger on NotificationLog (D6 G2). Lease times use the database clock (now()), so several notifier
 * hosts agree. Every state change is a conditional statement: two workers can never both own a row.
 */
export class NotificationLedger {
  constructor(private readonly db: Db) {}

  /**
   * Claim the row for `dedupeKey`: insert it as QUEUED with a lease, or take over an expired lease. Returns `done` when
   * a final status exists, `busy` when another worker holds a live lease, `abandoned` when the row used up its
   * takeovers (it is then recorded FAILED here).
   */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const inserted = await this.db.$queryRaw<{ id: string; attempts: number }[]>`
      INSERT INTO "NotificationLog" ("id", "companyId", "alertId", "channel", "recipient", "templateId", "subject", "body",
                                     "status", "attempts", "nextAttemptAt", "dedupeKey", "createdAt")
      VALUES (${randomUUID()}::uuid, ${input.companyId}::uuid, ${input.alertId}::uuid, ${input.channel}::"NotifyChannel",
              ${input.recipient}, ${input.templateId}::uuid, ${input.subject}, ${input.body}, 'QUEUED'::"NotificationStatus",
              1, now() + (${LEASE_MS}::int * interval '1 millisecond'), ${input.dedupeKey}, now() AT TIME ZONE 'UTC')
      ON CONFLICT ("dedupeKey") WHERE "dedupeKey" IS NOT NULL DO NOTHING
      RETURNING "id", "attempts"`;
    if (inserted.length) return { kind: 'claimed', id: inserted[0].id, attempts: inserted[0].attempts, takeover: false };

    const taken = await this.db.$queryRaw<{ id: string; attempts: number }[]>`
      UPDATE "NotificationLog"
         SET "attempts" = "attempts" + 1, "nextAttemptAt" = now() + (${LEASE_MS}::int * interval '1 millisecond')
       WHERE "dedupeKey" = ${input.dedupeKey} AND "status" = 'QUEUED'
         AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" < now()) AND "attempts" <= ${MAX_TAKEOVERS}
      RETURNING "id", "attempts"`;
    if (taken.length) return { kind: 'claimed', id: taken[0].id, attempts: taken[0].attempts, takeover: true };

    const row = await this.db.notificationLog.findFirst({ where: { dedupeKey: input.dedupeKey }, select: { id: true, status: true, attempts: true, nextAttemptAt: true } });
    if (!row) return { kind: 'busy' }; // deleted concurrently (retention): treat as someone else's; the sweep retries
    const decision = claimDecision(row as LedgerRow, await this.dbNow());
    if (decision === 'abandon') {
      await this.abandon(row.id);
      return { kind: 'abandoned' };
    }
    // 'takeover' here means the conditional UPDATE lost a race: another worker took it.
    return { kind: decision === 'done' ? 'done' : 'busy' };
  }

  /**
   * Lease a pre-rendered QUEUED row (test / reminder messages, no dedupe key) for sending. Same lease and takeover
   * budget as alert rows. Returns the claimed attempts, or null when the row is final, leased or abandoned.
   */
  async claimQueued(id: string): Promise<number | null> {
    const taken = await this.db.$queryRaw<{ attempts: number }[]>`
      UPDATE "NotificationLog"
         SET "attempts" = "attempts" + 1, "nextAttemptAt" = now() + (${LEASE_MS}::int * interval '1 millisecond')
       WHERE "id" = ${id}::uuid AND "status" = 'QUEUED'
         AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" < now()) AND "attempts" <= ${MAX_TAKEOVERS}
      RETURNING "attempts"`;
    if (taken.length) return taken[0].attempts;
    await this.abandon(id);
    return null;
  }

  /** Record the final status of a claimed row (only while it is still QUEUED: a takeover that finished first wins). */
  async finish(id: string, claimedAttempts: number, r: FinishInput): Promise<boolean> {
    const res = await this.db.notificationLog.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: r.status,
        error: r.error,
        provider: r.provider,
        providerMessageId: r.providerMessageId ?? null,
        attempts: finalAttempts(claimedAttempts, r.sendAttempts),
        nextAttemptAt: null,
        sentAt: r.status === 'SENT' ? new Date() : null,
      },
    });
    return res.count > 0;
  }

  /** A QUEUED row whose lease expired after MAX_TAKEOVERS takeovers is given up as FAILED (no further send). */
  private async abandon(id: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "NotificationLog"
         SET "status" = 'FAILED'::"NotificationStatus", "nextAttemptAt" = NULL,
             "error" = ${`abandoned after ${MAX_TAKEOVERS} lease takeovers`}
       WHERE "id" = ${id}::uuid AND "status" = 'QUEUED' AND "nextAttemptAt" < now() AND "attempts" > ${MAX_TAKEOVERS}`;
  }

  /** QUEUED rows of a DEAD job are closed as FAILED with the dead reason. */
  async failQueued(where: { alertId: string } | { ids: string[] }, reason: string): Promise<number> {
    const res = await this.db.notificationLog.updateMany({
      where: { status: 'QUEUED', ...('alertId' in where ? { alertId: where.alertId } : { id: { in: where.ids } }) },
      data: { status: 'FAILED', error: reason, nextAttemptAt: null },
    });
    return res.count;
  }

  private async dbNow(): Promise<Date> {
    const [{ now }] = await this.db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return now;
  }
}
