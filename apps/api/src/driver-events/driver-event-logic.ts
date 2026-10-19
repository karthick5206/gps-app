import { DriverEventSettings } from '@veetracer/shared';

/** A photo / clip matches an event of the same device captured from this long before to this long after it. */
export const MEDIA_MATCH_BEFORE_MS = 60_000;
export const MEDIA_MATCH_AFTER_MS = 3 * 60_000;
/** Clips kept per event. */
export const MAX_VIDEOS_PER_EVENT = 2;
/** Media that arrives before its event exists is retried this many times, this far apart. */
export const MEDIA_RETRY_ATTEMPTS = 4;
export const MEDIA_RETRY_DELAY_MS = 20_000;

/** Event whose time is closest to `at` within the match window, or null. */
export function pickEvent<E extends { id: string; occurredAt: Date }>(events: E[], at: Date): E | null {
  const t = at.getTime();
  let best: E | null = null;
  let bestD = Infinity;
  for (const e of events) {
    const d = t - e.occurredAt.getTime();
    if (d < -MEDIA_MATCH_BEFORE_MS || d > MEDIA_MATCH_AFTER_MS) continue;
    if (Math.abs(d) < bestD) {
      best = e;
      bestD = Math.abs(d);
    }
  }
  return best;
}

export interface MediaBudget {
  kind: 'PHOTO' | 'VIDEO';
  size: number;
  photos: number;
  videos: number;
  /** Bytes the company already stores. */
  usedBytes: number;
}

/** Why a new file must not be stored (per-event limits, company quota), or null when it may. */
export function mediaRejection(b: MediaBudget, s: Pick<DriverEventSettings, 'maxPhotos' | 'quotaMb'>): string | null {
  if (b.kind === 'PHOTO' && b.photos >= s.maxPhotos) return `event already has ${b.photos} photo(s)`;
  if (b.kind === 'VIDEO' && b.videos >= MAX_VIDEOS_PER_EVENT) return `event already has ${b.videos} clip(s)`;
  if (b.usedBytes + b.size > s.quotaMb * 1024 * 1024) return `storage quota of ${s.quotaMb} MB is full`;
  return null;
}

/** Driver assigned at `at` from assignment rows (newest first). */
export function driverAt(rows: { driverId: string; fromTime: Date; toTime: Date | null }[], at: Date): string | null {
  const t = at.getTime();
  return rows.find((r) => r.fromTime.getTime() <= t && (r.toTime === null || r.toTime.getTime() > t))?.driverId ?? null;
}
