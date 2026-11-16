/**
 * History archiving engine: database + files, no scheduling (HistoryArchiveService adds the locks and the timers; the DB
 * test drives this class directly).
 *
 * Archive unit = one vehicle-day (company-local day): claim the ArchivedDay row → read the day's points → merge with an
 * existing file (late points, re-archive after a restore) → write + verify the file (a rewrite gets a new versioned
 * name) → in ONE short transaction, under the per-vehicle lock shared with the summarizer: re-check the summarizer is
 * done with the day, switch the row to the new file and delete exactly the points that were written (primary key +
 * day bounds, in batches; every one must still be there). Nothing is deleted unless the file was verified; any failure
 * or change meanwhile leaves every point in the database and removes the file it wrote.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  ArchivedDayDto,
  ArchivedDayStatus,
  HISTORY_RESTORE_KEEP_DAYS_DEFAULT,
  HISTORY_RESTORE_KEEP_DAYS_MAX,
  HistoryArchiveInfo,
  HistoryArchiveRunStats,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import {
  ArchiveFileError,
  ArchivePoint,
  archiveRelPath,
  ArchiveWriter,
  fileArchiveWriter,
  mergePoints,
  readArchiveFile,
  resolveArchivePath,
  verifyArchiveFile,
} from './archive-file';
import { lockArchiveObjects } from './archive-lock';
import { archiveCutoffDay, ArchiveCompany, dayDecision, enabledCompanies, isSummarised, vehicleWide } from './archive-select';
import { addDays, localDayKey, localDayRange } from '../summarizer/tz';

const DAY_MS = 86_400_000;
/** Points deleted / inserted per statement. */
export const ARCHIVE_BATCH = 5_000;
/** Restore attempts before a day goes back to ARCHIVED with the error. */
const RESTORE_MAX_ATTEMPTS = 5;
/** Default HISTORY_ARCHIVE_OVERDUE_DAYS: points older than afterDays + this, still not archived = CRITICAL. */
export const ARCHIVE_OVERDUE_DAYS_DEFAULT = 30;

type Db = PrismaClient | Prisma.TransactionClient;

export interface EngineOptions {
  dir: string;
  writer?: ArchiveWriter;
  /** Pause between vehicle-days (keeps the job at low priority next to live traffic). */
  pauseMs?: number;
  now?: () => number;
  overdueDays?: number;
  /** Test hook: runs after the file is written and before the delete transaction. */
  beforeCommit?: (objectId: string, day: string) => Promise<void>;
}

interface DayRow {
  id: string;
  companyId: string;
  objectId: string;
  day: Date;
  status: ArchivedDayStatus;
  filePath: string | null;
  pointCount: number;
  checksum: string | null;
  keepUntil: Date | null;
  claimedAt: Date | null;
  updatedAt: Date;
  restoreKeepDays: number | null;
  attempts: number;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);
const newVersion = () => `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

/** The summarizer touched the vehicle between selection and commit: retried next run, not a failure. */
class Deferred extends Error {}

export function toArchivedDayDto(r: { objectId: string; day: Date; status: ArchivedDayStatus; pointCount: number; bytes: number; archivedAt: Date | null; restoredAt: Date | null; keepUntil: Date | null; lastError: string | null }): ArchivedDayDto {
  return {
    objectId: r.objectId,
    day: dayKey(r.day),
    status: r.status,
    pointCount: r.pointCount,
    bytes: r.bytes,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    restoredAt: r.restoredAt?.toISOString() ?? null,
    keepUntil: r.keepUntil?.toISOString() ?? null,
    error: r.lastError,
  };
}

/** Points of a row are not in the database right now. */
export function isOffline(r: { status: ArchivedDayStatus; filePath: string | null }): boolean {
  return r.status === 'ARCHIVED' || r.status === 'RESTORING' || ((r.status === 'CLAIMED' || r.status === 'FAILED') && r.filePath !== null);
}

export type UnitResult = { kind: 'archived'; points: number; bytes: number; reArchived: boolean } | { kind: 'failed'; error: string } | { kind: 'deferred' } | { kind: 'skipped' };

export class ArchiveEngine {
  readonly dir: string;
  private readonly writer: ArchiveWriter;
  private readonly pauseMs: number;
  private readonly now: () => number;
  private readonly overdueDays: number;
  private readonly beforeCommit?: EngineOptions['beforeCommit'];

  constructor(
    private readonly prisma: PrismaClient,
    opts: EngineOptions,
  ) {
    this.dir = opts.dir;
    this.writer = opts.writer ?? fileArchiveWriter;
    this.pauseMs = opts.pauseMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.overdueDays = opts.overdueDays ?? ARCHIVE_OVERDUE_DAYS_DEFAULT;
    this.beforeCommit = opts.beforeCommit;
  }

  // ───────────────────────── archive run ─────────────────────────

  /** One pass over every enabled company (and expired restores of any company), until done or `deadline`. */
  async run(deadline = Infinity): Promise<HistoryArchiveRunStats> {
    const startedAt = new Date(this.now()).toISOString();
    const stats: HistoryArchiveRunStats = {
      startedAt,
      finishedAt: startedAt,
      complete: true,
      archivedDays: 0,
      points: 0,
      bytes: 0,
      failures: 0,
      reArchived: 0,
      backlogObjects: 0,
      blockedObjects: 0,
      blockedDirty: 0,
      blockedNotSummarised: 0,
      blockedFailed: 0,
      overdueObjects: 0,
      deferred: 0,
      lastError: null,
    };
    const tally = (r: UnitResult) => {
      if (r.kind === 'archived') {
        stats.archivedDays++;
        stats.points += r.points;
        stats.bytes += r.bytes;
        if (r.reArchived) stats.reArchived++;
      } else if (r.kind === 'failed') {
        stats.failures++;
        stats.lastError = r.error;
      } else if (r.kind === 'deferred') stats.deferred!++;
    };

    // Restored days whose keep period is over go back to the archive (every company: a restore is temporary).
    const expired = await this.prisma.archivedDay.findMany({ where: { status: 'RESTORED', keepUntil: { lt: new Date(this.now()) } }, orderBy: { keepUntil: 'asc' }, take: 10_000 });
    const tzOf = new Map((await this.prisma.company.findMany({ where: { id: { in: [...new Set(expired.map((e) => e.companyId))] } }, select: { id: true, timezone: true } })).map((c) => [c.id, c.timezone]));
    for (const e of expired) {
      if (this.now() > deadline) {
        stats.complete = false;
        break;
      }
      const day = dayKey(e.day);
      // Restored days are old: the "older than afterDays + 1" idle rule always applies to them.
      tally(await this.archiveDay(e.companyId, tzOf.get(e.companyId) ?? 'UTC', e.objectId, day, e, addDays(day, 2)));
    }

    const companies = enabledCompanies(await this.prisma.company.findMany({ select: { id: true, timezone: true, settings: true } }));
    for (const c of companies) {
      if (!stats.complete) break;
      const r = await this.runCompany(c, deadline, tally, stats);
      stats.backlogObjects += r.backlog;
      if (!r.complete) stats.complete = false;
    }
    stats.finishedAt = new Date(this.now()).toISOString();
    return stats;
  }

  private async runCompany(c: ArchiveCompany, deadline: number, tally: (r: UnitResult) => void, stats: HistoryArchiveRunStats): Promise<{ complete: boolean; backlog: number }> {
    const now = this.now();
    const tz = c.timezone;
    const cutoffDay = archiveCutoffDay(now, c.settings.afterDays, tz);
    const cutoffMs = localDayRange(cutoffDay, tz).start;
    const overdueMs = now - (c.settings.afterDays + this.overdueDays) * DAY_MS;
    const objects = await this.prisma.trackedObject.findMany({ where: { companyId: c.id }, select: { id: true }, orderBy: { id: 'asc' } });
    const ids = objects.map((o) => o.id);
    const [cursors, dirty, last] = await Promise.all([
      this.prisma.summaryCursor.findMany({ where: { objectId: { in: ids } }, select: { objectId: true, processedUntil: true } }),
      this.prisma.summaryDirtyDay.findMany({ where: { objectId: { in: ids } }, select: { objectId: true }, distinct: ['objectId'] }),
      this.lastPoints(ids),
    ]);
    const processed = new Map(cursors.map((r) => [r.objectId, r.processedUntil.getTime()]));
    const dirtySet = new Set(dirty.map((d) => d.objectId));
    let backlog = 0;
    for (let i = 0; i < ids.length; i++) {
      const objectId = ids[i];
      let after = 0;
      let blocked: 'dirty' | 'not-summarised' | 'failed' | null = null;
      let overdue = false;
      for (;;) {
        const t = await this.oldestBefore(objectId, after, cutoffMs);
        if (t === null) break;
        if (this.now() > deadline) {
          // This vehicle and every one not visited yet may still hold archivable days.
          backlog += ids.length - i;
          return { complete: false, backlog };
        }
        const day = localDayKey(t, tz);
        const range = localDayRange(day, tz);
        const existing = await this.prisma.archivedDay.findUnique({ where: { objectId_day: { objectId, day: dayDate(day) } } });
        const decision = dayDecision({
          day,
          cutoffDay,
          dayEndMs: range.end,
          processedUntilMs: processed.get(objectId) ?? null,
          lastPointMs: last.get(objectId) ?? null,
          hasDirty: dirtySet.has(objectId),
          existing: existing ? { status: existing.status, keepUntilMs: existing.keepUntil?.getTime() ?? null, claimedAtMs: existing.claimedAt?.getTime() ?? null, attempts: existing.attempts, updatedAtMs: existing.updatedAt.getTime() } : null,
          now: this.now(),
        });
        if (vehicleWide(decision)) {
          if (decision === 'dirty' || decision === 'not-summarised') blocked = decision;
          if (range.start < overdueMs) overdue = true;
          break;
        }
        if (decision === 'failed-backoff') {
          blocked ??= 'failed';
          if (range.start < overdueMs) overdue = true;
        }
        if (decision === 'archive') {
          const r = await this.archiveDay(c.id, tz, objectId, day, existing, cutoffDay);
          tally(r);
          if (r.kind === 'failed' || r.kind === 'deferred') {
            if (r.kind === 'failed') blocked ??= 'failed';
            if (range.start < overdueMs) overdue = true;
          }
          if (this.pauseMs) await sleep(this.pauseMs);
        }
        after = range.end;
      }
      if (blocked) {
        stats.blockedObjects!++;
        if (blocked === 'dirty') stats.blockedDirty!++;
        else if (blocked === 'not-summarised') stats.blockedNotSummarised!++;
        else stats.blockedFailed!++;
      }
      if (overdue) stats.overdueObjects!++;
    }
    return { complete: true, backlog };
  }

  /** Newest point of each vehicle (index (objectId, fixTime DESC)). */
  private async lastPoints(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ oid: string; t: Date | null }[]>`
      SELECT o.oid, (SELECT max(p."fixTime") FROM "Position" p WHERE p."objectId" = o.oid::uuid) AS t
      FROM unnest(${ids}::text[]) AS o(oid)`;
    return new Map(rows.filter((r) => r.t).map((r) => [r.oid, r.t!.getTime()]));
  }

  /** Oldest point of the vehicle with after ≤ fixTime < before (index (objectId, fixTime)). */
  private async oldestBefore(objectId: string, afterMs: number, beforeMs: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ t: Date | null }[]>`
      SELECT min("fixTime") AS t FROM "Position"
      WHERE "objectId" = ${objectId}::uuid AND "fixTime" >= ${new Date(afterMs)} AND "fixTime" < ${new Date(beforeMs)}`;
    return rows[0]?.t ? rows[0].t.getTime() : null;
  }

  /**
   * Claims, writes, verifies and only then deletes one vehicle-day. Never throws (failures are recorded on the row).
   * `cutoffDay`: the company's archive cutoff (for the summarizer re-check under the lock).
   */
  async archiveDay(companyId: string, tz: string, objectId: string, day: string, existing: DayRow | null, cutoffDay: string): Promise<UnitResult> {
    const token = randomUUID();
    const claimed = await this.claim(companyId, objectId, day, token, existing);
    if (!claimed) return { kind: 'skipped' };
    let written: string | null = null;
    try {
      const range = localDayRange(day, tz);
      const fresh = await readPoints(this.prisma, objectId, range.start, range.end);
      let prior: ArchivePoint[] = [];
      if (claimed.filePath) {
        // The day was archived before: its file must read back intact, or nothing is changed (no point is deleted).
        prior = (await readArchiveFile(resolveArchivePath(this.dir, claimed.filePath))).points;
      }
      const all = mergePoints(prior, fresh);
      if (!all.length) {
        await this.prisma.archivedDay.deleteMany({ where: { id: claimed.id, claimToken: token } });
        return { kind: 'skipped' };
      }
      // A rewrite never touches the file the row points at: new name, switched in the transaction below.
      const rel = archiveRelPath(companyId, objectId, day, claimed.filePath ? newVersion() : undefined);
      const abs = resolveArchivePath(this.dir, rel);
      const header = { companyId, objectId, day, tz, from: new Date(range.start).toISOString(), to: new Date(range.end).toISOString() };
      written = abs;
      const info = await this.writer.write(abs, header, all);
      // Independent re-read under the final name before anything is deleted.
      await verifyArchiveFile(abs, { count: all.length, checksum: info.checksum, objectId, day });
      if (this.beforeCommit) await this.beforeCommit(objectId, day);
      await this.prisma.$transaction(
        async (tx) => {
          await lockArchiveObjects(tx, [objectId]);
          // Under the lock shared with the summarizer: it must still be done with this day (no late points waiting).
          const [dirty, cursor, lastRow] = await Promise.all([
            tx.summaryDirtyDay.count({ where: { objectId } }),
            tx.summaryCursor.findUnique({ where: { objectId }, select: { processedUntil: true } }),
            tx.$queryRaw<{ t: Date | null }[]>`SELECT max("fixTime") AS t FROM "Position" WHERE "objectId" = ${objectId}::uuid`,
          ]);
          const summarised = isSummarised({ day, cutoffDay, dayEndMs: range.end, processedUntilMs: cursor?.processedUntil.getTime() ?? null, lastPointMs: lastRow[0]?.t?.getTime() ?? null });
          if (dirty > 0 || !summarised) throw new Deferred('The summarizer has new work for this vehicle');
          const n = await tx.archivedDay.updateMany({
            where: { id: claimed.id, claimToken: token },
            data: { status: 'ARCHIVED', filePath: rel, pointCount: all.length, checksum: info.checksum, bytes: info.bytes, archivedAt: new Date(this.now()), keepUntil: null, claimToken: null, claimedAt: null, lastError: null },
          });
          if (n.count !== 1) throw new ArchiveFileError('Claim lost before the points were deleted (row removed or taken over)');
          const deleted = await deletePoints(tx, objectId, fresh, range.start, range.end);
          // Every point read must still be there: fewer = removed meanwhile (purge, point removal) → fail closed.
          if (deleted !== fresh.length) throw new ArchiveFileError(`Points changed meanwhile (${deleted} of ${fresh.length} still present); nothing deleted`);
        },
        { timeout: 5 * 60_000, maxWait: 30_000 },
      );
      written = null;
      if (claimed.filePath && claimed.filePath !== rel) await fsp.rm(resolveArchivePath(this.dir, claimed.filePath), { force: true }).catch(() => undefined);
      return { kind: 'archived', points: fresh.length, bytes: info.bytes, reArchived: existing?.status === 'RESTORED' };
    } catch (e) {
      // Points stay in the database; the file this attempt wrote is removed (the row still names the previous one).
      if (written) await fsp.rm(written, { force: true }).catch(() => undefined);
      if (e instanceof Deferred) {
        await (claimed.filePath
          ? this.prisma.archivedDay.updateMany({ where: { id: claimed.id, claimToken: token }, data: { status: claimed.prevStatus, claimToken: null, claimedAt: null } })
          : this.prisma.archivedDay.deleteMany({ where: { id: claimed.id, claimToken: token } })
        ).catch(() => undefined);
        return { kind: 'deferred' };
      }
      const error = errText(e);
      await this.prisma.archivedDay
        .updateMany({ where: { id: claimed.id, claimToken: token }, data: { status: claimed.filePath ? claimed.prevStatus : 'FAILED', claimToken: null, claimedAt: null, lastError: error } })
        .catch(() => undefined);
      return { kind: 'failed', error };
    }
  }

  /** Inserts or takes over the claim row; null when another run holds it or it changed meanwhile. */
  private async claim(companyId: string, objectId: string, day: string, token: string, existing: DayRow | null): Promise<{ id: string; filePath: string | null; prevStatus: ArchivedDayStatus } | null> {
    const now = new Date(this.now());
    if (!existing) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "ArchivedDay" ("id", "companyId", "objectId", "day", "status", "claimToken", "claimedAt", "attempts", "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${companyId}::uuid, ${objectId}::uuid, ${day}::date, 'CLAIMED', ${token}, ${now}, 1, ${now}, ${now})
        ON CONFLICT ("objectId", "day") DO NOTHING
        RETURNING "id"::text AS id`;
      return rows[0] ? { id: rows[0].id, filePath: null, prevStatus: 'FAILED' } : null;
    }
    const n = await this.prisma.archivedDay.updateMany({
      where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
      data: { status: 'CLAIMED', claimToken: token, claimedAt: now, attempts: { increment: 1 } },
    });
    if (n.count !== 1) return null;
    return { id: existing.id, filePath: existing.filePath, prevStatus: existing.status === 'CLAIMED' ? (existing.filePath ? 'ARCHIVED' : 'FAILED') : existing.status };
  }

  // ───────────────────────── restore ─────────────────────────

  /**
   * Queues archived days of one vehicle (or every vehicle of the company) for restore. Idempotent: days already being
   * restored are counted, restored days get their keep period renewed.
   */
  async requestRestore(companyId: string, objectIds: string[] | null, fromDay: string, toDay: string, userId: string | null, keepDays = HISTORY_RESTORE_KEEP_DAYS_DEFAULT): Promise<{ queued: number; already: number }> {
    const keep = Math.min(HISTORY_RESTORE_KEEP_DAYS_MAX, Math.max(1, Math.round(keepDays)));
    const where: Prisma.ArchivedDayWhereInput = { companyId, day: { gte: dayDate(fromDay), lte: dayDate(toDay) }, ...(objectIds ? { objectId: { in: objectIds } } : {}) };
    const now = new Date(this.now());
    const already = await this.prisma.archivedDay.count({ where: { ...where, status: 'RESTORING' } });
    const queued = await this.prisma.archivedDay.updateMany({
      where: { ...where, status: { in: ['ARCHIVED', 'RESTORED'] }, filePath: { not: null } },
      data: { status: 'RESTORING', restoreRequestedAt: now, restoreRequestedBy: userId, restoreKeepDays: keep, attempts: 0, lastError: null },
    });
    return { queued: queued.count, already };
  }

  /** Restores up to `limit` queued days (oldest request first). */
  async restorePending(limit = 20, deadline = Infinity): Promise<{ restored: number; failed: number }> {
    const rows = await this.prisma.archivedDay.findMany({ where: { status: 'RESTORING' }, orderBy: [{ restoreRequestedAt: 'asc' }, { day: 'asc' }], take: limit });
    let restored = 0;
    let failed = 0;
    for (const r of rows) {
      if (this.now() > deadline) break;
      (await this.restoreDay(r)) ? restored++ : failed++;
    }
    return { restored, failed };
  }

  /**
   * Re-imports one day's file (insert-if-missing, so a repeat is harmless), checks every point is back under THIS
   * vehicle (object + primary key), marks RESTORED. A point whose key is taken by another vehicle (or none) is a
   * mismatch: reported on the row, the day is not marked restored.
   */
  async restoreDay(r: DayRow): Promise<boolean> {
    try {
      if (!r.filePath) throw new ArchiveFileError('No archive file recorded for this day');
      const content = await readArchiveFile(resolveArchivePath(this.dir, r.filePath));
      const day = dayKey(r.day);
      if (content.header.objectId !== r.objectId || content.header.day !== day) throw new ArchiveFileError('Archive file belongs to another vehicle-day');
      if (r.checksum && content.checksum !== r.checksum) throw new ArchiveFileError('Archive file checksum differs from the recorded one');
      const from = Date.parse(content.header.from);
      const to = Date.parse(content.header.to);
      for (let i = 0; i < content.points.length; i += ARCHIVE_BATCH) await insertPoints(this.prisma, r.objectId, content.points.slice(i, i + ARCHIVE_BATCH));
      const present = await countPresent(this.prisma, r.objectId, content.points, from, to);
      if (present !== content.points.length) {
        const anywhere = await countPresent(this.prisma, null, content.points, from, to);
        throw new ArchiveFileError(
          anywhere > present
            ? `Restore check failed: ${anywhere - present} of ${content.points.length} points exist under another vehicle (or none) with the same device and time`
            : `Restore check failed: ${present} of ${content.points.length} points in the database`,
        );
      }
      const now = this.now();
      const keep = r.restoreKeepDays ?? HISTORY_RESTORE_KEEP_DAYS_DEFAULT;
      const n = await this.prisma.archivedDay.updateMany({
        where: { id: r.id, status: 'RESTORING' },
        data: { status: 'RESTORED', restoredAt: new Date(now), keepUntil: new Date(now + keep * DAY_MS), lastError: null },
      });
      return n.count === 1;
    } catch (e) {
      const attempts = r.attempts + 1;
      await this.prisma.archivedDay
        .updateMany({ where: { id: r.id, status: 'RESTORING' }, data: { attempts, lastError: errText(e), ...(attempts >= RESTORE_MAX_ATTEMPTS ? { status: 'ARCHIVED' } : {}) } })
        .catch(() => undefined);
      return false;
    }
  }

  // ───────────────────────── device purge ─────────────────────────

  /**
   * A purged device's points leave the archive files of the vehicles it was fitted to: each affected day file is
   * rewritten (new versioned name, verified, switched under the vehicle lock, old file removed); a day left empty loses
   * its file and row. Returns the number of points removed.
   */
  async removeDevicePoints(deviceId: string, objectIds: string[]): Promise<number> {
    if (!objectIds.length) return 0;
    const rows = await this.prisma.archivedDay.findMany({ where: { objectId: { in: objectIds }, filePath: { not: null } } });
    let removed = 0;
    for (const r of rows) {
      const oldRel = r.filePath!;
      const content = await readArchiveFile(resolveArchivePath(this.dir, oldRel));
      const keep = content.points.filter((p) => p.deviceId !== deviceId);
      if (keep.length === content.points.length) continue;
      let rel: string | null = null;
      let info: { checksum: string; bytes: number } | null = null;
      if (keep.length) {
        rel = archiveRelPath(r.companyId, r.objectId, dayKey(r.day), newVersion());
        const h = content.header;
        info = await this.writer.write(resolveArchivePath(this.dir, rel), { companyId: h.companyId, objectId: h.objectId, day: h.day, tz: h.tz, from: h.from, to: h.to }, keep);
      }
      try {
        await this.prisma.$transaction(async (tx) => {
          await lockArchiveObjects(tx, [r.objectId]);
          const n = rel
            ? await tx.archivedDay.updateMany({ where: { id: r.id, filePath: oldRel }, data: { filePath: rel, pointCount: keep.length, checksum: info!.checksum, bytes: info!.bytes } })
            : await tx.archivedDay.deleteMany({ where: { id: r.id, filePath: oldRel } });
          if (n.count !== 1) throw new ArchiveFileError('Archive day changed meanwhile');
        });
      } catch (e) {
        if (rel) await fsp.rm(resolveArchivePath(this.dir, rel), { force: true }).catch(() => undefined);
        throw e;
      }
      await fsp.rm(resolveArchivePath(this.dir, oldRel), { force: true }).catch(() => undefined);
      removed += content.points.length - keep.length;
    }
    return removed;
  }

  // ───────────────────────── reads ─────────────────────────

  /** Archive rows of one vehicle between two local days (inclusive). */
  async daysOf(objectId: string, fromDay: string, toDay: string): Promise<HistoryArchiveInfo | null> {
    const rows = await this.prisma.archivedDay.findMany({ where: { objectId, day: { gte: dayDate(fromDay), lte: dayDate(toDay) } }, orderBy: { day: 'asc' } });
    if (!rows.length) return null;
    return {
      days: rows.map(toArchivedDayDto),
      archivedDays: rows.filter(isOffline).length,
      restoring: rows.filter((r) => r.status === 'RESTORING').length,
    };
  }

  /** Start (epoch ms) of the oldest restored day of the vehicle within [fromDay, toDay], or null. */
  async oldestRestoredStart(objectId: string, fromDay: string, toDay: string, tz: string): Promise<number | null> {
    const r = await this.prisma.archivedDay.findFirst({ where: { objectId, status: 'RESTORED', day: { gte: dayDate(fromDay), lte: dayDate(toDay) } }, orderBy: { day: 'asc' }, select: { day: true } });
    return r ? localDayRange(dayKey(r.day), tz).start : null;
  }
}

/** One vehicle-day of points, attributes as the exact jsonb text. */
async function readPoints(db: Db, objectId: string, fromMs: number, toMs: number): Promise<ArchivePoint[]> {
  const rows = await db.$queryRaw<
    { deviceId: string; fixTime: Date; serverTime: Date; lat: number; lng: number; speedKph: number; course: number; altitude: number | null; satellites: number | null; valid: boolean; ignition: boolean | null; flags: number; attributesJson: string }[]
  >`
    SELECT "deviceId"::text AS "deviceId", "fixTime", "serverTime", lat, lng, "speedKph", course::int AS course, altitude,
           satellites::int AS satellites, valid, ignition, flags, attributes::text AS "attributesJson"
    FROM "Position"
    WHERE "objectId" = ${objectId}::uuid AND "fixTime" >= ${new Date(fromMs)} AND "fixTime" < ${new Date(toMs)}
    ORDER BY "fixTime", "deviceId"`;
  return rows.map((r) => ({
    deviceId: r.deviceId,
    fixTime: r.fixTime.getTime(),
    serverTime: r.serverTime.getTime(),
    lat: r.lat,
    lng: r.lng,
    speedKph: r.speedKph,
    course: r.course,
    altitude: r.altitude,
    satellites: r.satellites,
    valid: r.valid,
    ignition: r.ignition,
    flags: r.flags,
    attributesJson: r.attributesJson,
  }));
}

/** Insert-if-missing (primary key deviceId + fixTime); attributes go back through ::jsonb unchanged. */
async function insertPoints(db: Db, objectId: string, points: ArchivePoint[]): Promise<number> {
  if (!points.length) return 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  return db.$executeRaw`
    INSERT INTO "Position" ("objectId", "deviceId", "fixTime", "serverTime", lat, lng, "speedKph", course, altitude, satellites, valid, ignition, flags, attributes)
    SELECT ${objectId}::uuid, u.d, u.ft, u.st, u.la, u.ln, u.sp, u.co, u.al, u.sa, u.va, u.ig, u.fl, u.at::jsonb
    FROM unnest(
      ${points.map((p) => p.deviceId)}::uuid[], ${points.map((p) => iso(p.fixTime))}::timestamptz[], ${points.map((p) => iso(p.serverTime))}::timestamptz[],
      ${points.map((p) => p.lat)}::float8[], ${points.map((p) => p.lng)}::float8[], ${points.map((p) => p.speedKph)}::real[],
      ${points.map((p) => p.course)}::smallint[], ${points.map((p) => p.altitude)}::real[], ${points.map((p) => p.satellites)}::smallint[],
      ${points.map((p) => p.valid)}::boolean[], ${points.map((p) => p.ignition)}::boolean[], ${points.map((p) => p.flags)}::int[],
      ${points.map((p) => p.attributesJson)}::text[]
    ) AS u(d, ft, st, la, ln, sp, co, al, sa, va, ig, fl, at)
    ON CONFLICT ("deviceId", "fixTime") DO NOTHING`;
}

/**
 * Deletes exactly these points (primary key deviceId + fixTime, limited to the vehicle and the day's bounds so only the
 * day's chunk is touched), in batches.
 */
export async function deletePoints(db: Db, objectId: string, points: ArchivePoint[], fromMs: number, toMs: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < points.length; i += ARCHIVE_BATCH) {
    const part = points.slice(i, i + ARCHIVE_BATCH);
    n += await db.$executeRaw`
      DELETE FROM "Position" p
      USING unnest(${part.map((p) => p.deviceId)}::uuid[], ${part.map((p) => new Date(p.fixTime).toISOString())}::timestamptz[]) AS k(d, t)
      WHERE p."deviceId" = k.d AND p."fixTime" = k.t AND p."objectId" = ${objectId}::uuid
        AND p."fixTime" >= ${new Date(fromMs)} AND p."fixTime" < ${new Date(toMs)}`;
  }
  return n;
}

/** How many of these points (primary key, within the day's bounds) are in the database under `objectId` (null = any). */
export async function countPresent(db: Db, objectId: string | null, points: ArchivePoint[], fromMs: number, toMs: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < points.length; i += ARCHIVE_BATCH) {
    const part = points.slice(i, i + ARCHIVE_BATCH);
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Position" p
      JOIN unnest(${part.map((p) => p.deviceId)}::uuid[], ${part.map((p) => new Date(p.fixTime).toISOString())}::timestamptz[]) AS k(d, t)
        ON p."deviceId" = k.d AND p."fixTime" = k.t
      WHERE p."fixTime" >= ${new Date(fromMs)} AND p."fixTime" < ${new Date(toMs)}
        AND (${objectId}::uuid IS NULL OR p."objectId" = ${objectId}::uuid)`;
    n += Number(rows[0]?.n ?? 0);
  }
  return n;
}
