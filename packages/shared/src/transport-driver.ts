/**
 * Employee transport (ETMS) contracts, phase E5: the driver API (`/api/driver/v1/*`), the offline-capable trip-event
 * command handler, and operational notifications (in-app inbox + generic push).
 *
 * Docs: docs/employee-transport/09 (driver app: state mapping, offline sync, pre-trip checks, minimum data), 05 §2.9 /
 * §3.8 / §5.5–5.6 (routes, events, push payloads), 10 (driver vs passenger permissions), 02 §8 (D7 push rules),
 * 12 §8 (E5 scope). Decisions: D2 (PlannedTrip statuses unchanged; plan §9 states derived), D4 (the vehicle GPS is the
 * tracker; the driver phone sends no location), D5 (driver = User with the "Transport driver" role linked through
 * Driver.userId; relationship-scoped access only to trips assigned to that driver), D7 / L4 (Expo → FCM / APNs push
 * with GENERIC payloads only; details are fetched through the authenticated API; the in-app history is authoritative).
 *
 * Conventions (05 §1): UUID ids, ISO-8601 UTC instants, service dates `YYYY-MM-DD` in the company's time zone.
 *
 * Authorisation (every `/api/driver/v1` route): menu `etms_driver` (`view` for reads, `edit` for commands) AND the
 * caller's own active Driver row (Driver.userId = caller, same company). The menu alone is never enough (an Admin
 * holds every menu): no linked driver → 403 `NOT_A_DRIVER`; linked but inactive → 403 `DRIVER_INACTIVE`. A trip that
 * is not assigned to the caller's driver (another driver's, another company's, unpublished, outside the window, or a
 * random id) → 404 `NOT_FOUND`, never 403.
 */
import type { PermissionMap } from './permissions';
import type { PlannedStopStatus, PlannedTripStatus } from './planned-trips';
import type { TransportDirection, TransportPassengerStatus, TransportTripDerivedState } from './transport-trips';

export const DRIVER_API_BASE = '/api/driver/v1';

// ───────────────────────────── Policy constants ─────────────────────────────

export const DRIVER_LIMITS = {
  /** Default trip window of the driver API (09 §3): plannedStart ∈ [now − pastHours, now + futureHours]. */
  windowPastHours: 12,
  windowFutureHours: 36,
  /** `GET /trips?from&to`: at most this many days. */
  maxRangeDays: 7,
  /** Events per `POST /trips/:id/events` batch (05 §2.9). */
  maxBatch: 50,
  /** occurredAt may be at most this far in the device's future (09 §6.4 clock rule). */
  maxFutureSkewMs: 2 * 60_000,
  /** occurredAt may be at most this far in the past (older events are LATE / rejected). */
  maxPastHours: 48,
  /**
   * Online-only commands (`POST /trips/:id/start`, `POST /duty/start`): the device timestamp must be at most this old
   * when the server receives it, else 409 `STALE_COMMAND` (an offline replay is never executed; 09 §4.4, Q-01 spirit).
   */
  onlineCommandMaxAgeMs: 2 * 60_000,
  /** A trip may be started from plannedStart − startEarlyMin until plannedEnd + startLateMin. */
  startEarlyMin: 60,
  startLateMin: 60,
  /** NO_SHOW is accepted only this many minutes after the stop's arrival (owner decision P5 / Q8 default). */
  noShowMinWaitMin: 5,
  /** ARRIVED: vehicle fix within k × stop radius → verified; clearly farther (fresh fix) → NOT_AT_STOP (Q8 default k = 3). */
  arrivalRadiusFactor: 3,
  /** ARRIVED: the vehicle fix counts only if it is at most this far from occurredAt. */
  arrivalFixMaxSkewMs: 2 * 60_000,
  /** Telemetry older than this at trip start → warning `TELEMETRY_STALE` (Q10 default: warn, not block). */
  telemetryFreshMs: 5 * 60_000,
  reasonCodeMax: 40,
  noteMax: 300,
  etaMaxMin: 600,
  /** In-app notifications per page. */
  notificationsPage: 50,
} as const;

// ───────────────────────────── Errors ─────────────────────────────

/** Codes of the driver API (HTTP errors and per-event REJECTED / RETRY outcomes). */
export const DRIVER_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'NOT_A_DRIVER',
  'DRIVER_INACTIVE',
  'DRIVER_DOCUMENTS_EXPIRED',
  'NOT_ASSIGNED',
  'TRIP_CLOSED',
  'TRIP_NOT_STARTED',
  'INVALID_STATE',
  'OUTSIDE_START_WINDOW',
  'VEHICLE_BUSY',
  'STALE_COMMAND',
  'ONLINE_ONLY',
  'NOT_AT_STOP',
  'STOP_NOT_ARRIVED',
  'WAIT_NOT_ELAPSED',
  'NOT_AT_DROP_STOP',
  'UNRESOLVED_PASSENGERS',
  'PASSENGERS_ON_BOARD',
  'CONFLICT',
  'OUT_OF_ORDER',
  'CLOCK_SKEW',
  'DUTY_OPEN',
  'NO_OPEN_DUTY',
  'IDEMPOTENCY_KEY_REUSED',
] as const;
export type DriverErrorCode = (typeof DRIVER_ERROR_CODES)[number];

// ───────────────────────────── Identity, duty ─────────────────────────────

/**
 * In-motion restrictions (09 §5.1): the bound vehicle's speed from the server's live state (the vehicle GPS; D4: never
 * the phone). The app treats > movingKph as moving and releases the lock after stationaryHoldSec below stationaryKph;
 * with no fresh fix (`stale`) it assumes stationary but shows the reduced UI.
 */
export const DRIVER_MOTION = { movingKph: 10, stationaryKph: 5, stationaryHoldSec: 10, freshMs: 120_000, pollSeconds: 10 } as const;

/** GET /api/driver/v1/trips/:id/motion (and `vehicleMotion` in the trip detail): live speed of the trip's vehicle. */
export interface DriverVehicleMotionDto {
  /** Last reported speed; null without a fix. */
  speedKph: number | null;
  /** speedKph > movingKph on a fresh fix; null when stale / no fix (the app then decides by its own policy). */
  moving: boolean | null;
  fixAt: string | null;
  /** No fix, or older than freshMs. */
  stale: boolean;
}

export interface DriverPolicyDto {
  windowPastHours: number;
  windowFutureHours: number;
  noShowMinWaitMin: number;
  /** R1: no passenger contact is ever shown to the driver ("call dispatcher" only; masked calling is out of scope). */
  passengerContact: 'NONE_R1';
  /** R1: the pre-trip checklist is not enforced yet (template storage is an open WP 5.0 item; owner decision P5). */
  checklistRequired: false;
  /** D4: the vehicle GPS is the tracker; the app never sends the phone's location. */
  phoneLocation: 'NOT_USED';
}

export interface DriverDutyDto {
  id: string;
  /** OPEN until ended. */
  status: 'OPEN' | 'ENDED';
  startedAt: string;
  endedAt: string | null;
  /** Vehicle bound at duty start (optional). */
  vehicle: { id: string; name: string; plateNumber: string | null } | null;
}

/** GET /api/driver/v1/me — who I am as a driver (403 NOT_A_DRIVER / DRIVER_INACTIVE otherwise). */
export interface DriverMeDto {
  driver: { id: string; name: string; firstName: string; employeeId: string | null };
  company: { id: string; name: string; timeZone: string };
  /** Licence status only (no number). `licenseValid` false = trips cannot be started. */
  documents: { licenseExpiry: string | null; licenseValid: boolean };
  duty: DriverDutyDto | null;
  policy: DriverPolicyDto;
  /** Unread in-app notifications. */
  unreadNotifications: number;
  /** The transport desk phone (company setting `etms.deskPhone`) for "Call dispatcher"; null when not set. */
  dispatcherPhone: string | null;
  serverTime: string;
}

/** GET /api/driver/v1/duty — today's duty (company time zone) and today's assigned trips. */
export interface DriverDutyTodayDto {
  serviceDate: string;
  timeZone: string;
  duty: DriverDutyDto | null;
  trips: DriverTripSummaryDto[];
  serverTime: string;
}

/**
 * POST /api/driver/v1/duty/start — ONLINE ONLY (never queued): occurredAt older than `onlineCommandMaxAgeMs` →
 * 409 STALE_COMMAND. A second start while a duty is open → 200 with the open duty (idempotent on clientEventId; a
 * different clientEventId → 409 DUTY_OPEN). `objectId`: a vehicle of the driver's company (404 otherwise). In R1 the
 * duty does NOT write a DriverAssignment (owner decision P5 open).
 */
export interface DriverDutyStartInput {
  clientEventId: string;
  occurredAt: string;
  objectId?: string | null;
}

/** POST /api/driver/v1/duty/end — 409 NO_OPEN_DUTY when none is open (a retried end with the same clientEventId → 200). */
export interface DriverDutyEndInput {
  clientEventId: string;
  occurredAt: string;
}

// ───────────────────────────── Trips ─────────────────────────────

/** Why the manifest (names, stop points) is not in a trip detail. */
export type DriverManifestHidden = 'TRIP_CLOSED' | null;

export interface DriverTripSummaryDto {
  /** TransportTrip id (used in every /trips/:id route). */
  id: string;
  version: number;
  serviceDate: string;
  direction: TransportDirection;
  name: string;
  derivedState: TransportTripDerivedState;
  plannedTripStatus: PlannedTripStatus | null;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  vehicle: { id: string; name: string; plateNumber: string | null } | null;
  stopCount: number;
  /** Active (non-cancelled) passengers. */
  passengerCount: number;
  acknowledgedAt: string | null;
  /** What the driver may do now (server-computed). */
  allowedActions: DriverTripAction[];
}

export type DriverTripAction = 'acknowledge' | 'start' | 'complete' | 'report';

export interface DriverStopDto {
  seq: number;
  /** Stop / pickup point label (a site name or the pickup point label; never a passenger name). Null when hidden. */
  label: string | null;
  /** Coordinates for the navigation hand-off; null once the manifest is hidden (trip closed). */
  lat: number | null;
  lng: number | null;
  radiusM: number;
  plannedArrival: string;
  actualArrival: string | null;
  actualDeparture: string | null;
  /** v1.8 stop status (GPS tracker or driver / dispatcher report). */
  status: PlannedStopStatus;
  /** Counts per stop (always present, also when the manifest is hidden). */
  pickups: number;
  drops: number;
  boarded: number;
  noShow: number;
  dropped: number;
  /** Active passengers picked up here whose outcome is not recorded yet. */
  pending: number;
}

/**
 * Minimum passenger manifest (09 §3.4 / §7.1, 10 §2.3 "first name, pickup point, trip window only"): server-side
 * projection, never filtered on the client. `displayName` = first name + last initial ("Asha K.") while the outcome
 * is not recorded; afterwards it collapses to "Passenger <n>". No employee code, address, department, phone or
 * e-mail — `contact` is always null in R1 (`contactPolicy` NONE_R1: no masked-call provider; "call dispatcher").
 */
export interface DriverPassengerDto {
  passengerTripId: string;
  /** 1-based position in the manifest (stable for the trip). */
  number: number;
  displayName: string;
  pickupSeq: number;
  dropSeq: number;
  seats: number;
  status: Exclude<TransportPassengerStatus, 'CANCELLED'>;
  /** Wheelchair / assistance needed (a flag only; no health notes). */
  accessibility: boolean;
  contact: null;
  contactPolicy: 'NONE_R1';
  /** Outcome events the driver may send now for this passenger. */
  allowedEvents: ('BOARDED' | 'NO_SHOW' | 'DROPPED')[];
}

/** Last delay / breakdown the driver reported on the trip (overlays, 09 §4.1; not trip states). */
export interface DriverTripOverlayDto {
  kind: 'DELAY' | 'BREAKDOWN';
  reasonCode: string | null;
  etaMin: number | null;
  reportedAt: string;
}

/** GET /api/driver/v1/trips/:id */
export interface DriverTripDetailDto extends DriverTripSummaryDto {
  stops: DriverStopDto[];
  /** Empty when `manifestHidden` is set. */
  passengers: DriverPassengerDto[];
  manifestHidden: DriverManifestHidden;
  /** Totals (always present). */
  counts: { passengers: number; boarded: number; noShow: number; dropped: number; pending: number };
  overlays: DriverTripOverlayDto[];
  /** Highest client `seq` the server has stored for this trip from the caller (09 §6.2 gap detection). */
  lastSeq: number | null;
  /** Live speed of the trip's vehicle while the trip is open (in-motion lock); null once closed. */
  vehicleMotion: DriverVehicleMotionDto | null;
  /** The operator's transport desk phone ("Call dispatcher"); null when not set. Never a passenger's number. */
  dispatcherPhone: string | null;
  serverTime: string;
}

export interface DriverTripListQuery {
  /** ISO instants; default the policy window. */
  from?: string;
  to?: string;
}

/** GET /api/driver/v1/trips/history — counts only, no names, no points (09 §5 history, §7.1). */
export interface DriverTripHistoryDto {
  id: string;
  serviceDate: string;
  direction: TransportDirection;
  name: string;
  plannedTripStatus: PlannedTripStatus | null;
  actualStart: string | null;
  actualEnd: string | null;
  stopCount: number;
  counts: { passengers: number; boarded: number; noShow: number; dropped: number; pending: number };
}

// ───────────────────────────── Start (online only) ─────────────────────────────

/**
 * POST /api/driver/v1/trips/:id/start — ONLINE ONLY. Guards (09 §4.3, R1 subset): driver active, licence not expired,
 * trip assigned + published + SCHEDULED, now within [plannedStart − startEarlyMin, plannedEnd + startLateMin], vehicle
 * on no other active trip, occurredAt fresh (else 409 STALE_COMMAND). Compare-and-set SCHEDULED → IN_PROGRESS. Already
 * started (GPS or dispatcher) → 200 with `outcome` ALREADY_STARTED. Same clientEventId again → the same answer.
 */
export interface DriverStartTripInput {
  clientEventId: string;
  occurredAt: string;
}

export interface DriverStartTripResult {
  outcome: 'STARTED' | 'ALREADY_STARTED';
  /** Non-blocking findings, e.g. TELEMETRY_STALE (the trip will be tracked once the vehicle reports). */
  warnings: string[];
  trip: DriverTripDetailDto;
}

// ───────────────────────────── Trip events (offline-queueable) ─────────────────────────────

/**
 * Events the driver app may queue offline and send in batches (09 §4.4). START_TRIP and duty start are NOT events:
 * they are online-only commands; a `START_TRIP` inside a batch is REJECTED with ONLINE_ONLY.
 */
export const DRIVER_TRIP_EVENT_TYPES = ['ACKNOWLEDGE', 'ARRIVED', 'BOARDED', 'NO_SHOW', 'DROPPED', 'DEPARTED', 'REPORT_DELAY', 'REPORT_BREAKDOWN', 'COMPLETE_TRIP'] as const;
export type DriverTripEventType = (typeof DRIVER_TRIP_EVENT_TYPES)[number];

/** Reason codes the app offers (open set server-side: any short code is stored; these are the localized ones). */
export const DRIVER_DELAY_REASONS = ['TRAFFIC', 'ROAD_BLOCKED', 'WEATHER', 'VEHICLE_ISSUE', 'PASSENGER_LATE', 'OTHER'] as const;
export const DRIVER_BREAKDOWN_REASONS = ['ENGINE', 'TYRE', 'ACCIDENT', 'FUEL', 'OTHER'] as const;
export const DRIVER_NO_SHOW_REASONS = ['NOT_AT_PICKUP', 'UNREACHABLE', 'CANCELLED_AT_DOOR', 'OTHER'] as const;

/**
 * One queued event. `clientEventId` = UUID (v7 recommended) generated when the driver taps, BEFORE any network call;
 * `seq` = monotonic counter per (install, trip), starting at 1; `occurredAt` = device time of the tap.
 *  - ARRIVED / DEPARTED: `stopSeq`.
 *  - BOARDED / NO_SHOW / DROPPED: `passengerTripId` (NO_SHOW: `reasonCode` recommended).
 *  - REPORT_DELAY: `reasonCode`, `etaMin` (minutes of delay expected). REPORT_BREAKDOWN: `reasonCode`, `note`.
 */
export interface DriverTripEventInput {
  clientEventId: string;
  seq: number;
  type: DriverTripEventType;
  occurredAt: string;
  /** Estimated device clock offset vs the server (server − device, ms) from the last response's `serverTime`. */
  clockOffsetMs?: number;
  stopSeq?: number;
  passengerTripId?: string;
  reasonCode?: string;
  etaMin?: number;
  note?: string;
}

/** POST /api/driver/v1/trips/:id/events — ≤ 50 events, FIFO. Evaluated in `seq` order (ties: occurredAt). */
export interface DriverTripEventBatchInput {
  events: DriverTripEventInput[];
}

/**
 * Per-event result (09 §6.3). The client deletes an event from its queue ONLY after one of these:
 *  - ACCEPTED: applied (state changed or recorded). CONFIRMED in the UI.
 *  - DUPLICATE: this clientEventId was seen before (the stored original outcome is in `original`), or the same fact is
 *    already recorded (e.g. BOARDED twice). CONFIRMED.
 *  - LATE: stored for the audit trail but changed nothing (trip already closed / cancelled). CONFIRMED (no effect).
 *  - REJECTED: terminal; `code` says why (show it, do not retry): NOT_AT_STOP, CONFLICT, NOT_ASSIGNED, …
 *  - RETRY: NOT stored; send again later (OUT_OF_ORDER: an earlier event of this trip has not arrived yet).
 * Never show a PENDING (unsent) or RETRY event as confirmed.
 */
export type DriverTripEventOutcome = 'ACCEPTED' | 'DUPLICATE' | 'LATE' | 'REJECTED' | 'RETRY';

export interface DriverTripEventResult {
  clientEventId: string;
  seq: number;
  outcome: DriverTripEventOutcome;
  code: DriverErrorCode | 'ALREADY_RECORDED' | null;
  /** DUPLICATE of an earlier send: what that send got. */
  original?: Exclude<DriverTripEventOutcome, 'RETRY'>;
  /** ARRIVED: how the arrival was checked against the vehicle GPS (09 §4.4). */
  verified?: 'gps' | 'unverified_location' | null;
  /** Server receipt time of the stored event (null for RETRY). */
  receivedAt: string | null;
}

export interface DriverTripEventBatchResult {
  results: DriverTripEventResult[];
  /** The trip after the batch (manifest hidden once closed); null when it is no longer assigned to the caller. */
  trip: DriverTripDetailDto | null;
  serverTime: string;
}

// ───────────────────────────── Sync (09 §6.4.5) ─────────────────────────────

/**
 * GET /api/driver/v1/sync?since=<cursor> — what changed since the cursor (an opaque ISO instant from the previous
 * answer; first call without it): trips upserted (refetch detail) or REVOKED (no longer mine / cancelled → wipe the
 * cached manifest), and the stored outcome of my events received since then (a reinstalled app converges).
 */
export interface DriverSyncDto {
  cursor: string;
  serverTime: string;
  trips: { id: string; version: number; change: 'UPSERT' | 'REVOKED'; plannedTripStatus: PlannedTripStatus | null }[];
  events: { tripId: string; clientEventId: string; seq: number | null; outcome: Exclude<DriverTripEventOutcome, 'RETRY'>; code: string | null; receivedAt: string }[];
  unreadNotifications: number;
}

// ───────────────────────────── Notifications (D7 / L4) ─────────────────────────────

/**
 * Notification kinds. Driver: assignment lifecycle of their trips. Passenger: trip reminders and live trip events
 * (05 §5.4, R1 scope). The push carries ONLY `{ kind, tripId, notificationId }` and the generic text below — no names,
 * phones, addresses, plates, coordinates or incident details; the app fetches details through the authenticated API.
 */
export const TRANSPORT_NOTIFICATION_KINDS = [
  'TRIP_ASSIGNED',
  'TRIP_CHANGED',
  'TRIP_UNASSIGNED',
  'TRIP_CANCELLED',
  'TRIP_STARTING_SOON',
  'VEHICLE_APPROACHING',
  'TRIP_DELAYED',
] as const;
export type TransportNotificationKind = (typeof TRANSPORT_NOTIFICATION_KINDS)[number];
export type TransportNotificationAudience = 'DRIVER' | 'PASSENGER';

export const DRIVER_NOTIFICATION_KINDS: readonly TransportNotificationKind[] = ['TRIP_ASSIGNED', 'TRIP_CHANGED', 'TRIP_UNASSIGNED', 'TRIP_CANCELLED'];
export const PASSENGER_NOTIFICATION_KINDS: readonly TransportNotificationKind[] = ['TRIP_STARTING_SOON', 'VEHICLE_APPROACHING', 'TRIP_DELAYED', 'TRIP_CANCELLED'];

/** Generic push / inbox text (English; apps localize by `kind`). Never interpolated with trip data. */
export const TRANSPORT_NOTIFICATION_TEXT: Record<TransportNotificationKind, { title: string; body: string }> = {
  TRIP_ASSIGNED: { title: 'New trip assigned', body: 'You have a new trip. Open the app for details.' },
  TRIP_CHANGED: { title: 'Trip updated', body: 'One of your trips has changed. Open the app for details.' },
  TRIP_UNASSIGNED: { title: 'Trip removed', body: 'A trip is no longer assigned to you.' },
  TRIP_CANCELLED: { title: 'Trip cancelled', body: 'A trip has been cancelled. Open the app for details.' },
  TRIP_STARTING_SOON: { title: 'Your trip starts soon', body: 'Your cab trip starts soon. Open the app for details.' },
  VEHICLE_APPROACHING: { title: 'Your cab is arriving', body: 'Your cab is approaching your pickup point.' },
  TRIP_DELAYED: { title: 'Trip delayed', body: 'Your cab is running late. Open the app for the latest time.' },
};

/** Android notification channel of ETMS pushes (lock-screen visibility PRIVATE, 02 §8.3); created by the app. */
export const TRANSPORT_PUSH_CHANNEL = 'trip';

/** The complete push `data` payload of an ETMS push (nothing else is ever added). */
export interface TransportPushData {
  kind: TransportNotificationKind;
  tripId: string | null;
  notificationId: string;
}

/** When the passenger reminders fire. */
export const TRANSPORT_NOTIFY_TIMING = {
  /** TRIP_STARTING_SOON: this many minutes before the passenger's planned pickup. */
  startingSoonMin: 30,
  /** VEHICLE_APPROACHING: when the tracker ETA to the passenger's pickup (next stop) is at most this many minutes. */
  approachingMin: 5,
  /** TRIP_DELAYED (from the tracker): when the live delay reaches this many minutes (a driver REPORT_DELAY always counts). */
  delayedMin: 10,
  /** Scheduler tick. */
  tickSeconds: 60,
} as const;

/** One in-app notification (the authoritative history; push is only a wake-up). */
export interface TransportNotificationDto {
  id: string;
  kind: TransportNotificationKind;
  title: string;
  body: string;
  tripId: string | null;
  createdAt: string;
  readAt: string | null;
  /** Whether a push was queued for it (false = in-app only: preference off, or no app signed in). */
  pushQueued: boolean;
}

/** GET …/notifications?before=<ISO>&unread=true */
export interface TransportNotificationListQuery {
  before?: string;
  unread?: 'true' | 'false';
}

/** POST …/notifications/read — mark as read; empty `ids` + `all: true` marks every one. */
export interface TransportNotificationReadInput {
  ids?: string[];
  all?: boolean;
}

/**
 * Passenger notification preferences (stored in EmployeeTransportProfile.preferences.notifications). The in-app record
 * is always written (operational history); these only switch the PUSH off. Drivers have no switch: assignment pushes
 * are operational and always sent while the app is signed in.
 */
export interface TransportNotificationPreferences {
  /** Master switch for push (default true). */
  push: boolean;
  /** Per-kind push switches (default true). */
  kinds: Partial<Record<TransportNotificationKind, boolean>>;
}

export const DEFAULT_TRANSPORT_NOTIFICATION_PREFERENCES: TransportNotificationPreferences = { push: true, kinds: {} };

/** Effective push decision for one passenger notification. */
export function passengerPushAllowed(prefs: unknown, kind: TransportNotificationKind): boolean {
  const n = (prefs as { notifications?: { push?: unknown; kinds?: Record<string, unknown> } } | null)?.notifications;
  if (n?.push === false) return false;
  return n?.kinds?.[kind] !== false;
}

// ───────────────────────────── Pure rules (shared by API and app for local projection) ─────────────────────────────

/** First name + last initial: "Asha Kumari Rao" → "Asha R."; one word → as is. */
export function driverDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Passenger';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Passenger outcomes the DRIVER app may record (stricter than the dispatcher: no corrections; first outcome wins). */
export function driverOutcomeAllowed(from: TransportPassengerStatus, to: 'BOARDED' | 'NO_SHOW' | 'DROPPED'): boolean {
  if (from === 'PENDING') return to === 'BOARDED' || to === 'NO_SHOW';
  if (from === 'BOARDED') return to === 'DROPPED';
  return false;
}

/** Plan §9 states a trip can be in for the driver's actions. */
export function driverTripActions(t: { plannedTripStatus: PlannedTripStatus | null; publishedAt: string | Date | null; acknowledgedAt: string | Date | null }): DriverTripAction[] {
  const out: DriverTripAction[] = [];
  const s = t.plannedTripStatus;
  if (s === 'SCHEDULED' && t.publishedAt && !t.acknowledgedAt) out.push('acknowledge');
  if (s === 'SCHEDULED' && t.publishedAt) out.push('start', 'report');
  if (s === 'STARTED' || s === 'IN_PROGRESS') out.push('complete', 'report');
  return out;
}

/**
 * Menus E5 adds to the ETMS role templates (P6): the driver may now send events (`etms_driver:edit`). Existing
 * companies' untouched "Transport driver" templates are upgraded by the etms_driver_ops migration backfill.
 */
export const ETMS_E5_TEMPLATE_PERMISSIONS: Record<string, PermissionMap> = {
  'Transport driver': { etms_driver: ['view', 'edit'] },
};

// ───────────────────────────── Passenger self-service additions (E5) ─────────────────────────────

/**
 * POST /api/me/transport/bookings/:id/cancel — the passenger's own booking, before its cut-off (409 AFTER_CUTOFF), not
 * on a trip that has started (409 INVALID_STATE). A seated booking frees its seat in the same transaction and under the
 * same locks as dispatch (booking, then trip). Idempotent: an already cancelled booking answers 200 with its state.
 * Audited; the trip's driver is told TRIP_CHANGED by the notification relay.
 */
export interface MeBookingCancelInput {
  reason?: string;
}

/** Consent channels a passenger may record themselves (`channel` on POST /api/me/transport/consent; default WEB). */
export const PASSENGER_SELF_CONSENT_CHANNELS = ['WEB', 'PASSENGER_APP'] as const;
export type PassengerSelfConsentChannel = (typeof PASSENGER_SELF_CONSENT_CHANNELS)[number];

/** Transport desk phone (Company.settings.etms.deskPhone): digits, spaces, + ( ) -, 5–20 characters. */
export const TRANSPORT_DESK_PHONE_RE = /^\+?[0-9 ()-]{5,20}$/;
