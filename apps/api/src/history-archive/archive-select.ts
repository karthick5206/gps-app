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

export type DayDecision = 'archive' | 'too-recent' | 'dirty' | 'not-summarised' | 'restoring' | 'restored-held' | 'in-progress';

export interface DayInput {
  day: string;
  cutoffDay: string;
  /** End of the day (epoch ms, exclusive). */
  dayEndMs: number;
  /** Summarizer watermark of the vehicle (SummaryCursor.processedUntil); null = never summarised. */
  processedUntilMs: number | null;
  /** The vehicle has SummaryDirtyDay rows (late points waiting for recomputation). */
  hasDirty: boolean;
  existing: { status: ArchivedDayStatus; keepUntilMs: number | null; claimedAtMs: number | null } | null;
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
  if (i.processedUntilMs === null || i.processedUntilMs < i.dayEndMs) return 'not-summarised';
  const e = i.existing;
  if (e) {
    if (e.status === 'RESTORING') return 'restoring';
    if (e.status === 'RESTORED' && e.keepUntilMs !== null && e.keepUntilMs > i.now) return 'restored-held';
    if (e.status === 'CLAIMED' && e.claimedAtMs !== null && i.now - e.claimedAtMs < STALE_CLAIM_MS) return 'in-progress';
  }
  return 'archive';
}

/** Days are visited oldest first: after these decisions every later day of the vehicle would be skipped too. */
export function vehicleWide(d: DayDecision): boolean {
  return d === 'dirty' || d === 'not-summarised' || d === 'too-recent';
}
