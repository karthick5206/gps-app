/** Pure helpers for the driver events UI (unit-tested with node --test; no imports). */

export type EventStatus = 'NEW' | 'REVIEWED' | 'DISMISSED' | 'COACHED';

export const STATUS_LABEL: Record<EventStatus, string> = {
  NEW: 'New',
  REVIEWED: 'Reviewed',
  DISMISSED: 'Dismissed',
  COACHED: 'Coached',
};

export const STATUS_VARIANT: Record<EventStatus, 'secondary' | 'success' | 'muted' | 'default'> = {
  NEW: 'default',
  REVIEWED: 'success',
  DISMISSED: 'muted',
  COACHED: 'secondary',
};

/** Score band: 80+ good, 60–79 fair, below poor. */
export function scoreTone(score: number): 'good' | 'fair' | 'poor' {
  if (score >= 80) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

/** Previous / next ids around `id` in a list (for detail navigation). */
export function neighbours(ids: string[], id: string | null): { prev: string | null; next: string | null } {
  const i = id ? ids.indexOf(id) : -1;
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? ids[i - 1] : null, next: i < ids.length - 1 ? ids[i + 1] : null };
}

/** URL (relative) of the driver events page, optionally opening one event. */
export function driverEventsPath(opts: { event?: string; objectId?: string; driverId?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.objectId) q.set('objectId', opts.objectId);
  if (opts.driverId) q.set('driverId', opts.driverId);
  if (opts.event) q.set('event', opts.event);
  const s = q.toString();
  return s ? `/driver-events?${s}` : '/driver-events';
}
