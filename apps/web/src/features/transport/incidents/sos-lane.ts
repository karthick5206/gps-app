/**
 * Dispatcher SOS lane helpers (pure, `node --test`; WP 5.4, doc 07 §4.2 / §6.5, doc 05 §2.10 / §5.5). The lane reads
 * PostgreSQL through `GET /api/transport/incidents?open=1`; the `transport.sos` socket event only makes it refresh
 * sooner. While the socket is down the lane polls every 15 s (pushes during a gap are lost by design); while it is up
 * it still polls every 60 s, so an SOS relayed by another API instance during a Valkey outage is never missed.
 */
import {
  SOS_LIMITS,
  type IncidentListItem,
  type IncidentResolution,
  type IncidentStatus,
  type SosNotifyState,
  type TransportSosSocketPayload,
} from '@veetracer/shared';

export const INCIDENTS_ENDPOINT = '/transport/incidents';
export const INCIDENTS_PATH = '/transport/incidents';
/** Poll while the socket is connected (safety net); while disconnected SOS_LIMITS.lanePollMs (15 s). */
export const LANE_POLL_CONNECTED_MS = 60_000;

export function lanePollMs(socketConnected: boolean): number {
  return socketConnected ? LANE_POLL_CONNECTED_MS : SOS_LIMITS.lanePollMs;
}

/** OPEN first, the longest-waiting on top; then acknowledged, newest first; resolved last. */
export function sortLane<T extends Pick<IncidentListItem, 'status' | 'receivedAt'>>(items: readonly T[]): T[] {
  const rank: Record<IncidentStatus, number> = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
  return [...items].sort((a, b) => {
    const r = rank[a.status] - rank[b.status];
    if (r) return r;
    const d = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
    return a.status === 'OPEN' ? d : -d;
  });
}

/** The SOS the top banner shows: the oldest OPEN one (cannot be dismissed until acknowledged). */
export function bannerIncident<T extends Pick<IncidentListItem, 'status' | 'receivedAt'>>(items: readonly T[] | undefined): T | null {
  return sortLane((items ?? []).filter((i) => i.status === 'OPEN'))[0] ?? null;
}

/** "0:42", "12:05", "1:02:09" since `iso` (ticking timer of an SOS card). */
export function elapsed(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** An OPEN SOS seen for the first time since the lane loaded (rings the siren once per incident). */
export function newOpenIds(previous: ReadonlySet<string>, items: readonly Pick<IncidentListItem, 'id' | 'status'>[]): string[] {
  return items.filter((i) => i.status === 'OPEN' && !previous.has(i.id)).map((i) => i.id);
}

/** Socket payload → should the lane refetch now? Always for a valid payload (details come over REST). */
export function isSosPayload(p: unknown): p is TransportSosSocketPayload {
  const x = p as Partial<TransportSosSocketPayload> | null;
  return !!x && typeof x.incidentId === 'string' && typeof x.status === 'string';
}

/** Honest wording of the dispatcher-notification state (never "delivered"). English keys, translated with t(). */
export const NOTIFY_LABEL: Record<SosNotifyState, string> = {
  QUEUED: 'Notifying dispatchers…',
  SENT_TO_DISPATCH: 'Sent to dispatchers',
  FAILED: 'Notification failed',
};

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: 'Open — needs acknowledgement',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

export const RESOLUTION_LABEL: Record<IncidentResolution, string> = {
  ASSISTED: 'Assisted',
  FALSE_ALARM: 'False alarm',
  TEST: 'Test',
  DUPLICATE: 'Duplicate',
  OTHER: 'Other',
};

export const RAISER_LABEL: Record<IncidentListItem['raiserType'], string> = {
  PASSENGER: 'Passenger',
  DRIVER: 'Driver',
  DISPATCHER: 'Dispatcher',
};

/** Incident history entries (TransportIncidentEvent.kind). */
export const EVENT_LABEL: Record<string, string> = {
  CREATED: 'SOS raised',
  REPEATED: 'SOS pressed again',
  NOTIFY_PUBLISHED: 'Dispatchers notified',
  NOTIFY_DIRECT: 'Dispatchers notified directly (cache down)',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

/** Client-side note rule (the server enforces the same): required, trimmed, ≤ max. */
export function noteError(note: string, max: number): string | null {
  const n = note.trim();
  if (!n) return 'A note is required: write what was done.';
  if (n.length > max) return 'The note is too long.';
  return null;
}

/** Every English string this feature shows (the i18n test checks hi + ta for each). */
export const SOS_LANE_STRINGS: readonly string[] = [
  ...Object.values(NOTIFY_LABEL),
  ...Object.values(STATUS_LABEL),
  ...Object.values(RESOLUTION_LABEL),
  ...Object.values(RAISER_LABEL),
  ...Object.values(EVENT_LABEL),
  'A note is required: write what was done.',
  'The note is too long.',
];
