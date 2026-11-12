/**
 * Employee transport (ETMS) contracts, phase E5 WP 5.4: durable SOS (passenger + driver raise, dispatcher ack /
 * resolve, web SOS lane, socket `transport.sos`).
 *
 * Docs: docs/employee-transport/05 §2.8 / §2.9 / §2.10 / §3.7 / §5.4 / §5.5 (routes, DTOs, events), 09 §4.4 (SOS is
 * never part of an offline batch), 10 §6 (Postgres-first incident + transactional outbox, honest delivery status,
 * device offline fallback), 12 §8 WP 5.4 (exit criteria).
 *
 * Rules every client must follow:
 * - `Idempotency-Key` header (UUID, made ONCE at tap time and stored with the queued SOS) is REQUIRED on create.
 *   Replays with the same key and body → the original receipt, header `Idempotent-Replay: true`. Same key, different
 *   body → 422 `IDEMPOTENCY_KEY_REUSED` (treat as delivered: the first request was stored).
 * - The device stores the SOS in its local queue BEFORE the first network call and retries with back-off until a
 *   2xx (or 422 `IDEMPOTENCY_KEY_REUSED`). Network errors, timeouts, 5xx and 429 are retried; nothing is ever
 *   dropped on the device side. SOS is sent on its own request, ahead of (never inside) a trip-event batch.
 * - A genuine SOS is never rejected for rate reasons: the server never answers 429 to an SOS create. Repeated SOS
 *   from the same raiser while their previous SOS is still OPEN / ACKNOWLEDGED attach to that incident (a REPEATED
 *   event) and answer its receipt with `merged: true`.
 * - A `tripId` the caller may not use (not their trip, unknown, other company) never fails the SOS: the incident is
 *   recorded without a trip link and the receipt says `tripLinked: false`.
 * - Honest wording (10 §6.3): `RECEIVED_BY_SERVER` means "VeeTrax received your SOS", never "help is on the way".
 *   Only `acknowledgement != null` may be shown as "acknowledged by the desk". If no acknowledgement arrives within
 *   `SOS_LIMITS.promptCallAfterMs`, prompt the user to call the emergency number / desk phone directly.
 * - ETMS SOS cannot be disabled, snoozed or suppressed while the caller has an active trip (10 §6.4); there is no
 *   setting that turns the endpoint off for an authenticated passenger / driver of an ETMS-enabled company.
 */

// ───────────────────────────── Routes ─────────────────────────────

export const SOS_ROUTES = {
  /** Passenger (menu `etms_self`, own identity). POST create (Idempotency-Key); GET `${passenger}/:id` = own receipt. */
  passenger: '/api/me/transport/sos',
  /** Driver (menu `etms_driver` + linked active Driver row). POST create (Idempotency-Key); GET `${driver}/:id`. */
  driver: '/api/driver/v1/sos',
  /** Dispatcher (menu `etms_incidents`). GET list (`?open=1` polled every 15 s while the socket is down), GET `/:id`,
   *  POST `/:id/ack` (AckIncidentRequest), POST `/:id/resolve` (ResolveIncidentRequest). */
  incidents: '/api/transport/incidents',
} as const;

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replay';

// ───────────────────────────── Limits ─────────────────────────────

export const SOS_LIMITS = {
  noteMax: 500,
  /** A fix older than this (vs server receive time) is kept but flagged `stale` in the dispatcher view. */
  fixStaleAfterMs: 10 * 60_000,
  /** Client hint: if not acknowledged within this time, offer "Call the desk / emergency number" prominently. */
  promptCallAfterMs: 60_000,
  /** Client retry back-off (ms) for a queued SOS: 1 s, 2 s, 5 s, 10 s, then every 15 s until accepted. */
  retryBackoffMs: [1_000, 2_000, 5_000, 10_000, 15_000] as readonly number[],
  /** Dispatcher lane poll interval while the socket is disconnected (05 §5.5). */
  lanePollMs: 15_000,
  ackNoteMax: 500,
  resolveNoteMax: 1_000,
} as const;

// ───────────────────────────── Enums ─────────────────────────────

export const INCIDENT_KINDS = ['SOS'] as const; // later: BREAKDOWN, ACCIDENT, … (E6)
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_RAISER_TYPES = ['PASSENGER', 'DRIVER', 'DISPATCHER'] as const;
export type IncidentRaiserType = (typeof INCIDENT_RAISER_TYPES)[number];

/** Append-only incident history (TransportIncidentEvent.kind). */
export const INCIDENT_EVENT_KINDS = ['CREATED', 'REPEATED', 'NOTIFY_PUBLISHED', 'NOTIFY_DIRECT', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentEventKind = (typeof INCIDENT_EVENT_KINDS)[number];

export const INCIDENT_RESOLUTIONS = ['ASSISTED', 'FALSE_ALARM', 'TEST', 'DUPLICATE', 'OTHER'] as const;
export type IncidentResolution = (typeof INCIDENT_RESOLUTIONS)[number];

/** Dispatcher-notification state of the incident's SAFETY outbox message (honest: never "delivered"). */
export const SOS_NOTIFY_STATES = ['QUEUED', 'SENT_TO_DISPATCH', 'FAILED'] as const;
export type SosNotifyState = (typeof SOS_NOTIFY_STATES)[number];

export type SosErrorCode =
  | 'VALIDATION'               // 400: bad body / missing or non-UUID Idempotency-Key
  | 'IDEMPOTENCY_KEY_REUSED'   // 422: same key, different body (the first SOS IS stored)
  | 'NOT_A_DRIVER'             // 403 (driver route only)
  | 'DRIVER_INACTIVE'          // 403 (driver route only)
  | 'NOT_FOUND'                // 404: GET of an incident that is not the caller's / not in scope
  | 'NOTE_REQUIRED'            // 400: ack / resolve without a note
  | 'INVALID_TRANSITION';      // 409: ack of a RESOLVED incident, resolve twice

// ───────────────────────────── Raise (passenger + driver) ─────────────────────────────

export interface SosFix {
  lat: number;
  lng: number;
  accuracyM?: number;
  /** ISO-8601 time the fix was taken on the device. */
  at: string;
}

/** POST body (05 §3.7). Header `Idempotency-Key` = clientIncidentId (UUID). The fix is optional and only sent with the
 *  SOS_LOCATION consent (passenger) — a missing fix never blocks the SOS. */
export interface CreateSosRequest {
  tripId?: string;
  fix?: SosFix;
  /** ≤ SOS_LIMITS.noteMax characters; free text, shown to the dispatcher only. */
  note?: string;
  /** ISO-8601 tap time on the device (offline replays may be late; the server records both times). */
  raisedAt?: string;
}

/** 201 on first receipt, 200 on replay / merge. */
export interface SosReceipt {
  incidentId: string;
  status: 'RECEIVED_BY_SERVER';
  /** Server time the incident was first committed. */
  receivedAt: string;
  incidentStatus: IncidentStatus;
  /** Null until a dispatcher acknowledged. `by` is a display first name only. */
  acknowledgement: { by: string; at: string } | null;
  resolvedAt: string | null;
  /** True when this request attached to the caller's already-open SOS (repeat press / second device). */
  merged: boolean;
  /** False when a `tripId` was given but could not be linked (the SOS is still recorded). */
  tripLinked: boolean;
  notify: SosNotifyState;
}

// ───────────────────────────── Dispatcher (web SOS lane) ─────────────────────────────

export interface IncidentListItem {
  id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  raiserType: IncidentRaiserType;
  /** Display name of the raiser as permitted by scope (passenger: first name + employee code; driver: name). */
  raiserLabel: string;
  tripId: string | null;
  tripLabel: string | null;
  vehiclePlate: string | null;
  raisedAt: string;
  receivedAt: string;
  lastFix: (SosFix & { stale: boolean }) | null;
  repeatCount: number;
  notify: SosNotifyState;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
}

export interface IncidentEventDto {
  id: string;
  kind: IncidentEventKind;
  at: string;
  actorLabel: string | null;
  note: string | null;
  resolution?: IncidentResolution;
}

export interface IncidentDetail extends IncidentListItem {
  note: string | null;
  resolution: IncidentResolution | null;
  events: IncidentEventDto[];
}

export interface IncidentListResponse {
  items: IncidentListItem[];
  /** Number of OPEN (unacknowledged) incidents in scope — drives the bell mirror badge. */
  openCount: number;
}

export interface AckIncidentRequest {
  /** Required, 1..SOS_LIMITS.ackNoteMax (05 §2.10: "Ack (note required)"). */
  note: string;
}

export interface ResolveIncidentRequest {
  resolution: IncidentResolution;
  /** Required, 1..SOS_LIMITS.resolveNoteMax. */
  note: string;
}

// ───────────────────────────── Socket / outbox ─────────────────────────────

/** `/live` socket event name (05 §5.5), emitted immediately (not batched) to rooms with `etms_incidents:view` + scope. */
export const SOS_SOCKET_EVENT = 'transport.sos';

/** Small payload; clients refetch details over REST. */
export interface TransportSosSocketPayload {
  incidentId: string;
  kind: IncidentKind;
  tripId: string | null;
  vehicle: string | null;
  raisedAt: string;
  status: IncidentStatus;
}

/** Outbox event types (05 §5.4), class SAFETY. */
export const SOS_OUTBOX_TYPES = {
  created: 'transport.incident.created',
  acknowledged: 'transport.incident.acknowledged',
  resolved: 'transport.incident.resolved',
} as const;

// ───────────────────────────── Helpers ─────────────────────────────

/** What the raiser's app may say. Never claims help is coming before an acknowledgement. */
export type SosClientStage = 'QUEUED_ON_DEVICE' | 'RECEIVED' | 'ACKNOWLEDGED' | 'RESOLVED';

export function sosClientStage(receipt: SosReceipt | null | undefined): SosClientStage {
  if (!receipt) return 'QUEUED_ON_DEVICE';
  if (receipt.incidentStatus === 'RESOLVED' || receipt.resolvedAt) return 'RESOLVED';
  if (receipt.acknowledgement) return 'ACKNOWLEDGED';
  return 'RECEIVED';
}

/** Whether a client should keep retrying a queued SOS after this HTTP status (undefined = network error). */
export function sosShouldRetry(httpStatus: number | undefined): boolean {
  if (httpStatus === undefined) return true;
  if (httpStatus >= 200 && httpStatus < 300) return false;
  if (httpStatus === 422) return false; // IDEMPOTENCY_KEY_REUSED: the first request is stored
  if (httpStatus === 401) return true;  // re-auth then retry; never drop
  return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && UUID_RE.test(key);
}
