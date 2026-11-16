/**
 * History archiving (owner decision 2026-11-15): for companies where the Super Admin switches it on, raw GPS points older
 * than `afterDays` are moved to compressed files on the server's own disk (one gzip JSON Lines file per vehicle per day)
 * and can be restored on request. Trips, stops, daily summaries and the reports built on them are not touched.
 * Companies without the switch keep the ordinary retention behaviour.
 */

/** Company.settings.historyArchive */
export interface HistoryArchiveSettings {
  enabled: boolean;
  /** Points older than this many days are archived (30–3650, default 90). */
  afterDays: number;
}

export const HISTORY_ARCHIVE_MIN_DAYS = 30;
export const HISTORY_ARCHIVE_MAX_DAYS = 3650;
export const HISTORY_ARCHIVE_DEFAULT_DAYS = 90;
export const HISTORY_ARCHIVE_DEFAULTS: HistoryArchiveSettings = { enabled: false, afterDays: HISTORY_ARCHIVE_DEFAULT_DAYS };
/** Restored days are archived again after this many days unless the request says otherwise (1–90). */
export const HISTORY_RESTORE_KEEP_DAYS_DEFAULT = 7;
export const HISTORY_RESTORE_KEEP_DAYS_MAX = 90;
/** A restore request may cover at most this many days. */
export const HISTORY_RESTORE_MAX_DAYS = 366;

/** Reads (and clamps) the setting from Company.settings; anything missing or malformed = off. */
export function historyArchiveOf(settings: unknown): HistoryArchiveSettings {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).historyArchive : undefined;
  if (!raw || typeof raw !== 'object') return { ...HISTORY_ARCHIVE_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const n = typeof r.afterDays === 'number' && Number.isFinite(r.afterDays) ? Math.round(r.afterDays) : HISTORY_ARCHIVE_DEFAULT_DAYS;
  return { enabled: r.enabled === true, afterDays: Math.min(HISTORY_ARCHIVE_MAX_DAYS, Math.max(HISTORY_ARCHIVE_MIN_DAYS, n)) };
}

/**
 * CLAIMED = being archived right now (or a run stopped part-way: retried), ARCHIVED = points only in the file,
 * RESTORING = restore requested / in progress, RESTORED = points back in the database (archived again after keepUntil),
 * FAILED = the last attempt failed (points were NOT deleted; retried next night).
 */
export const ARCHIVED_DAY_STATUSES = ['CLAIMED', 'ARCHIVED', 'RESTORING', 'RESTORED', 'FAILED'] as const;
export type ArchivedDayStatus = (typeof ARCHIVED_DAY_STATUSES)[number];

export interface ArchivedDayDto {
  objectId: string;
  /** YYYY-MM-DD in the company time zone. */
  day: string;
  status: ArchivedDayStatus;
  pointCount: number;
  bytes: number;
  archivedAt: string | null;
  restoredAt: string | null;
  /** RESTORED: archived again after this time. */
  keepUntil: string | null;
  error: string | null;
}

/** Days of the requested history period whose points are (or were) archived. */
export interface HistoryArchiveInfo {
  days: ArchivedDayDto[];
  /** Days whose points are not in the database right now (ARCHIVED or RESTORING). */
  archivedDays: number;
  restoring: number;
}

/** POST /history-archive/restore */
export interface HistoryRestoreRequest {
  /** One vehicle; omitted = every vehicle of the company (company admins with the permission, or Super Admin). */
  objectId?: string;
  from: string;
  to: string;
  /** Days the restored points stay before they are archived again (default 7). */
  keepDays?: number;
}

export interface HistoryRestoreResult {
  /** Days queued for restore now. */
  queued: number;
  /** Days already restored or being restored. */
  already: number;
}

/** GET /history-archive/status: the company's archive at a glance. */
export interface HistoryArchiveStatusDto {
  settings: HistoryArchiveSettings;
  archivedDays: number;
  restoringDays: number;
  restoredDays: number;
  failedDays: number;
  points: number;
  bytes: number;
  oldestDay: string | null;
  newestDay: string | null;
}

/** System Health: the nightly archive job (Super Admin). */
export interface HistoryArchiveHealthDto {
  /** HISTORY_ARCHIVE is not off. */
  jobEnabled: boolean;
  /** Companies with the switch on. */
  companies: number;
  lastRun: HistoryArchiveRunStats | null;
  /** Days that failed (points kept in the database) and the latest error. */
  failedDays: number;
  lastError: string | null;
  restoring: number;
  /** Archive files: total size, and the free space of the disk that holds the archive directory. */
  dir: string;
  archiveBytes: number;
  diskTotal: number | null;
  diskFree: number | null;
}

export interface HistoryArchiveRunStats {
  startedAt: string;
  finishedAt: string;
  /** false = the time budget ran out; the rest continues next night. */
  complete: boolean;
  archivedDays: number;
  points: number;
  bytes: number;
  failures: number;
  reArchived: number;
  /** Vehicles still holding archivable days when the run stopped. */
  backlogObjects: number;
  lastError: string | null;
}

/** Report types that read raw positions: over archived days they would be incomplete, so they carry a notice. */
export const RAW_POSITION_REPORTS = ['POSITIONS', 'OVERSPEED', 'IGNITION', 'FUEL', 'GEOFENCE_DISTANCE'] as const;

/** ReportResponse.archived: the period includes archived days, so rows / totals from raw points are incomplete. */
export interface ReportArchiveNotice {
  days: number;
  objects: number;
  firstDay: string;
  lastDay: string;
  message: string;
}
