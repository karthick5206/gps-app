import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { NOTIFY_STREAM_MAXLEN } from '../alerts/alert-dto';
import { RedisKeys } from '../redis/keys';

/** Same literal as the partial index "Alert_notify_pending_idx" (migration 20261114070000_notifier_durability). */
export const NOTIFY_SWEEP_FLOOR = '2026-11-01 00:00:00';
/** pg advisory lock id: only one notifier instance sweeps at a time. */
export const NOTIFY_SWEEP_LOCK = 0x76_74_6e_73; // "vtns"

export interface SweeperOptions {
  intervalMs: number;
  /** Alerts younger than this are left to the normal stream path. */
  minAgeMs: number;
  /** Sweep window (owner decision Q5: 24 h). */
  windowMs: number;
  /** Pre-rendered QUEUED messages younger than this are left to their own job. */
  logMinAgeMs: number;
  batch: number;
  /** Skip the sweep while the notifier group's lag + pending exceeds this. */
  maxBacklog: number;
  /** Re-queue one id at most once per this interval. */
  requeueEveryMs: number;
  streamKey: string;
  group: string;
}

export const DEFAULT_SWEEPER_OPTIONS: SweeperOptions = {
  intervalMs: 30_000,
  minAgeMs: 60_000,
  windowMs: 24 * 3600_000,
  logMinAgeMs: 5 * 60_000,
  batch: 500,
  maxBacklog: 1000,
  requeueEveryMs: 5 * 60_000,
  streamKey: RedisKeys.notifyStream,
  group: RedisKeys.notifierGroup,
};

export interface SweepResult {
  skipped?: 'lock' | 'backlog' | 'running';
  alerts: number;
  logs: number;
}

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;

/**
 * D6 G2 safety net for every producer: alerts committed to PostgreSQL whose `vt:notify` job was lost (XADD failed,
 * process crash between commit and XADD, Valkey restart without persistence, stream trimmed) are re-queued until the
 * notifier marks them notifiedAt or DEAD. Pre-rendered QUEUED messages are re-queued the same way.
 *
 * Bounded: one indexed query of at most `batch` rows per tick, one instance at a time (advisory lock), paused while
 * the notifier is behind, and each id at most once per `requeueEveryMs`. If Valkey is down the XADD fails and the next
 * tick retries; nothing is lost because the alert stays un-notified in PostgreSQL.
 */
export class NotifySweeper {
  private readonly logger = new Logger('NotifySweeper');
  private readonly opts: SweeperOptions;
  private readonly recent = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly totals = { ticks: 0, alerts: 0, logs: 0, errors: 0 };
  /** Last sweep that held the lock: alerts without a finished job it found (≤ batch) and when (notifier metrics). */
  private last: { found: number; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    opts: Partial<SweeperOptions> = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULT_SWEEPER_OPTIONS, ...opts };
  }

  /** For NotifierMetrics (D6 G2): null until this instance swept once (another instance may hold the lock). */
  stats(): { unnotifiedAlerts: number | null; lastSweepAt: string | null; sweptAlerts: number } {
    return { unnotifiedAlerts: this.last?.found ?? null, lastSweepAt: this.last ? new Date(this.last.at).toISOString() : null, sweptAlerts: this.totals.alerts };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: Error) => {
        this.totals.errors++;
        this.logger.warn(`Sweep failed (retried next tick): ${error.message}`);
      });
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<SweepResult> {
    if (this.running) return { skipped: 'running', alerts: 0, logs: 0 };
    this.running = true;
    try {
      this.totals.ticks++;
      if ((await this.backlog()) > this.opts.maxBacklog) return { skipped: 'backlog', alerts: 0, logs: 0 };
      return await this.db.$transaction(
        async (tx) => {
          // Transaction-scoped lock: released at commit / rollback on whichever pooled connection ran it.
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${NOTIFY_SWEEP_LOCK}::bigint) AS locked`;
          if (!locked) return { skipped: 'lock' as const, alerts: 0, logs: 0 };
          const alerts = await this.sweepAlerts(tx);
          const logs = await this.sweepLogs(tx);
          return { alerts, logs };
        },
        { timeout: 20_000, maxWait: 5_000 },
      );
    } finally {
      this.running = false;
    }
  }

  /** lag + pending of the notifier group; 0 when the stream / group does not exist (yet). */
  async backlog(): Promise<number> {
    let groups: unknown[];
    try {
      groups = (await this.redis.xinfo('GROUPS', this.opts.streamKey)) as unknown[];
    } catch (error) {
      if (/no such key/i.test((error as Error).message)) return 0;
      throw error;
    }
    for (const g of groups) {
      const fields = g as (string | number | null)[];
      const info: Record<string, string | number | null> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) info[String(fields[i])] = fields[i + 1];
      if (info.name === this.opts.group) return (Number(info.lag) || 0) + (Number(info.pending) || 0);
    }
    return 0;
  }

  private async sweepAlerts(tx: Tx): Promise<number> {
    // "createdAt" is a timestamp without time zone holding UTC: every producer writes UTC (Prisma, and the processor's
    // raw INSERT sets it to now() AT TIME ZONE 'UTC'), and the bounds are now() AT TIME ZONE 'UTC', so the comparison
    // does not depend on the session TimeZone. The floor literal must match the partial index.
    const rows = await tx.$queryRaw<{ id: string; companyId: string }[]>`
      SELECT "id", "companyId" FROM "Alert"
       WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL
         AND "createdAt" >= TIMESTAMP ${Prisma.raw(`'${NOTIFY_SWEEP_FLOOR}'`)}
         AND "createdAt" < (now() AT TIME ZONE 'UTC') - (${this.opts.minAgeMs}::int * interval '1 millisecond')
         AND "createdAt" > (now() AT TIME ZONE 'UTC') - (${this.opts.windowMs}::bigint * interval '1 millisecond')
       ORDER BY "createdAt"
       LIMIT ${this.opts.batch}`;
    this.last = { found: rows.length, at: this.clock() };
    const due = rows.filter((r) => this.due(`a:${r.id}`));
    if (!due.length) return 0;
    const pipeline = this.redis.pipeline();
    for (const r of due) pipeline.xadd(this.opts.streamKey, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', r.id, 'companyId', r.companyId, 'swept', '1');
    await this.exec(pipeline);
    const now = this.clock();
    for (const r of due) this.recent.set(`a:${r.id}`, now);
    this.totals.alerts += due.length;
    this.logger.warn(`Re-queued ${due.length} alert(s) without a finished notification job`);
    return due.length;
  }

  /**
   * Pre-rendered QUEUED messages: rows without a dedupeKey (test messages, reminders) and, since ETMS E5 (QA B3), rows
   * that belong to no alert whatever their dedupeKey (ETMS pushes `etms:<id>:PUSH`). Alert recipient rows with a G2
   * dedupeKey stay excluded: their alert is re-queued by sweepAlerts and the alert path (claim / takeover / DEAD after
   * MAX_DELIVERIES) owns them, so they are never also sent as a pre-rendered job. A re-queued row is still claimed with
   * a lease (claimQueued) before sending, so a duplicate job never sends it twice.
   */
  private async sweepLogs(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string; companyId: string }[]>`
      SELECT "id", "companyId" FROM "NotificationLog"
       WHERE "status" = 'QUEUED' AND ("dedupeKey" IS NULL OR "alertId" IS NULL)
         AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" < now())
         AND "createdAt" < (now() AT TIME ZONE 'UTC') - (${this.opts.logMinAgeMs}::int * interval '1 millisecond')
         AND "createdAt" > (now() AT TIME ZONE 'UTC') - (${this.opts.windowMs}::bigint * interval '1 millisecond')
       ORDER BY "createdAt"
       LIMIT ${this.opts.batch}`;
    const due = rows.filter((r) => this.due(`l:${r.id}`));
    if (!due.length) return 0;
    const byCompany = new Map<string, string[]>();
    for (const r of due) byCompany.set(r.companyId, [...(byCompany.get(r.companyId) ?? []), r.id]);
    const pipeline = this.redis.pipeline();
    for (const [companyId, ids] of byCompany) {
      for (let i = 0; i < ids.length; i += 50) {
        pipeline.xadd(this.opts.streamKey, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'logIds', JSON.stringify(ids.slice(i, i + 50)), 'companyId', companyId, 'swept', '1');
      }
    }
    await this.exec(pipeline);
    const now = this.clock();
    for (const r of due) this.recent.set(`l:${r.id}`, now);
    this.totals.logs += due.length;
    this.logger.warn(`Re-queued ${due.length} pre-rendered message(s) still QUEUED`);
    return due.length;
  }

  /** In-memory throttle: an id is re-queued at most once per requeueEveryMs (expired entries are pruned). */
  private due(key: string): boolean {
    const now = this.clock();
    if (this.recent.size > 10_000) for (const [k, at] of this.recent) if (now - at >= this.opts.requeueEveryMs) this.recent.delete(k);
    const at = this.recent.get(key);
    return at === undefined || now - at >= this.opts.requeueEveryMs;
  }

  private async exec(pipeline: ReturnType<Redis['pipeline']>): Promise<void> {
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) throw failed[0];
  }
}
