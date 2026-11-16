/**
 * History archiving engine: database + files, no scheduling (HistoryArchiveService adds the locks and the timers; the DB
 * test drives this class directly).
 *
 * Archive unit = one vehicle-day (company-local day): claim the ArchivedDay row → read the day's points → merge with an
 * existing file (late points, re-archive after a restore) → write + verify the file → in ONE transaction mark the row
 * ARCHIVED and delete exactly the points that were written (by their primary keys, in batches). Nothing is deleted
 * unless the file was verified; a failure leaves every point in the database and the row FAILED (retried next night).
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
import { ArchiveFileError, ArchivePoint, archiveRelPath, ArchiveWriter, fileArchiveWriter, mergePoints, readArchiveFile, resolveArchivePath, verifyArchiveFile } from './archive-file';
import { archiveCutoffDay, ArchiveCompany, dayDecision, enabledCompanies, vehicleWide } from './archive-select';
import { localDayKey, localDayRange } from '../summarizer/tz';

const DAY_MS = 86_400_000;
/** Points deleted / inserted per statement. */
export const ARCHIVE_BATCH = 5_000;
/** Restore attempts before a day goes back to ARCHIVED with the error. */
const RESTORE_MAX_ATTEMPTS = 5;

type Db = PrismaClient | Prisma.TransactionClient;

export interface EngineOptions {
  dir: string;
  writer?: ArchiveWriter;
  /** Pause between vehicle-days (keeps the job at low priority next to live traffic). */
  pauseMs?: number;
  now?: () => number;
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

export class ArchiveEngine {
  readonly dir: string;
  private readonly writer: ArchiveWriter;
  private readonly pauseMs: number;
  private readonly now: () => number;

  constructor(
    private readonly prisma: PrismaClient,
    opts: EngineOptions,
  ) {
    this.dir = opts.dir;
    this.writer = opts.writer ?? fileArchiveWriter;
    this.pauseMs = opts.pauseMs ?? 0;
    this.now = opts.now ?? Date.now;
  }

  // ───────────────────────── archive run ─────────────────────────

  /** One pass over every enabled company (and expired restores of any company), until done or `deadline`. */
  async run(deadline = Infinity): Promise<HistoryArchiveRunStats> {
    const startedAt = new Date(this.now()).toISOString();
    const stats: HistoryArchiveRunStats = { startedAt, finishedAt: startedAt, complete: true, archivedDays: 0, points: 0, bytes: 0, failures: 0, reArchived: 0, backlogObjects: 0, lastError: null };
    const tally = (r: UnitResult) => {
      if (r.kind === 'archived') {
        stats.archivedDays++;
        stats.points += r.points;
        stats.bytes += r.bytes;
        if (r.reArchived) stats.reArchived++;
      } else if (r.kind === 'failed') {
        stats.failures++;
        stats.lastError = r.error;
      }
    };

    // Restored days whose keep period is over go back to the archive (every company: a restore is temporary).
    const expired = await this.prisma.archivedDay.findMany({ where: { status: 'RESTORED', keepUntil: { lt: new Date(this.now()) } }, orderBy: { keepUntil: 'asc' }, take: 10_000 });
    const tzOf = new Map((await this.prisma.company.findMany({ where: { id: { in: [...new Set(expired.map((e) => e.companyId))] } }, select: { id: true, timezone: true } })).map((c) => [c.id, c.timezone]));
    for (const e of expired) {
      if (this.now() > deadline) {
        stats.complete = false;
        break;
      }
      tally(await this.archiveDay(e.companyId, tzOf.get(e.companyId) ?? 'UTC', e.objectId, dayKey(e.day), e));
    }

    const companies = enabledCompanies(await this.prisma.company.findMany({ select: { id: true, timezone: true, settings: true } }));
    for (const c of companies) {
      if (!stats.complete) break;
      const r = await this.runCompany(c, deadline, tally);
      stats.backlogObjects += r.backlog;
      if (!r.complete) stats.complete = false;
    }
    stats.finishedAt = new Date(this.now()).toISOString();
    return stats;
  }

  private async runCompany(c: ArchiveCompany, deadline: number, tally: (r: UnitResult) => void): Promise<{ complete: boolean; backlog: number }> {
    const now = this.now();
    const tz = c.timezone;
    const cutoffDay = archiveCutoffDay(now, c.settings.afterDays, tz);
    const cutoffMs = localDayRange(cutoffDay, tz).start;
    const objects = await this.prisma.trackedObject.findMany({ where: { companyId: c.id }, select: { id: true }, orderBy: { id: 'asc' } });
    const ids = objects.map((o) => o.id);
    const [cursors, dirty] = await Promise.all([
      this.prisma.summaryCursor.findMany({ where: { objectId: { in: ids } }, select: { objectId: true, processedUntil: true } }),
      this.prisma.summaryDirtyDay.findMany({ where: { objectId: { in: ids } }, select: { objectId: true }, distinct: ['objectId'] }),
    ]);
    const processed = new Map(cursors.map((r) => [r.objectId, r.processedUntil.getTime()]));
    const dirtySet = new Set(dirty.map((d) => d.objectId));
    let backlog = 0;
    for (let i = 0; i < ids.length; i++) {
      const objectId = ids[i];
      let after = 0;
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
          hasDirty: dirtySet.has(objectId),
          existing: existing ? { status: existing.status, keepUntilMs: existing.keepUntil?.getTime() ?? null, claimedAtMs: existing.claimedAt?.getTime() ?? null } : null,
          now: this.now(),
        });
        if (vehicleWide(decision)) break;
        if (decision === 'archive') {
          tally(await this.archiveDay(c.id, tz, objectId, day, existing));
          if (this.pauseMs) await sleep(this.pauseMs);
        }
        after = range.end;
      }
    }
    return { complete: true, backlog };
  }

  /** Oldest point of the vehicle with after ≤ fixTime < before (index (objectId, fixTime)). */
  private async oldestBefore(objectId: string, afterMs: number, beforeMs: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ t: Date | null }[]>`
      SELECT min("fixTime") AS t FROM "Position"
      WHERE "objectId" = ${objectId}::uuid AND "fixTime" >= ${new Date(afterMs)} AND "fixTime" < ${new Date(beforeMs)}`;
    return rows[0]?.t ? rows[0].t.getTime() : null;
  }

  /** Claims, writes, verifies and only then deletes one vehicle-day. Never throws (failures are recorded on the row). */
  async archiveDay(companyId: string, tz: string, objectId: string, day: string, existing: DayRow | null): Promise<UnitResult> {
    const token = randomUUID();
    const claimed = await this.claim(companyId, objectId, day, token, existing);
    if (!claimed) return { kind: 'skipped' };
    try {
      const range = localDayRange(day, tz);
      const fresh = await this.readPoints(this.prisma, objectId, range.start, range.end);
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
      const rel = archiveRelPath(companyId, objectId, day);
      const abs = resolveArchivePath(this.dir, rel);
      const header = { companyId, objectId, day, tz, from: new Date(range.start).toISOString(), to: new Date(range.end).toISOString() };
      const info = await this.writer.write(abs, header, all);
      // Independent re-read under the final name before anything is deleted.
      await verifyArchiveFile(abs, { count: all.length, checksum: info.checksum, objectId, day });
      await this.prisma.$transaction(
        async (tx) => {
          const n = await tx.archivedDay.updateMany({
            where: { id: claimed.id, claimToken: token },
            data: { status: 'ARCHIVED', filePath: rel, pointCount: all.length, checksum: info.checksum, bytes: info.bytes, archivedAt: new Date(this.now()), keepUntil: null, claimToken: null, claimedAt: null, lastError: null },
          });
          if (n.count !== 1) throw new ArchiveFileError('Claim lost before the points were deleted');
          await deletePoints(tx, objectId, fresh);
        },
        { timeout: 10 * 60_000, maxWait: 30_000 },
      );
      return { kind: 'archived', points: fresh.length, bytes: info.bytes, reArchived: existing?.status === 'RESTORED' };
    } catch (e) {
      const error = errText(e);
      // Points stay in the database. A day that already had a file keeps its previous state (its file is still valid).
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

  private async readPoints(db: Db, objectId: string, fromMs: number, toMs: number): Promise<ArchivePoint[]> {
    const rows = await db.position.findMany({
      where: { objectId, fixTime: { gte: new Date(fromMs), lt: new Date(toMs) } },
      orderBy: [{ fixTime: 'asc' }, { deviceId: 'asc' }],
    });
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
      attributes: r.attributes,
    }));
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

  /** Restores up to `limit` queued days (oldest request first). Returns how many were restored. */
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

  /** Re-imports one day's file (insert-if-missing, so a repeat is harmless), checks every point is back, marks RESTORED. */
  async restoreDay(r: DayRow): Promise<boolean> {
    try {
      if (!r.filePath) throw new ArchiveFileError('No archive file recorded for this day');
      const content = await readArchiveFile(resolveArchivePath(this.dir, r.filePath));
      if (content.header.objectId !== r.objectId || content.header.day !== dayKey(r.day)) throw new ArchiveFileError('Archive file belongs to another vehicle-day');
      if (r.checksum && content.checksum !== r.checksum) throw new ArchiveFileError('Archive file checksum differs from the recorded one');
      for (let i = 0; i < content.points.length; i += ARCHIVE_BATCH) {
        await this.prisma.position.createMany({
          data: content.points.slice(i, i + ARCHIVE_BATCH).map((p) => ({
            objectId: r.objectId,
            deviceId: p.deviceId,
            fixTime: new Date(p.fixTime),
            serverTime: new Date(p.serverTime),
            lat: p.lat,
            lng: p.lng,
            speedKph: p.speedKph,
            course: p.course,
            altitude: p.altitude,
            satellites: p.satellites,
            valid: p.valid,
            ignition: p.ignition,
            flags: p.flags,
            attributes: (p.attributes ?? {}) as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
      }
      const present = await countPresent(this.prisma, content.points);
      if (present !== content.points.length) throw new ArchiveFileError(`Restore check failed: ${present} of ${content.points.length} points in the database`);
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

export type UnitResult = { kind: 'archived'; points: number; bytes: number; reArchived: boolean } | { kind: 'failed'; error: string } | { kind: 'skipped' };

/** Deletes exactly these points (primary key deviceId + fixTime, limited to the vehicle), in batches. */
async function deletePoints(db: Db, objectId: string, points: ArchivePoint[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < points.length; i += ARCHIVE_BATCH) {
    const part = points.slice(i, i + ARCHIVE_BATCH);
    n += await db.$executeRaw`
      DELETE FROM "Position" p
      USING unnest(${part.map((p) => p.deviceId)}::uuid[], ${part.map((p) => new Date(p.fixTime).toISOString())}::timestamptz[]) AS k(d, t)
      WHERE p."deviceId" = k.d AND p."fixTime" = k.t AND p."objectId" = ${objectId}::uuid`;
  }
  return n;
}

/** How many of these points (by primary key) are in the database. */
async function countPresent(db: Db, points: ArchivePoint[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < points.length; i += ARCHIVE_BATCH) {
    const part = points.slice(i, i + ARCHIVE_BATCH);
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Position" p
      JOIN unnest(${part.map((p) => p.deviceId)}::uuid[], ${part.map((p) => new Date(p.fixTime).toISOString())}::timestamptz[]) AS k(d, t)
        ON p."deviceId" = k.d AND p."fixTime" = k.t`;
    n += Number(rows[0]?.n ?? 0);
  }
  return n;
}
