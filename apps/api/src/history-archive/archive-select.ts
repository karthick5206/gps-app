/** Which vehicle-days the archive job may take (pure; unit-tested). */
import { historyArchiveOf, type ArchivedDayStatus, type HistoryArchiveSettings } from '@veetracer/shared';
import { addDays, localDayKey } from '../summarizer/tz';

/** A CLAIMED row older than this belongs to a run that stopped part-way: it may be taken again. */
export const STALE_CLAIM_MS = 6 * 60 * 60_000;

export interface ArchiveCompany {
  id: string;
  timezone: string;
  settings: HistoryArchiveSettings;
}

/** Companies with the switch on (anything else keeps today's behaviour). */
export function enabledCompanies(rows: { id: string; timezone: string; settings: unknown }[]): ArchiveCompany[] {
  const out: ArchiveCompany[] = [];
  for (const r of rows) {
    const s = historyArchiveOf(r.settings);
    if (s.enabled) out.push({ id: r.id, timezone: r.timezone, settings: s });
  }
  return out;
}

/** Days strictly before this (company-local) day are older than `afterDays` and may be archived. */
export function archiveCutoffDay(now: number, afterDays: number, tz: string): string {
  return addDays(localDayKey(now, tz), -afterDays);
}

export type DayDecision = 'archive' | 'too-recent' | 'dirty' | 'not-summarised' | 'restoring' | 'restored-held' | 'in-progress' | 'failed-backoff';

const DAY_MS = 86_400_000;
/** Wait between automatic retries of a FAILED day: 1, 2, 4 days … capped at 7 (retries never stop; health reports them). */
export function failedBackoffMs(attempts: number): number {
  return Math.min(7, 2 ** Math.max(0, attempts - 1)) * DAY_MS;
}

export interface DayInput {
  day: string;
  cutoffDay: string;
  /** End of the day (epoch ms, exclusive). */
  dayEndMs: number;
  /** Summarizer watermark of the vehicle (SummaryCursor.processedUntil); null = never summarised. */
  processedUntilMs: number | null;
  /** Newest point of the vehicle (any age; null = none). */
  lastPointMs: number | null;
  /** The vehicle has SummaryDirtyDay rows (late points waiting for recomputation). */
  hasDirty: boolean;
  existing: { status: ArchivedDayStatus; keepUntilMs: number | null; claimedAtMs: number | null; attempts?: number; updatedAtMs?: number } | null;
  now: number;
}

/**
 * - only days older than afterDays (day < cutoffDay);
 * - never while the summarizer still has dirty days for the vehicle (its recomputation reads the points), nor a day the
 *   summarizer has not processed to its end (trips / daily summaries must be complete before the points leave);
 * - not a day being restored, nor a restored day still inside its keep period;
 * - not a day another run claimed recently.
 * Everything else is archived: new days, FAILED retries, ARCHIVED days with points that arrived late (merged into the
 * file), restored days whose keep period is over, and stale claims.
 */
export function dayDecision(i: DayInput): DayDecision {
  if (i.day >= i.cutoffDay) return 'too-recent';
  if (i.hasDirty) return 'dirty';
  if (!isSummarised(i)) return 'not-summarised';
  const e = i.existing;
  if (e) {
    if (e.status === 'RESTORING') return 'restoring';
    if (e.status === 'RESTORED' && e.keepUntilMs !== null && e.keepUntilMs > i.now) return 'restored-held';
    if (e.status === 'CLAIMED' && e.claimedAtMs !== null && i.now - e.claimedAtMs < STALE_CLAIM_MS) return 'in-progress';
    if (e.status === 'FAILED' && e.updatedAtMs !== undefined && i.now - e.updatedAtMs < failedBackoffMs(e.attempts ?? 1)) return 'failed-backoff';
  }
  return 'archive';
}

/**
 * The summarizer is done with the day: its watermark passed the day's end, or (an idle vehicle, whose watermark stays
 * at its last point) it has processed every point the vehicle has and the day is older than afterDays + 1.
 */
export function isSummarised(i: Pick<DayInput, 'processedUntilMs' | 'dayEndMs' | 'lastPointMs' | 'day' | 'cutoffDay'>): boolean {
  if (i.processedUntilMs === null) return false;
  if (i.processedUntilMs >= i.dayEndMs) return true;
  return i.lastPointMs !== null && i.processedUntilMs >= i.lastPointMs && i.day < addDays(i.cutoffDay, -1);
}

/** Days are visited oldest first: after these decisions every later day of the vehicle would be skipped too. */
export function vehicleWide(d: DayDecision): boolean {
  return d === 'dirty' || d === 'not-summarised' || d === 'too-recent';
}

/** The nightly file backup runs at 21:30 UTC: no archive run is active between 21:00 and 22:30 UTC. */
export const BACKUP_BLACKOUT_UTC = { startMin: 21 * 60, endMin: 22 * 60 + 30 } as const;

/**
 * Deadline for an archive run started at `now` with `budgetMs`: never inside or across the backup blackout (stops at
 * 21:00 UTC); null when `now` is inside the blackout (the run does not start).
 */
export function archiveRunDeadline(now: number, budgetMs: number): number | null {
  const d = new Date(now);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (min >= BACKUP_BLACKOUT_UTC.startMin && min < BACKUP_BLACKOUT_UTC.endMin) return null;
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let blackout = dayStart + BACKUP_BLACKOUT_UTC.startMin * 60_000;
  if (blackout <= now) blackout += 86_400_000;
  return Math.min(now + budgetMs, blackout);
}
