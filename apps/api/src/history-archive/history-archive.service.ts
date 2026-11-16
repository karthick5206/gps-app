import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import {
  HISTORY_RESTORE_MAX_DAYS,
  historyArchiveOf,
  HistoryArchiveHealthDto,
  HistoryArchiveRunStats,
  HistoryArchiveStatusDto,
  HistoryRestoreResult,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { allCompaniesOr, hasPermission, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { daysBetween, isDayKey } from '../summarizer/tz';
import { archiveDir, resolveArchivePath } from './archive-file';
import { ArchiveEngine, toArchivedDayDto } from './archive-engine';
import { archiveRunDeadline, enabledCompanies } from './archive-select';
import { ARCHIVE_OVERDUE_DAYS_DEFAULT } from './archive-engine';

/** Lock file present while an archive run writes files (see writeRunningFile). */
export const RUNNING_FILE = '.running';

export const ARCHIVE_LOCK_KEY = 'vt:history-archive:lock';
export const ARCHIVE_RESTORE_LOCK_KEY = 'vt:history-archive:restore-lock';
export const ARCHIVE_LAST_RUN_KEY = 'vt:history-archive:last';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** HISTORY_ARCHIVE=off stops archiving and restoring (kill switch). */
export const historyArchiveJobOn = (env: NodeJS.ProcessEnv = process.env) => (env.HISTORY_ARCHIVE ?? 'on').trim().toLowerCase() !== 'off';

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/**
 * History archiving (api process): the nightly archive job (single runner: Valkey lock + ArchivedDay claim rows), the
 * restore worker (every 15 s), restore requests and the System Health snapshot.
 *
 * Env: HISTORY_ARCHIVE (on | off), HISTORY_ARCHIVE_DIR (default /var/lib/veetrax/history-archive),
 * HISTORY_ARCHIVE_HOUR (UTC hour the nightly run starts, default 2; never between 21:00 and 22:30 UTC, the backup window),
 * HISTORY_ARCHIVE_OVERDUE_DAYS (points older than afterDays + this, not archived = CRITICAL, default 30), HISTORY_ARCHIVE_BUDGET_MIN (run length,
 * default 120; the rest continues the next night), HISTORY_ARCHIVE_PAUSE_MS (pause between vehicle-days, default 200).
 */
@Injectable()
export class HistoryArchiveService {
  private readonly logger = new Logger('HistoryArchive');
  private readonly instance = randomUUID();
  readonly enabled = historyArchiveJobOn();
  private readonly hour = num(process.env.HISTORY_ARCHIVE_HOUR, 2, 0, 23);
  private readonly budgetMs = num(process.env.HISTORY_ARCHIVE_BUDGET_MIN, 120, 1, 23 * 60) * 60_000;
  readonly engine: ArchiveEngine;
  private running = false;
  private restoring = false;
  private lastRunDay: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {
    this.engine = new ArchiveEngine(prisma, {
      dir: archiveDir(),
      pauseMs: num(process.env.HISTORY_ARCHIVE_PAUSE_MS, 200, 0, 60_000),
      overdueDays: num(process.env.HISTORY_ARCHIVE_OVERDUE_DAYS, ARCHIVE_OVERDUE_DAYS_DEFAULT, 1, 3650),
    });
  }

  // ───────────────────────── schedules ─────────────────────────

  /** Every 10 min: start the nightly run once per day in the configured hour (UTC). */
  @Interval(10 * 60_000)
  async nightly(): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== this.hour || this.lastRunDay === today) return;
    this.lastRunDay = today;
    await this.runOnce();
  }

  /** Runs the archive pass now (single runner across api instances). Returns null when another run holds the lock. */
  async runOnce(): Promise<HistoryArchiveRunStats | null> {
    if (this.running) return null;
    this.running = true;
    let locked = false;
    try {
      // Never during the nightly file backup (21:00–22:30 UTC), and never running into it.
      const deadline = archiveRunDeadline(Date.now(), this.budgetMs);
      if (deadline === null) {
        this.logger.warn('History archive run not started: inside the backup window (21:00–22:30 UTC)');
        return null;
      }
      locked = (await this.redis.client.set(ARCHIVE_LOCK_KEY, this.instance, 'PX', this.budgetMs + 15 * 60_000, 'NX')) === 'OK';
      if (!locked) return null;
      await this.writeRunningFile(deadline);
      const stats = await this.engine.run(deadline);
      await this.redis.client.set(ARCHIVE_LAST_RUN_KEY, JSON.stringify(stats));
      if (stats.archivedDays || stats.failures) {
        this.logger.log(`Archived ${stats.archivedDays} vehicle-days (${stats.points} points, ${stats.bytes} bytes), ${stats.failures} failed${stats.complete ? '' : ', time budget reached (continues next night)'}`);
      }
      return stats;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`History archive run failed: ${message}`);
      const at = new Date().toISOString();
      await this.redis.client
        .set(ARCHIVE_LAST_RUN_KEY, JSON.stringify({ startedAt: at, finishedAt: at, complete: false, archivedDays: 0, points: 0, bytes: 0, failures: 1, reArchived: 0, backlogObjects: 0, lastError: message } satisfies HistoryArchiveRunStats))
        .catch(() => undefined);
      return null;
    } finally {
      if (locked) {
        await fsp.rm(path.join(this.engine.dir, RUNNING_FILE), { force: true }).catch(() => undefined);
        await this.redis.client.eval(RELEASE_LOCK, 1, ARCHIVE_LOCK_KEY, this.instance).catch(() => undefined);
      }
      this.running = false;
    }
  }

  /**
   * `<HISTORY_ARCHIVE_DIR>/.running` while a run writes files: JSON { pid, host, startedAt, deadline }. A backup that
   * finds it may wait until it is gone, or treat it as stale once `deadline` + 15 min has passed.
   */
  private async writeRunningFile(deadline: number): Promise<void> {
    try {
      await fsp.mkdir(this.engine.dir, { recursive: true });
      await fsp.writeFile(path.join(this.engine.dir, RUNNING_FILE), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), deadline: new Date(deadline).toISOString() }));
    } catch (e) {
      this.logger.warn(`Could not write ${RUNNING_FILE}: ${(e as Error).message}`);
    }
  }

  @Timeout(90_000)
  firstRestore(): Promise<void> {
    return this.restoreTick();
  }

  /** Restore worker: queued days, a few at a time. */
  @Interval(15_000)
  async restoreTick(): Promise<void> {
    if (!this.enabled || this.restoring) return;
    this.restoring = true;
    let locked = false;
    try {
      if (!(await this.prisma.archivedDay.count({ where: { status: 'RESTORING' } }))) return;
      locked = (await this.redis.client.set(ARCHIVE_RESTORE_LOCK_KEY, this.instance, 'PX', 5 * 60_000, 'NX')) === 'OK';
      if (!locked) return;
      const r = await this.engine.restorePending(20, Date.now() + 3 * 60_000);
      if (r.failed) this.logger.warn(`History restore: ${r.restored} days restored, ${r.failed} failed (retried)`);
    } catch (error) {
      this.logger.error(`History restore failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, ARCHIVE_RESTORE_LOCK_KEY, this.instance).catch(() => undefined);
      this.restoring = false;
    }
  }

  // ───────────────────────── API ─────────────────────────

  /** history:command (company admins) or Super Admin. */
  private assertRestore(ctx: AuthContext): void {
    if (!ctx.isSuperAdmin && !hasPermission(ctx, 'history', 'command')) throw new ForbiddenException('Restoring archived history needs the History "command" permission');
  }

  private async objectIn(ctx: AuthContext, objectId: string): Promise<{ id: string; companyId: string; tz: string }> {
    const o = await this.prisma.trackedObject.findFirst({ where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] }, select: { id: true, companyId: true, company: { select: { timezone: true } } } });
    if (!o) throw new NotFoundException('Object not found');
    return { id: o.id, companyId: o.companyId, tz: o.company.timezone };
  }

  private checkDays(from: string, to: string): void {
    if (!isDayKey(from) || !isDayKey(to)) throw new BadRequestException('from and to must be dates (YYYY-MM-DD)');
    if (to < from) throw new BadRequestException('to must not be before from');
    if (daysBetween(from, to) >= HISTORY_RESTORE_MAX_DAYS) throw new BadRequestException(`Range too long (max ${HISTORY_RESTORE_MAX_DAYS} days)`);
  }

  async restore(ctx: AuthContext, body: { objectId?: string; from: string; to: string; keepDays?: number }): Promise<HistoryRestoreResult> {
    this.assertRestore(ctx);
    this.checkDays(body.from, body.to);
    let companyId = ctx.companyId;
    let objectIds: string[] | null = null;
    if (body.objectId) {
      const o = await this.objectIn(ctx, body.objectId);
      companyId = o.companyId;
      objectIds = [o.id];
    } else if (ctx.dataScope !== 'COMPANY' && !ctx.isSuperAdmin) {
      // A whole-company restore is for users who see the whole company; others restore the vehicles they can see.
      objectIds = (await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } })).map((o) => o.id);
    }
    const r = await this.engine.requestRestore(companyId, objectIds, body.from, body.to, ctx.userId, body.keepDays);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'history_archive', entityId: body.objectId ?? companyId, details: { restore: true, from: body.from, to: body.to, keepDays: body.keepDays ?? null, ...r } });
    void this.restoreTick();
    return r;
  }

  /** Archive rows of one vehicle (history page: archived days and restore progress). */
  async days(ctx: AuthContext, objectId: string, from: string, to: string) {
    this.checkDays(from, to);
    const o = await this.objectIn(ctx, objectId);
    return (await this.engine.daysOf(o.id, from, to)) ?? { days: [], archivedDays: 0, restoring: 0 };
  }

  async status(ctx: AuthContext): Promise<HistoryArchiveStatusDto> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } });
    const [groups, agg, oldest, newest] = await Promise.all([
      this.prisma.archivedDay.groupBy({ by: ['status'], where: { companyId: ctx.companyId }, _count: { _all: true } }),
      this.prisma.archivedDay.aggregate({ where: { companyId: ctx.companyId, filePath: { not: null } }, _sum: { pointCount: true, bytes: true } }),
      this.prisma.archivedDay.findFirst({ where: { companyId: ctx.companyId, filePath: { not: null } }, orderBy: { day: 'asc' }, select: { day: true } }),
      this.prisma.archivedDay.findFirst({ where: { companyId: ctx.companyId, filePath: { not: null } }, orderBy: { day: 'desc' }, select: { day: true } }),
    ]);
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    return {
      settings: historyArchiveOf(company.settings),
      archivedDays: count('ARCHIVED'),
      restoringDays: count('RESTORING'),
      restoredDays: count('RESTORED'),
      failedDays: count('FAILED'),
      points: agg._sum.pointCount ?? 0,
      bytes: agg._sum.bytes ?? 0,
      oldestDay: oldest ? oldest.day.toISOString().slice(0, 10) : null,
      newestDay: newest ? newest.day.toISOString().slice(0, 10) : null,
    };
  }

  /** Recent failures of a company (Super Admin / admins diagnosing). */
  async failures(ctx: AuthContext) {
    const rows = await this.prisma.archivedDay.findMany({ where: { companyId: ctx.companyId, lastError: { not: null } }, orderBy: { updatedAt: 'desc' }, take: 50 });
    return rows.map(toArchivedDayDto);
  }

  // ───────────────────────── health ─────────────────────────

  async health(): Promise<HistoryArchiveHealthDto> {
    const dir = this.engine.dir;
    const [companies, raw, failedDays, lastFailed, restoring, agg, disk] = await Promise.all([
      this.prisma.company.findMany({ select: { id: true, timezone: true, settings: true } }).then((rows) => enabledCompanies(rows).length),
      this.redis.client.get(ARCHIVE_LAST_RUN_KEY).catch(() => null),
      this.prisma.archivedDay.count({ where: { OR: [{ status: 'FAILED' }, { lastError: { not: null } }] } }),
      this.prisma.archivedDay.findFirst({ where: { lastError: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { lastError: true } }),
      this.prisma.archivedDay.count({ where: { status: 'RESTORING' } }),
      this.prisma.archivedDay.aggregate({ where: { filePath: { not: null } }, _sum: { bytes: true } }),
      fsp.statfs(dir).then(
        (s) => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }),
        () => null,
      ),
    ]);
    let lastRun: HistoryArchiveRunStats | null = null;
    try {
      lastRun = raw ? (JSON.parse(raw) as HistoryArchiveRunStats) : null;
    } catch {
      lastRun = null;
    }
    return {
      jobEnabled: this.enabled,
      companies,
      lastRun,
      failedDays,
      lastError: lastFailed?.lastError ?? lastRun?.lastError ?? null,
      restoring,
      dir,
      archiveBytes: agg._sum.bytes ?? 0,
      diskTotal: disk?.total ?? null,
      diskFree: disk?.free ?? null,
    };
  }

  // ───────────────────────── purge ─────────────────────────

  /** Relative file paths of a company's or vehicles' archive (read before the purge transaction). */
  async filesOf(where: { companyId?: string; objectIds?: string[] }): Promise<string[]> {
    if (!where.companyId && !where.objectIds?.length) return [];
    const rows = await this.prisma.archivedDay.findMany({
      where: { filePath: { not: null }, ...(where.companyId ? { companyId: where.companyId } : { objectId: { in: where.objectIds } }) },
      select: { filePath: true },
    });
    return rows.map((r) => r.filePath!);
  }

  /** Deletes archive files (after the purge committed) and the emptied vehicle / company directories. */
  async deleteFiles(files: string[], dirs: string[]): Promise<number> {
    let n = 0;
    for (const rel of files) {
      try {
        await fsp.rm(resolveArchivePath(this.engine.dir, rel), { force: true });
        n++;
      } catch (e) {
        this.logger.warn(`Purge: archive file ${rel} not removed: ${(e as Error).message}`);
      }
    }
    for (const rel of dirs) await fsp.rm(resolveArchivePath(this.engine.dir, rel), { recursive: true, force: true }).catch(() => undefined);
    return n;
  }

}
