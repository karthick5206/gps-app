import { driverEventSettings } from '@veetracer/shared';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord } from '../common/dto';
import { DRIVER_MEDIA_DIR, INCOMING, removeMedia } from './media-store';

const DAY_MS = 86_400_000;
const BATCH = 500;
/** Unlinked files in incoming/ older than this are orphans (the notifier was down, or nothing matched). */
const INCOMING_KEEP_DAYS = 2;

export interface DriverRetentionDeps {
  /** Media of the company's events older than `cutoff` (at most `take`). */
  oldMedia(companyId: string, cutoff: Date, take: number): Promise<{ id: string; filePath: string }[]>;
  deleteMedia(ids: string[]): Promise<number>;
  /** Deletes up to `take` events older than `cutoff`; returns the count. */
  deleteEvents(companyId: string, cutoff: Date, take: number): Promise<number>;
  removeFile?(relative: string): Promise<void>;
}

/**
 * Driver event retention (Company.settings.driverEvents.retentionDays, default 90): photos / clips are deleted from
 * disk first, then their rows and the events. Returns false when the time budget ran out.
 */
export async function purgeDriverEvents(
  deps: DriverRetentionDeps,
  companies: { id: string; settings: unknown }[],
  now: number,
  deadline: number,
  add: (key: string, n: number) => void,
): Promise<boolean> {
  const remove = deps.removeFile ?? removeMedia;
  for (const c of companies) {
    const cutoff = new Date(now - driverEventSettings(asRecord(c.settings).driverEvents).retentionDays * DAY_MS);
    for (;;) {
      if (Date.now() > deadline) return false;
      const media = await deps.oldMedia(c.id, cutoff, BATCH);
      if (!media.length) break;
      for (const m of media) await remove(m.filePath).catch(() => undefined);
      add('driverEventMedia', await deps.deleteMedia(media.map((m) => m.id)));
      if (media.length < BATCH) break;
    }
    for (;;) {
      if (Date.now() > deadline) return false;
      const n = await deps.deleteEvents(c.id, cutoff, BATCH);
      add('driverEvents', n);
      if (n < BATCH) break;
    }
  }
  return true;
}

/** Removes incoming/<yyyy-mm-dd> directories older than two days (files no event ever claimed). */
export async function sweepIncoming(now: number, dir = join(DRIVER_MEDIA_DIR, INCOMING)): Promise<number> {
  const days = await readdir(dir).catch(() => [] as string[]);
  const keepFrom = new Date(now - INCOMING_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  let removed = 0;
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= keepFrom) continue;
    await rm(join(dir, d), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
