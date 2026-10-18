import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { RedisKeys } from '../redis/keys';

/** Stream position up to which the summarizer has inspected `vt:positions` for late fixes. */
export const SUMMARIZER_STREAM_CURSOR_KEY = 'vt:summarizer:streamCursor';
/** Valkey lock so only one summarizer instance runs at a time. */
export const SUMMARIZER_LOCK_KEY = 'vt:summarizer:lock';

const PAGE = 5000;
const FIELD_RE = /"uniqueId":"([^"]+)","fixTime":"([^"]+)"/;

export interface ScanResult {
  /** objectId → oldest fixTime (ms) received since the last scan. */
  minFix: Map<string, number>;
  /** Stream id to store once the dirty days are recorded (null = nothing to store). */
  nextCursor: string | null;
  entries: number;
  /** Set when the stream could not be used and a database scan was needed. */
  fallback: string | null;
  /** Rows received after this instant (epoch ms) belong to the scanned window (null = nothing scanned). */
  sinceMs: number | null;
}

const idMs = (id: string) => Number(id.split('-')[0]);

function compareIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am !== bm ? am - bm : as - bs;
}

function previousId(id: string): string {
  const [ms, seq] = id.split('-').map(Number);
  return seq > 0 ? `${ms}-${seq - 1}` : `${ms - 1}-18446744073709551615`;
}

/**
 * Detects late positions (fixTime older than what was already summarised) without scanning the Position table:
 * reads the `vt:positions` stream from a stored cursor, but only up to entries the processor has already written
 * to Postgres (below its oldest pending entry and its last-delivered id).
 */
export class LateDetector {
  private readonly logger = new Logger('Summarizer');
  private devices = new Map<string, string>(); // uniqueId → objectId
  private devicesLoadedAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {}

  invalidateDevices(): void {
    this.devicesLoadedAt = 0;
  }

  private async loadDevices(): Promise<void> {
    if (Date.now() - this.devicesLoadedAt < 60_000) return;
    const rows = await this.prisma.deviceAssignment.findMany({
      where: { toTime: null },
      select: { objectId: true, device: { select: { uniqueId: true } } },
    });
    this.devices = new Map(rows.map((r) => [r.device.uniqueId, r.objectId]));
    this.devicesLoadedAt = Date.now();
  }

  /** Highest stream id whose entries are certainly committed by the processor, or null when unknown. */
  private async committedBound(): Promise<string | null> {
    let groups: unknown[][];
    try {
      groups = (await this.redis.xinfo('GROUPS', RedisKeys.positionsStream)) as unknown[][];
    } catch {
      return null; // stream missing
    }
    let lastDelivered: string | null = null;
    for (const g of groups) {
      const info = new Map<string, unknown>();
      for (let i = 0; i < g.length; i += 2) info.set(String(g[i]), g[i + 1]);
      if (info.get('name') === RedisKeys.processorGroup) lastDelivered = String(info.get('last-delivered-id'));
    }
    if (!lastDelivered) return null;
    const pending = (await this.redis.xpending(RedisKeys.positionsStream, RedisKeys.processorGroup)) as [
      number,
      string | null,
      string | null,
      unknown,
    ];
    let bound = lastDelivered;
    if (pending[0] > 0 && pending[1]) {
      const beforePending = previousId(pending[1]);
      if (compareIds(beforePending, bound) < 0) bound = beforePending;
    }
    return bound;
  }

  async scan(): Promise<ScanResult> {
    const result: ScanResult = { minFix: new Map(), nextCursor: null, entries: 0, fallback: null, sinceMs: null };
    const bound = await this.committedBound();
    if (!bound) return result;
    const cursor = await this.redis.get(SUMMARIZER_STREAM_CURSOR_KEY);

    const first = (await this.redis.xrange(RedisKeys.positionsStream, '-', '+', 'COUNT', 1)) as [string, string[]][];
    const firstId = first[0]?.[0] ?? null;
    if (!cursor || (firstId && compareIds(cursor, firstId) < 0)) {
      // No cursor yet or the stream was trimmed past it: find late fixes in the database instead (one-off scan).
      const since = cursor ? idMs(cursor) : await this.oldestCursorUpdate();
      result.sinceMs = since;
      if (since !== null) {
        result.fallback = `database scan since ${new Date(since).toISOString()}`;
        const rows = await this.prisma.$queryRaw<{ oid: string; min: number }[]>`
          SELECT "objectId"::text AS oid, (extract(epoch from min("fixTime")) * 1000)::float8 AS min
          FROM "Position"
          WHERE "serverTime" > to_timestamp(${since}::float8 / 1000) AND "objectId" IS NOT NULL
          GROUP BY 1`;
        for (const r of rows) result.minFix.set(r.oid, r.min);
      }
      result.nextCursor = bound;
      return result;
    }
    if (compareIds(cursor, bound) >= 0) return result;

    await this.loadDevices();
    // Stream ids are assigned before processing, so every scanned entry was stored with serverTime > cursor time.
    result.sinceMs = idMs(cursor) - 5_000;
    let start = `(${cursor}`;
    for (;;) {
      const page = (await this.redis.xrange(RedisKeys.positionsStream, start, bound, 'COUNT', PAGE)) as [string, string[]][];
      for (const [, fields] of page) {
        const dataIndex = fields.indexOf('data');
        const data = dataIndex >= 0 ? fields[dataIndex + 1] : null;
        if (!data) continue;
        let uniqueId: string | undefined;
        let fixTime: string | undefined;
        const m = FIELD_RE.exec(data);
        if (m) [, uniqueId, fixTime] = m;
        else {
          try {
            const parsed = JSON.parse(data) as { uniqueId?: string; fixTime?: string };
            uniqueId = parsed.uniqueId;
            fixTime = parsed.fixTime;
          } catch {
            continue;
          }
        }
        if (!uniqueId || !fixTime) continue;
        const objectId = this.devices.get(uniqueId);
        const t = Date.parse(fixTime);
        if (!objectId || !Number.isFinite(t)) continue;
        const prev = result.minFix.get(objectId);
        if (prev === undefined || t < prev) result.minFix.set(objectId, t);
      }
      result.entries += page.length;
      if (page.length < PAGE) break;
      start = `(${page[page.length - 1][0]}`;
    }
    result.nextCursor = bound;
    return result;
  }

  async commit(cursor: string | null): Promise<void> {
    if (cursor) await this.redis.set(SUMMARIZER_STREAM_CURSOR_KEY, cursor);
  }

  private async oldestCursorUpdate(): Promise<number | null> {
    const row = await this.prisma.summaryCursor.aggregate({ _min: { updatedAt: true } });
    const at = row._min.updatedAt;
    if (!at) return null;
    this.logger.warn('No stream cursor: checking the database for positions received since the last run');
    return at.getTime() - 60_000;
  }
}
