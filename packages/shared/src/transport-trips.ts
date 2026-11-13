/**
 * Employee transport (ETMS) contracts, phase E3: shifts, recurring schedules, bookings, dispatch (manual / assisted
 * assignment published into PlannedTrip), dispatcher trip progression and the passenger's own read-only trip view.
 * Docs: docs/employee-transport/02 §5–6, 05 §2.4–2.8 / §3 / §4, 12 §5, 15 §5. Decisions: D2 (PlannedTrip reused,
 * statuses unchanged, milestones as timestamps, per-passenger outcomes), D8 (R1 scope), P2 (one customer per trip,
 * shuttles via Route, door-to-door daily trips with "repeat to date"), condition A (no driver app: the dispatcher
 * advances trips and records boarding / no-show; vehicle GPS is never proof of boarding).
 *
 * Conventions (05 §1): UUID ids, ISO-8601 UTC instants, service dates `YYYY-MM-DD` in the shift's time zone, every DTO
 * with a local time carries `timeZone`, coordinates as `{ lat, lng }` objects (never bare arrays), `version` +
 * `expectedVersion` on mutable aggregates (409 VERSION_CONFLICT), `Idempotency-Key` header on booking create and
 * change-set publish (replay → same response + header `Idempotent-Replay: true`; same key, other body → 422
 * IDEMPOTENCY_KEY_REUSED). Other tenants' ids → 404.
 */
import type { PlannedStopStatus, PlannedTripOrigin, PlannedTripStatus, RoutePath } from './planned-trips';
import type { PermissionMap } from './permissions';
import type { PlaceRef } from './transport-people';

// ───────────────────────────── Enumerations ─────────────────────────────

/** IN = to the site (login), OUT = from the site (logout). */
export const TRANSPORT_DIRECTIONS = ['IN', 'OUT'] as const;
export type TransportDirection = (typeof TRANSPORT_DIRECTIONS)[number];

export const TRANSPORT_PICKUP_MODES = ['HOME', 'STOP'] as const;
export type TransportPickupMode = (typeof TRANSPORT_PICKUP_MODES)[number];

export const TRANSPORT_EXCEPTION_KINDS = ['SKIP', 'OVERRIDE'] as const;
export type TransportExceptionKind = (typeof TRANSPORT_EXCEPTION_KINDS)[number];

export const TRANSPORT_BOOKING_SOURCES = ['ADHOC', 'SCHEDULE'] as const;
export type TransportBookingSource = (typeof TRANSPORT_BOOKING_SOURCES)[number];

/**
 * WP 3.9 (D-A2): the shape of a booking's journey. COMMUTE: one end is an office (the shift's site, a company place or a
 * one-time point), `direction` IN / OUT says which; at most one active COMMUTE booking per passenger, date and direction
 * (DB partial unique index, 409 BOOKING_DUPLICATE). POINT_TO_POINT: any pickup to any destination, no office end; both
 * points and the time window are required, the shift is optional, `direction` is stored as IN (pickups before drops on
 * the trip); an active POINT_TO_POINT booking may not overlap another active booking of the same passenger in time
 * (409 BOOKING_OVERLAP). Schedules always generate COMMUTE.
 */
export const TRANSPORT_BOOKING_JOURNEYS = ['COMMUTE', 'POINT_TO_POINT'] as const;
export type TransportBookingJourney = (typeof TRANSPORT_BOOKING_JOURNEYS)[number];

/**
 * WP 3.9 error codes of booking create / edit (besides the E3 ones: BOOKING_DUPLICATE, AFTER_CUTOFF, VALIDATION_FAILED,
 * VERSION_CONFLICT, INVALID_STATE, RATE_LIMITED, IDEMPOTENCY_KEY_REUSED):
 *   LATE_REASON_REQUIRED (409) — after the cut-off a dispatcher must give `lateReason` (≥ lateReasonMin chars, trimmed);
 *   NOT_ELIGIBLE (422)         — the shared eligibility rule failed; body `{ code, message, reason: TransportIneligibleReason }`;
 *   CONSENT_REQUIRED (409)     — a personal point (any point that is not a company place) without an active routing consent;
 *   BOOKING_OVERLAP (409)      — POINT_TO_POINT overlapping another active booking of the passenger; body `{ bookingId }`.
 */
export const TRANSPORT_INELIGIBLE_REASONS = ['PASSENGER_INACTIVE', 'PASSENGER_ANONYMISED', 'SHIFT_INACTIVE', 'SHIFT_NOT_RUNNING', 'PLACE_NOT_ALLOWED', 'SEATS_NOT_ALLOWED'] as const;
export type TransportIneligibleReason = (typeof TRANSPORT_INELIGIBLE_REASONS)[number];

/** GET /api/transport/bookings/policy (WP 3.9): what the desk's booking form needs to know (company cut-off and limits). */
export interface TransportBookingPolicyDto {
  /** Company booking cut-off in minutes before the window start (Company.settings.etms.bookingCutoffMin or the default). */
  cutoffMin: number;
  /** Ad-hoc service date at most this many days ahead. */
  maxDaysAhead: number;
  lateReasonMin: number;
  lateReasonMax: number;
}

/** A company place a booking may use as pickup / destination (GET /api/transport/bookings/places?q=): active Pois of the customer company. */
export interface TransportPlaceOptionDto {
  id: string;
  name: string;
  category: string | null;
  lat: number;
  lng: number;
}

/**
 * Booking lifecycle (05 §3, 02 §5.2). REQUESTED (held for approval) → PENDING_ASSIGNMENT (approved, waiting for a
 * seat) → ASSIGNED (seated on a published trip) → CONFIRMED. Terminal: REJECTED, CANCELLED, EXPIRED (window passed
 * unassigned), FAILED (reserved). WAITLISTED is reserved for capacity policies (E6) and approvable like REQUESTED.
 */
export const TRANSPORT_BOOKING_STATUSES = ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'WAITLISTED', 'FAILED'] as const;
export type TransportBookingStatus = (typeof TRANSPORT_BOOKING_STATUSES)[number];

/** Statuses covered by the "one active booking per passenger, date, direction" partial unique index. */
export const ACTIVE_BOOKING_STATUSES: readonly TransportBookingStatus[] = ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'WAITLISTED'];
/** Final statuses: no command changes them. */
export const FINAL_BOOKING_STATUSES: readonly TransportBookingStatus[] = ['REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'];

/** Per-passenger state on a trip (D2). BOARDED / NO_SHOW / DROPPED are set only by the dispatcher (WEB) or the driver app (E5). */
export const TRANSPORT_PASSENGER_STATUSES = ['PENDING', 'BOARDED', 'NO_SHOW', 'DROPPED', 'CANCELLED'] as const;
export type TransportPassengerStatus = (typeof TRANSPORT_PASSENGER_STATUSES)[number];

/** Outcomes the dispatcher can record for a passenger (`POST …/passengers/:passengerTripId/outcome`). */
export const TRANSPORT_PASSENGER_OUTCOMES = ['BOARDED', 'NO_SHOW', 'DROPPED'] as const;
export type TransportPassengerOutcome = (typeof TRANSPORT_PASSENGER_OUTCOMES)[number];

/** Who recorded an outcome. The database refuses BOARDED / NO_SHOW / DROPPED from any other source (GPS, SYSTEM). */
export const TRANSPORT_OUTCOME_SOURCES = ['WEB', 'DRIVER_APP'] as const;
export type TransportOutcomeSource = (typeof TRANSPORT_OUTCOME_SOURCES)[number];

export const TRANSPORT_CHANGE_SET_STATUSES = ['DRAFT', 'PUBLISHED', 'REJECTED'] as const;
export type TransportChangeSetStatus = (typeof TRANSPORT_CHANGE_SET_STATUSES)[number];

/** Event kinds written to TransportTripEvent by E3 (open set; E5 adds the driver-app kinds of 05 §3.8). */
export const TRANSPORT_TRIP_EVENT_KINDS = [
  'PUBLISHED',
  'CHANGED',
  'PASSENGER_ADDED',
  'PASSENGER_REMOVED',
  'VEHICLE_CHANGED',
  'DRIVER_CHANGED',
  'STOP_ADDED',
  'ACKNOWLEDGE',
  'STARTED',
  'ARRIVED',
  'BOARDED',
  'NO_SHOW',
  'DROPPED',
  'COMPLETED',
  'CANCELLED',
  /** SYSTEM, security review M1: a NO_SHOW followed an arrival the vehicle GPS could not confirm; dispatcher to check. */
  'NO_SHOW_REVIEW',
  /** SYSTEM, re-check R-3: BOARDED / DROPPED recorded after such an arrival; dispatcher to check. */
  'OUTCOME_REVIEW',
  /** PASSENGER, E5 WP 5.3: the passenger confirmed pickup / drop in the app (dispute signal only, owner decision P5). */
  'PASSENGER_CONFIRM',
  /** PASSENGER, E5 WP 5.3: the passenger reported a delay / missed pickup / concern (reasonCode = category). */
  'PASSENGER_REPORT',
] as const;
export type TransportTripEventKind = (typeof TRANSPORT_TRIP_EVENT_KINDS)[number];
export type TransportTripActorType = 'DISPATCHER' | 'DRIVER' | 'PASSENGER' | 'SYSTEM';
export type TransportTripEventSource = 'WEB' | 'DRIVER_APP' | 'PASSENGER_APP' | 'SYSTEM';
export type TransportTripEventOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'LATE';

/**
 * Plan §9 trip states derived from PlannedTrip + TransportTrip (02 §5.2; no second status column, D2). R1 subset:
 * PLANNED (header not published) · PUBLISHED · DRIVER_ACKNOWLEDGED · EN_ROUTE (started, next stop not reached) ·
 * AT_STOP (a stop ARRIVED with passengers whose outcome is not recorded) · IN_PROGRESS · COMPLETED · INCOMPLETE ·
 * CANCELLED · DETACHED (the PlannedTrip was purged with its vehicle; the header survives).
 */
export const TRANSPORT_TRIP_DERIVED_STATES = ['PLANNED', 'PUBLISHED', 'DRIVER_ACKNOWLEDGED', 'EN_ROUTE', 'AT_STOP', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE', 'CANCELLED', 'DETACHED'] as const;
export type TransportTripDerivedState = (typeof TRANSPORT_TRIP_DERIVED_STATES)[number];

// ───────────────────────────── Limits and timing ─────────────────────────────

export const TRANSPORT_E3_LIMITS = {
  /** Rolling generator horizon (12 WP 3.2). */
  generatorHorizonHours: 72,
  /** Generator / expiry sweep tick. */
  generatorTickMin: 15,
  /** Default booking cut-off before the window start (minutes); company setting `etms.bookingCutoffMin` overrides. */
  defaultCutoffMin: 60,
  /** IN window: [login − inWindowMin, login]; OUT window: [logout, logout + outWindowMin]. */
  inWindowMin: 90,
  outWindowMin: 90,
  /** Ad-hoc booking service date at most this many days ahead. */
  adhocMaxDaysAhead: 60,
  /** WP 3.9 (D-A1): minimum trimmed length of a dispatcher's late-booking reason. */
  lateReasonMin: 10,
  lateReasonMax: 300,
  maxPassengerCount: 6,
  noteMax: 500,
  reasonMax: 300,
  nameMax: 120,
  /** Bulk schedule create / bulk approve. */
  maxBulk: 500,
  /** Change-set size. */
  maxChanges: 200,
  /** Stops of one ad-hoc trip. */
  maxStops: 60,
  /** Repeat-to-date horizon (days after the source trip's date). */
  repeatMaxDays: 31,
  /** Booking creates per user per minute before 429 RATE_LIMITED. */
  bookingCreatesPerMinute: 60,
  /** Passenger self view: trips listed by default from today − 1 to today + 7 (local), at most 31 days. */
  meDefaultPastDays: 1,
  meDefaultFutureDays: 7,
  meMaxRangeDays: 31,
  // ── E3 security review limits (L2, L4, L5, L6; M2 / M5 tolerances) ──
  /** Passenger vehicle polls per user per trip per minute (the app polls every 15 s) before 429 RATE_LIMITED. */
  meVehiclePerMinute: 6,
  /** Road-routing (GraphHopper) calls one change set may make; beyond it a trip is saved without a path (warning). */
  routingCallsPerChangeSet: 20,
  /** Candidate searches per user per minute before 429 RATE_LIMITED. */
  candidatesPerMinute: 30,
  /** Change-set submissions (publish or draft) per user per minute before 429 RATE_LIMITED. */
  changeSetsPerMinute: 20,
  /** Open DRAFT change sets per company and service date. */
  draftsPerServiceDate: 50,
  /** Bulk-approve requests per user per minute. */
  bulkApprovesPerMinute: 10,
  /** Schedule preview range (days). */
  previewMaxDays: 7,
  /** A door-to-door stop that is not a company place must be within this distance of a consented booking end (m). */
  personalStopMatchM: 30,
  /** Erasure / consent withdrawal: stops and draft stops within this distance of the passenger's points are theirs (m). */
  personalPointNearM: 50,
} as const;

/**
 * The passenger sees the trip's vehicle only inside the trip window (05 §2.8, 10 §4.3): from planned start −
 * `beforeStartMin` (or the actual start, if earlier) until the passenger is dropped / the trip ends, plus
 * `afterEndMin` grace. Never for a cancelled trip or a passenger marked NO_SHOW / CANCELLED. Polling only (no socket).
 */
export const ME_VEHICLE_WINDOW = { beforeStartMin: 30, afterEndMin: 10, pollSeconds: 15 } as const;

// ───────────────────────────── Shared shapes ─────────────────────────────

/** A point with optional label / place (05 §3: home pickups stay on the booking, never a Poi). */
export interface GeoPoint {
  lat: number;
  lng: number;
  label?: string | null;
  poiId?: string | null;
}

/** Passenger reference shown on bookings, schedules and manifests. */
export interface TransportPassengerRef {
  id: string;
  displayName: string;
  employeeCode: string;
}

/**
 * ETA with provenance (05 §3.3): `model` ROAD = GraphHopper road time; null with `degraded` when routing is down or no
 * fix exists. Never a fabricated number: no straight-line / speed guesses.
 */
export interface EtaValue {
  at: string | null;
  model: 'ROAD' | 'TRACKER' | null;
  durationSec?: number | null;
  /** NO_PICKUP: the booking has no pickup point the caller may route to (none stored, or withheld without consent). */
  degraded?: 'ROUTING_UNAVAILABLE' | 'NO_FIX' | 'NO_ROUTE' | 'NO_PICKUP' | null;
  /**
   * ROAD only: where the estimate starts. VEHICLE_FIX = the idle vehicle's last fix → pickup, from now. TRIP_STOP = the
   * trip's planned stop `fromStopSeq` → pickup, from that stop's planned departure (the trip has not started). Always
   * a road estimate without live traffic (GraphHopper), never a straight-line guess.
   */
  from?: 'VEHICLE_FIX' | 'TRIP_STOP' | null;
  fromStopSeq?: number | null;
}

// ───────────────────────────── Shifts ─────────────────────────────

export interface TransportShiftDto {
  id: string;
  name: string;
  site: PlaceRef | null;
  /** Local minutes after midnight. */
  startMin: number;
  endMin: number;
  /** endMin < startMin: logout on the next day. */
  overnight: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  timeZone: string;
  isActive: boolean;
  /** Active schedules on this shift. */
  scheduleCount: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/transport/shifts. `overnight` is derived (endMin < startMin); `timeZone` defaults to the company's. */
export interface CreateTransportShiftInput {
  name: string;
  sitePoiId?: string | null;
  startMin: number;
  endMin: number;
  days: number[];
  timeZone?: string;
}

/** PATCH /api/transport/shifts/:id. */
export interface UpdateTransportShiftInput {
  name?: string;
  sitePoiId?: string | null;
  startMin?: number;
  endMin?: number;
  days?: number[];
  timeZone?: string;
  isActive?: boolean;
}

export interface TransportShiftListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'startMin' | 'createdAt';
  order?: 'asc' | 'desc';
  status?: 'ACTIVE' | 'INACTIVE';
  siteId?: string;
  format?: 'json' | 'csv';
}

// ───────────────────────────── Schedules ─────────────────────────────

export interface TransportScheduleDto {
  id: string;
  version: number;
  passenger: TransportPassengerRef;
  shiftId: string;
  shiftName: string;
  direction: TransportDirection;
  days: number[];
  pickupMode: TransportPickupMode;
  stop: PlaceRef | null;
  /** YYYY-MM-DD. */
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  timeZone: string;
  /** Passenger has no usable pickup (no consent, no home point, no stop): generated bookings will need a location. */
  needsLocation: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /api/transport/schedules — bulk create by selection: one schedule per passenger × direction. `days` defaults to
 * the shift's days and must be a subset of them. STOP needs `stopPoiId` (a SHUTTLE_STOP / any place of the company).
 */
export interface CreateTransportSchedulesInput {
  profileIds: string[];
  shiftId: string;
  directions: TransportDirection[];
  days?: number[];
  pickupMode: TransportPickupMode;
  stopPoiId?: string | null;
  validFrom: string;
  validTo?: string | null;
}

export interface CreateTransportSchedulesResult {
  created: TransportScheduleDto[];
  /** Bookings the generator created right away for the next 72 h. */
  generatedBookings: number;
}

/** PATCH /api/transport/schedules/:id. Future unassigned bookings are regenerated from the new pattern. */
export interface UpdateTransportScheduleInput {
  expectedVersion: number;
  shiftId?: string;
  days?: number[];
  pickupMode?: TransportPickupMode;
  stopPoiId?: string | null;
  validFrom?: string;
  validTo?: string | null;
  isActive?: boolean;
}

export interface TransportScheduleListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'validFrom' | 'passenger';
  order?: 'asc' | 'desc';
  status?: 'ACTIVE' | 'INACTIVE';
  profileId?: string;
  shiftId?: string;
  direction?: TransportDirection;
  format?: 'json' | 'csv';
}

/** Override of one date: another login / logout time and / or another pickup point. */
export interface TransportScheduleOverride {
  /** Local minutes after midnight replacing the shift's login (IN) / logout (OUT) time. */
  timeMin?: number;
  pickup?: GeoPoint;
}

export interface TransportScheduleExceptionDto {
  id: string;
  scheduleId: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: TransportExceptionKind;
  override: TransportScheduleOverride | null;
  reason: string | null;
  createdAt: string;
}

/** POST /api/transport/schedules/:id/exceptions. SKIP cancels that date's unassigned booking; OVERRIDE re-times it. */
export interface CreateTransportScheduleExceptionInput {
  date: string;
  kind: TransportExceptionKind;
  override?: TransportScheduleOverride;
  reason?: string;
}

/** GET /api/transport/schedules/preview?from&to — what the generator will do (nothing is written). */
export interface TransportSchedulePreviewDto {
  from: string;
  to: string;
  schedules: number;
  /** Bookings that would be created now. */
  wouldCreate: number;
  /** Occurrences that already have a booking. */
  existing: number;
  skippedByException: number;
  /** Occurrences whose passenger already has another active booking that day / direction. */
  skippedDuplicate: number;
  /** Of `wouldCreate`: without a usable pickup point (consent / home / stop missing). */
  needsLocation: number;
  byDate: { date: string; direction: TransportDirection; count: number }[];
}

// ───────────────────────────── Bookings ─────────────────────────────

export type TransportBookingAction = 'edit' | 'cancel' | 'approve' | 'reject';

export interface TransportBookingDto {
  id: string;
  version: number;
  status: TransportBookingStatus;
  statusReason: string | null;
  source: TransportBookingSource;
  passenger: TransportPassengerRef;
  scheduleId: string | null;
  shiftId: string | null;
  shiftName: string | null;
  serviceDate: string;
  direction: TransportDirection;
  timeZone: string;
  /**
   * Company sites (poiId set) always. Personal points (home / ad-hoc address) only on the booking detail and the dispatch
   * board, and only while the passenger's routing consent is active (E2 security review M3); never in list rows or the
   * CSV export. Rounded to 4 decimals except for whole-company roles of the customer (doc 02 §7.2).
   */
  pickup: GeoPoint | null;
  drop: GeoPoint | null;
  pickupLabel: string | null;
  dropLabel: string | null;
  /** Why a personal point is withheld although it exists: LIST_VIEW (list / export row) or CONSENT_REQUIRED; else null. */
  pointsHidden: 'LIST_VIEW' | 'CONSENT_REQUIRED' | null;
  /** Pickup or drop point missing: cannot be assigned yet. */
  needsLocation: boolean;
  windowStart: string;
  windowEnd: string;
  passengerCount: number;
  cutoffAt: string | null;
  /** WP 3.9: COMMUTE or POINT_TO_POINT. */
  journey: TransportBookingJourney;
  /** WP 3.9 (D-A1): created (or last edited) after its cut-off by a dispatcher with a reason. */
  afterCutoff: boolean;
  /** The dispatcher's late reason; null when not late. Shown to transport roles only (never to the passenger). */
  lateReason: string | null;
  /** The trip / seat when ASSIGNED or CONFIRMED (or the last one it was on). */
  tripId: string | null;
  passengerTripId: string | null;
  customerCompanyId: string;
  providerCompanyId: string | null;
  note: string | null;
  allowedActions: TransportBookingAction[];
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /api/transport/bookings (header Idempotency-Key, required). Ad-hoc booking on behalf of a passenger, no schedule
 * needed. COMMUTE (default): without `pickup` / `drop` the passenger's routing pickup (only with an active
 * TRANSPORT_PROFILE consent, else "needs location" and nothing stored) and the shift's site are used; without
 * `windowStart` / `windowEnd` the shift's login / logout defines the window, so either a shift or a window is required.
 * POINT_TO_POINT: `pickup`, `drop`, `windowStart`, `windowEnd` required; `direction` and `shiftId` optional.
 * A point is a company place (`poiId`, coordinates taken from the place) or a one-time map point (lat / lng + label):
 * a one-time point is personal data and needs the passenger's active consent (409 CONSENT_REQUIRED, D-A3), on this
 * and the passenger path alike. `hold` = needs approval (REQUESTED); otherwise PENDING_ASSIGNMENT at once.
 * After the cut-off (window start − company cut-off) the request needs `lateReason` (409 LATE_REASON_REQUIRED, D-A1);
 * the audit records cutoffAt, the creation time, the dispatcher and the reason. The passenger is notified
 * (BOOKING_CREATED, generic push, D-A4) when someone else books for them.
 */
export interface CreateTransportBookingInput {
  passengerId: string;
  serviceDate: string;
  /** Required for COMMUTE; ignored for POINT_TO_POINT (stored as IN). */
  direction?: TransportDirection;
  journey?: TransportBookingJourney;
  shiftId?: string | null;
  pickup?: GeoPoint | null;
  drop?: GeoPoint | null;
  windowStart?: string;
  windowEnd?: string;
  passengerCount?: number;
  note?: string | null;
  hold?: boolean;
  lateReason?: string;
}

/**
 * PATCH /api/transport/bookings/:id — while REQUESTED / PENDING_ASSIGNMENT / WAITLISTED (409 INVALID_STATE otherwise),
 * same point / consent / eligibility rules as create; `pickup` / `drop` set a missing location too. After the cut-off a
 * dispatcher needs `lateReason` (409 LATE_REASON_REQUIRED); the passenger path stays refused (409 AFTER_CUTOFF).
 * An edit never creates a trip or a seat; a plan that still holds the booking's old points refuses to publish it
 * (PLAN_NOT_PUBLISHABLE, issue BOOKING_CHANGED) until the booking is taken off its route or a new plan is created
 * (re-optimising alone does not refresh stored stop points).
 */
export interface UpdateTransportBookingInput {
  expectedVersion: number;
  pickup?: GeoPoint | null;
  drop?: GeoPoint | null;
  windowStart?: string;
  windowEnd?: string;
  passengerCount?: number;
  note?: string | null;
  lateReason?: string;
}

/** Body of approve / reject / cancel. `reason` is required for reject and cancel. */
export interface TransportBookingCommandInput {
  expectedVersion?: number;
  reason?: string;
}

/** POST /api/transport/bookings/bulk-approve. */
export interface BulkApproveTransportBookingsInput {
  ids: string[];
}

export interface BulkApproveTransportBookingsResult {
  approved: string[];
  skipped: { id: string; code: string }[];
}

export interface TransportBookingListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'windowStart' | 'serviceDate' | 'createdAt' | 'status' | 'passenger';
  order?: 'asc' | 'desc';
  format?: 'json' | 'csv';
  /** YYYY-MM-DD; or a range with from / to (inclusive). */
  serviceDate?: string;
  from?: string;
  to?: string;
  direction?: TransportDirection;
  shiftId?: string;
  siteId?: string;
  passengerId?: string;
  bookingStatus?: TransportBookingStatus;
  source?: TransportBookingSource;
  /** 'true' = only bookings waiting for a seat (REQUESTED / PENDING_ASSIGNMENT / WAITLISTED). */
  unassigned?: 'true' | 'false';
  /** WP 3.9 filters. */
  journey?: TransportBookingJourney;
  afterCutoff?: 'true' | 'false';
}

// ───────────────────────────── Dispatch ─────────────────────────────

export interface DispatchBoardQuery {
  serviceDate: string;
  direction?: TransportDirection;
  shiftId?: string;
  siteId?: string;
}

export interface DispatchVehicleDto {
  objectId: string;
  name: string;
  plateNumber: string | null;
  /** TransportVehicleProfile.seats; null = seats not set (cannot carry passengers until set). */
  seats: number | null;
  /** Active planned trips of any origin on the service date (busy windows). */
  busy: { plannedTripId: string; origin: PlannedTripOrigin; plannedStart: string; plannedEnd: string; status: PlannedTripStatus }[];
  lastFix: { lat: number; lng: number; at: string } | null;
}

export interface DispatchBoardDto {
  serviceDate: string;
  direction: TransportDirection | null;
  timeZone: string;
  /** Bookings waiting for a seat (REQUESTED / PENDING_ASSIGNMENT / WAITLISTED). */
  queue: TransportBookingDto[];
  trips: TransportTripSummaryDto[];
  vehicles: DispatchVehicleDto[];
  drafts: TransportChangeSetSummaryDto[];
  counts: { bookings: number; queued: number; assigned: number; trips: number; seats: number; occupied: number };
  /** GraphHopper reachable: candidates may carry road ETAs. */
  routingAvailable: boolean;
}

/** POST /api/transport/dispatch/candidates. */
export interface DispatchCandidatesInput {
  bookingIds: string[];
  /** Planned start for idle-vehicle candidates; default the earliest booking window start. */
  at?: string;
}

export interface DispatchCandidateDto {
  kind: 'TRIP' | 'VEHICLE';
  /** Existing published trip (kind TRIP). */
  tripId: string | null;
  objectId: string;
  vehicleName: string;
  plateNumber: string | null;
  seatCapacity: number | null;
  freeSeats: number;
  /** Enough free seats for all the requested bookings, no overlap, consent present. */
  feasible: boolean;
  /** Pickup closest stop of the trip (kind TRIP). */
  nearestStop: { seq: number; label: string; straightM: number } | null;
  /** Straight-line metres from the vehicle's last fix (VEHICLE) or nearest stop (TRIP) to the first pickup. */
  straightM: number | null;
  /** Road ETA to the first pickup — only when routing answered; otherwise null + degraded. */
  eta: EtaValue;
  /** Why not feasible / warnings: NO_SEATS_SET, CAPACITY, VEHICLE_BUSY, CONSENT_REQUIRED, NEEDS_LOCATION, … */
  reasons: string[];
}

export interface DispatchCandidatesDto {
  bookingIds: string[];
  seatsNeeded: number;
  candidates: DispatchCandidateDto[];
  routingAvailable: boolean;
  /** Set when routing is unavailable: candidates are ranked by seats / straight distance only. */
  degraded: 'ROUTING_UNAVAILABLE' | null;
}

/** One planned stop of an ad-hoc (door-to-door) trip. */
export interface DispatchStopInput {
  seq: number;
  point: GeoPoint;
  plannedArrival: string;
  radiusM?: number;
  waitMin?: number;
}

/**
 * One change of a change set (05 §3.4). CREATE_TRIP: either `routeId` (fixed shuttle: stops / path snapshot of the
 * Route) or `stops` (door-to-door). `tripId` of later ops may name a `tempId` of this change set. R1 has no
 * REORDER_STOPS (cancel and re-create the trip instead).
 */
export type DispatchChangeOp =
  | {
      op: 'CREATE_TRIP';
      tempId: string;
      objectId: string;
      driverId?: string | null;
      plannedStart: string;
      routeId?: string | null;
      stops?: DispatchStopInput[];
      shiftId?: string | null;
      sitePoiId?: string | null;
      corridorM?: number;
      name?: string;
    }
  | { op: 'ADD_PASSENGER'; tripId: string; bookingId: string; pickupSeq: number; dropSeq: number }
  | { op: 'REMOVE_PASSENGER'; passengerTripId: string; reason: string }
  | { op: 'REASSIGN_VEHICLE'; tripId: string; objectId: string }
  | { op: 'REASSIGN_DRIVER'; tripId: string; driverId: string | null }
  | AddStopOp;

/**
 * ADD_STOP (E3 gap 3): insert a stop into an EXISTING, not-started ETMS trip for a booking whose pickup (or drop) is not
 * one of its stops. The point is never sent by the client: the server takes it from the booking (`end`), which must be
 * waiting for a seat, of the change set's date / direction, with an active routing consent (D8). The stop goes after
 * `afterSeq` (-1 = before the first stop); later stops and seated passengers move one seq up. `plannedArrival`
 * defaults to the middle between its neighbours (10 min before the first / after the last stop); a trip that grows
 * longer is checked again for vehicle / driver overlap. Seats are taken by the ADD_PASSENGER that follows, so capacity,
 * idempotency (Idempotency-Key), expectedVersions and the audit are those of the change set.
 */
export interface AddStopOp {
  op: 'ADD_STOP';
  tripId: string;
  bookingId: string;
  end: 'PICKUP' | 'DROP';
  afterSeq: number;
  plannedArrival?: string;
  waitMin?: number;
}

export type DispatchChangeOpKind = DispatchChangeOp['op'];

/**
 * POST /api/transport/dispatch/change-sets (header Idempotency-Key, required unless `draft`). Applied atomically in one
 * transaction (02 §5.4, 15 §8.4): advisory locks per vehicle / driver, overlap check across all origins, bookings and
 * trips locked FOR UPDATE, capacity / consent / state checks, then PlannedTrip (origin ETMS) + TransportTrip +
 * passengers + events + audit. `expectedVersions`: tripId → version for every existing trip touched.
 */
export interface DispatchChangeSetInput {
  serviceDate: string;
  direction: TransportDirection;
  changes: DispatchChangeOp[];
  expectedVersions?: Record<string, number>;
  reason?: string;
  /** Store as a server-held DRAFT instead of publishing (validated again on publish). */
  draft?: boolean;
}

export interface ChangeSetResult {
  changeSetId: string;
  status: TransportChangeSetStatus;
  trips: { id: string; plannedTripId: string | null; version: number; tempId?: string }[];
  bookings: { id: string; status: TransportBookingStatus; version: number }[];
  warnings: string[];
}

export interface TransportChangeSetSummaryDto {
  id: string;
  status: TransportChangeSetStatus;
  serviceDate: string;
  direction: TransportDirection;
  changeCount: number;
  passengerCount: number;
  /** Source trip of a repeat-to-date draft. */
  sourceTripId: string | null;
  createdAt: string;
  publishedAt: string | null;
}

/** One stop of a CREATE_TRIP in a change-set detail; `point` null when it is a personal point the caller may not see. */
export interface ChangeSetStopView {
  seq: number;
  label: string | null;
  point: GeoPoint | null;
  plannedArrival: string;
}

/** A change of a saved change set, with the names the dispatcher needs (E3 gap 2). */
export type ChangeSetChangeView =
  | { op: 'CREATE_TRIP'; tempId: string; objectId: string; vehicleName: string | null; driverId: string | null; driverName: string | null; plannedStart: string; routeId: string | null; name: string | null; stops: ChangeSetStopView[] }
  | { op: 'ADD_PASSENGER'; tripId: string; tripLabel: string; bookingId: string; passenger: TransportPassengerRef | null; bookingStatus: TransportBookingStatus | null; pickupSeq: number; dropSeq: number }
  | { op: 'ADD_STOP'; tripId: string; tripLabel: string; bookingId: string; passenger: TransportPassengerRef | null; end: 'PICKUP' | 'DROP'; afterSeq: number; plannedArrival: string | null }
  | { op: 'REMOVE_PASSENGER'; passengerTripId: string; tripId: string | null; tripLabel: string; passenger: TransportPassengerRef | null; reason: string }
  | { op: 'REASSIGN_VEHICLE'; tripId: string; tripLabel: string; objectId: string; vehicleName: string | null }
  | { op: 'REASSIGN_DRIVER'; tripId: string; tripLabel: string; driverId: string | null; driverName: string | null };

/**
 * GET /api/transport/dispatch/change-sets/:id (etms_dispatch view; own company; branch-scoped dispatchers only for
 * change sets whose vehicles, trips and passengers are all in their scope, else 404). A DRAFT shows its changes; a
 * published / discarded one keeps none (`changes` empty) and shows its result counts in the summary.
 */
export interface TransportChangeSetDetailDto extends TransportChangeSetSummaryDto {
  reason: string | null;
  expectedVersions: Record<string, number>;
  changes: ChangeSetChangeView[];
  /** DRAFT: why publishing would be refused as things stand (booking no longer waiting, trip changed / started). */
  issues: string[];
}

/** POST /api/transport/trips/:id/repeat — copy the assignment to later dates as DRAFT change sets. */
export interface RepeatTransportTripInput {
  /** Last service date (inclusive), YYYY-MM-DD, at most `repeatMaxDays` after the trip's date. */
  toDate: string;
  /** Weekdays to copy to (0 = Sunday … 6); default every day. */
  days?: number[];
}

export interface RepeatTransportTripResult {
  drafts: { changeSetId: string; serviceDate: string; passengers: number; missingBookings: string[] }[];
  /** Dates skipped because no passenger of the trip had an unassigned booking. */
  skippedDates: string[];
}

// ───────────────────────────── Trips ─────────────────────────────

export type TransportTripAction = 'start' | 'arrive' | 'complete' | 'cancel' | 'acknowledge' | 'repeat';

export interface TransportTripPassengerCounts {
  pending: number;
  boarded: number;
  noShow: number;
  dropped: number;
  cancelled: number;
}

export interface TransportTripSummaryDto {
  id: string;
  version: number;
  plannedTripId: string | null;
  serviceDate: string;
  direction: TransportDirection;
  derivedState: TransportTripDerivedState;
  /** v1.8 status of the PlannedTrip (unchanged semantics, D2); null when detached. */
  plannedTripStatus: PlannedTripStatus | null;
  origin: PlannedTripOrigin;
  /** Fixed shuttle: the Route it was created from; door-to-door: null. */
  routeId: string | null;
  name: string;
  objectId: string | null;
  vehicleName: string | null;
  plateNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  seatCapacity: number;
  occupiedSeats: number;
  passengerCounts: TransportTripPassengerCounts;
  nextStopSeq: number | null;
  etaNextStop: string | null;
  delaySec: number | null;
  shiftId: string | null;
  shiftName: string | null;
  siteId: string | null;
  publishedAt: string | null;
  acknowledgedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  customerCompanyId: string | null;
  providerCompanyId: string;
}

export interface TransportTripStopDto {
  id: string;
  seq: number;
  name: string;
  /**
   * Null when the stop is a passenger's personal point the caller may not see: the passenger's routing consent is not
   * active, or the passenger is outside the caller's branches (E3 security review M1). Personal points are rounded to
   * 4 decimals (about 11 m) for everyone but the customer's whole-company roles; company sites are always exact.
   */
  lat: number | null;
  lng: number | null;
  /** True when this stop is a passenger's personal point (home or an ad-hoc address), not a company site. */
  personal: boolean;
  /** Why lat / lng are withheld (null when shown). */
  pointHidden: 'CONSENT_REQUIRED' | 'OUT_OF_SCOPE' | null;
  plannedArrival: string;
  plannedDeparture: string;
  actualArrival: string | null;
  actualDeparture: string | null;
  /** v1.8 stop status (GPS tracker or dispatcher-reported arrival). Never changes a passenger outcome. */
  status: PlannedStopStatus;
  pickups: number;
  drops: number;
  /** Active passengers picked up here whose outcome is not recorded yet. */
  outcomesPending: number;
}

export interface TransportTripPassengerDto {
  /** passengerTripId. */
  id: string;
  bookingId: string;
  passenger: TransportPassengerRef;
  pickupSeq: number;
  dropSeq: number;
  pickupLabel: string | null;
  dropLabel: string | null;
  seats: number;
  status: TransportPassengerStatus;
  boardedAt: string | null;
  droppedAt: string | null;
  noShowAt: string | null;
  noShowReason: string | null;
  cancelReason: string | null;
  outcomeSource: TransportOutcomeSource | null;
  outcomeAt: string | null;
  /**
   * The pickup stop was reached (GPS or dispatcher) but no outcome is recorded: the UI shows "outcome not recorded"
   * (02 §5.3) — GPS never sets BOARDED.
   */
  outcomeMissing: boolean;
  allowedOutcomes: TransportPassengerOutcome[];
}

export interface TransportTripEventDto {
  id: string;
  kind: string;
  actorType: TransportTripActorType;
  actorUserId: string | null;
  source: TransportTripEventSource;
  outcome: TransportTripEventOutcome;
  passengerTripId: string | null;
  stopSeq: number | null;
  reasonCode: string | null;
  occurredAt: string;
  receivedAt: string;
  data: Record<string, unknown>;
}

export interface TransportTripDto extends TransportTripSummaryDto {
  path: RoutePath | null;
  stops: TransportTripStopDto[];
  passengers: TransportTripPassengerDto[];
  events: TransportTripEventDto[];
  allowedActions: TransportTripAction[];
}

export interface TransportTripListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'plannedStart' | 'serviceDate' | 'createdAt';
  order?: 'asc' | 'desc';
  format?: 'json' | 'csv';
  serviceDate?: string;
  from?: string;
  to?: string;
  direction?: TransportDirection;
  derivedState?: TransportTripDerivedState;
  vehicleId?: string;
  driverId?: string;
  shiftId?: string;
  siteId?: string;
}

/**
 * Body of start / complete / acknowledge (05 §2.6). `clientEventId` (UUID) makes a retried command a no-op that returns
 * the current trip. `expectedVersion` optional (TransportTrip.version).
 */
export interface TransportTripCommandInput {
  clientEventId?: string;
  note?: string;
  expectedVersion?: number;
}

/** Body of cancel: reason required; active passengers are cancelled and their bookings return to the queue unless `cancelBookings`. */
export interface TransportTripCancelInput extends TransportTripCommandInput {
  reason: string;
  /** true = also cancel the passengers' bookings (default false: back to PENDING_ASSIGNMENT). */
  cancelBookings?: boolean;
}

/** POST /api/transport/trips/:id/arrive — dispatcher-reported arrival at a stop (e.g. after a call with the driver). */
export interface TransportTripArriveInput extends TransportTripCommandInput {
  stopSeq: number;
  occurredAt?: string;
}

/** POST /api/transport/trips/:id/passengers/:passengerTripId/outcome (source WEB, actor DISPATCHER). */
export interface TransportPassengerOutcomeInput {
  outcome: TransportPassengerOutcome;
  clientEventId?: string;
  /** NO_SHOW: Lookup code / short reason. */
  reasonCode?: string;
  /** When it happened (default now; not in the future). */
  occurredAt?: string;
  note?: string;
}

// ───────────────────────────── Passenger self view (/api/me/transport) ─────────────────────────────

export interface MeTripDto {
  /** TransportTrip id. */
  id: string;
  passengerTripId: string;
  serviceDate: string;
  direction: TransportDirection;
  /** WP 3.9: POINT_TO_POINT when any active seat's booking on the trip is point-to-point (stored as IN), else COMMUTE. */
  journey: TransportBookingJourney;
  timeZone: string;
  window: { start: string; end: string };
  derivedState: TransportTripDerivedState;
  myStatus: TransportPassengerStatus;
  vehicle: { name: string; plate: string | null } | null;
  driverFirstName: string | null;
  myStop: { seq: number; label: string; plannedAt: string; status: PlannedStopStatus | null; eta: EtaValue } | null;
  myDrop: { seq: number; label: string; plannedAt: string } | null;
  /** The trip's planned start / end (the vehicle window runs from start − 30 min to end + 10 min, 05 §2.8). */
  plannedStart: string | null;
  plannedEnd: string | null;
  /**
   * The caller's OWN pickup / drop point (their booking; doc 02 §7, doc 10: a passenger may see their own location) —
   * only while their routing consent is active, else null with `pointsHidden` CONSENT_REQUIRED. Never anyone else's.
   */
  myPickupPoint: { lat: number; lng: number } | null;
  myDropPoint: { lat: number; lng: number } | null;
  pointsHidden: 'CONSENT_REQUIRED' | null;
  /** Other active passengers on the trip (count only). */
  coRiders: number;
  /** Inside the vehicle-visibility window right now (poll /vehicle). */
  liveVisible: boolean;
  /** E5: the transport desk phone of the trip's operator ("call the desk"); null when not set. Never the driver's number. */
  deskPhone: string | null;
}

export type MeVehicleDto =
  | { visible: false; reason: 'OUTSIDE_WINDOW' | 'NO_FIX' | 'NOT_ON_TRIP' }
  | { visible: true; lat: number; lng: number; heading: number | null; speedKph: number | null; fixAt: string; eta: EtaValue };

export interface MeBookingDto {
  id: string;
  status: TransportBookingStatus;
  source: TransportBookingSource;
  serviceDate: string;
  direction: TransportDirection;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  pickupLabel: string | null;
  dropLabel: string | null;
  tripId: string | null;
  /**
   * E5: the passenger's self-cancel cut-off (ISO), computed by the server when the booking is made (window start minus
   * the company's booking cut-off). Null only for a booking without a cut-off (a cancel is then allowed until the trip
   * starts). The server re-checks it on cancel (409 AFTER_CUTOFF).
   */
  cutoffAt: string | null;
  /** WP 3.9: COMMUTE or POINT_TO_POINT. */
  journey: TransportBookingJourney;
  /** WP 3.9: made for the passenger by the transport desk (not by the passenger). */
  arrangedByDesk: boolean;
}

export interface MeTransportRangeQuery {
  /** YYYY-MM-DD inclusive (passenger's company zone). */
  from?: string;
  to?: string;
}

// ───────────────────────────── Error codes (05 §4, E3 subset) ─────────────────────────────

export const TRANSPORT_E3_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN_GRANT',
  'NOT_A_PASSENGER',
  'CONSENT_REQUIRED',
  'VERSION_CONFLICT',
  'CAPACITY_EXCEEDED',
  'VEHICLE_BUSY',
  'DRIVER_BUSY',
  'NO_SEATS_SET',
  'BOOKING_DUPLICATE',
  'AFTER_CUTOFF',
  'INVALID_STATE',
  'NEEDS_LOCATION',
  'TRIP_CLOSED',
  'UNRESOLVED_PASSENGERS',
  'MANAGED_BY_ETMS',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  // WP 3.9 ad-hoc booking (see TRANSPORT_INELIGIBLE_REASONS).
  'LATE_REASON_REQUIRED',
  'NOT_ELIGIBLE',
  'BOOKING_OVERLAP',
] as const;
export type TransportE3ErrorCode = (typeof TRANSPORT_E3_ERROR_CODES)[number];

// ───────────────────────────── State machines (pure; used by the API, shown by the web) ─────────────────────────────

export type TransportBookingCommand = 'approve' | 'reject' | 'cancel' | 'assign' | 'unassign' | 'expire';

/** Allowed booking transitions. `assign` / `unassign` come from dispatch, `expire` from the sweep. */
export const BOOKING_TRANSITIONS: Record<TransportBookingCommand, Partial<Record<TransportBookingStatus, TransportBookingStatus>>> = {
  approve: { REQUESTED: 'PENDING_ASSIGNMENT', WAITLISTED: 'PENDING_ASSIGNMENT', ASSIGNED: 'CONFIRMED' },
  reject: { REQUESTED: 'REJECTED', PENDING_ASSIGNMENT: 'REJECTED', WAITLISTED: 'REJECTED' },
  cancel: { REQUESTED: 'CANCELLED', PENDING_ASSIGNMENT: 'CANCELLED', WAITLISTED: 'CANCELLED', ASSIGNED: 'CANCELLED', CONFIRMED: 'CANCELLED' },
  assign: { PENDING_ASSIGNMENT: 'ASSIGNED' },
  unassign: { ASSIGNED: 'PENDING_ASSIGNMENT', CONFIRMED: 'PENDING_ASSIGNMENT' },
  expire: { REQUESTED: 'EXPIRED', PENDING_ASSIGNMENT: 'EXPIRED', WAITLISTED: 'EXPIRED' },
};

/** Next status, or null when the command is not allowed from `from`. */
export function bookingTransition(from: TransportBookingStatus, command: TransportBookingCommand): TransportBookingStatus | null {
  return BOOKING_TRANSITIONS[command][from] ?? null;
}

/** Commands a dispatcher may offer for a booking now (edit only before the cut-off and while not seated). */
/**
 * `opts.desk` (WP 3.9 D-A1): the transport desk may still edit an unseated booking after the cut-off (the PATCH then
 * needs `lateReason`); without it (passenger / default) 'edit' stops at the cut-off as before.
 */
export function bookingAllowedActions(b: { status: TransportBookingStatus; cutoffAt: Date | string | null }, nowMs: number = Date.now(), opts: { desk?: boolean } = {}): TransportBookingAction[] {
  const out: TransportBookingAction[] = [];
  const cutoff = b.cutoffAt === null ? null : new Date(b.cutoffAt).getTime();
  const beforeCutoff = cutoff === null || nowMs < cutoff;
  if (['REQUESTED', 'PENDING_ASSIGNMENT', 'WAITLISTED'].includes(b.status) && (beforeCutoff || opts.desk === true)) out.push('edit');
  if (bookingTransition(b.status, 'cancel')) out.push('cancel');
  if (bookingTransition(b.status, 'approve')) out.push('approve');
  if (bookingTransition(b.status, 'reject')) out.push('reject');
  return out;
}

/**
 * Passenger outcome transitions recorded by the dispatcher: PENDING → BOARDED | NO_SHOW; BOARDED → DROPPED. A
 * correction (BOARDED ↔ NO_SHOW before a drop) is allowed while the trip is open; DROPPED and CANCELLED are final.
 */
export function passengerOutcomeAllowed(from: TransportPassengerStatus, to: TransportPassengerOutcome): boolean {
  if (from === 'PENDING') return to === 'BOARDED' || to === 'NO_SHOW';
  if (from === 'BOARDED') return to === 'DROPPED' || to === 'NO_SHOW';
  if (from === 'NO_SHOW') return to === 'BOARDED';
  return false;
}

export function allowedPassengerOutcomes(from: TransportPassengerStatus): TransportPassengerOutcome[] {
  return TRANSPORT_PASSENGER_OUTCOMES.filter((o) => passengerOutcomeAllowed(from, o));
}

/** Inputs of the derived trip state (02 §5.2). */
export interface DerivedTripStateInput {
  plannedTripStatus: PlannedTripStatus | null;
  publishedAt: Date | string | null;
  acknowledgedAt: Date | string | null;
  /** Some stop ARRIVED (GPS or dispatcher) with an active passenger picked up there still PENDING. */
  stopWithPendingOutcome: boolean;
  /** Next stop reached / not reached is all EN_ROUTE needs: the trip started and no stop is waiting for outcomes. */
  started?: boolean;
}

export function deriveTripState(i: DerivedTripStateInput): TransportTripDerivedState {
  switch (i.plannedTripStatus) {
    case null:
      return 'DETACHED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'INCOMPLETE':
      return 'INCOMPLETE';
    case 'STARTED':
    case 'IN_PROGRESS':
      if (i.stopWithPendingOutcome) return 'AT_STOP';
      return i.plannedTripStatus === 'STARTED' ? 'EN_ROUTE' : 'IN_PROGRESS';
    default:
      if (!i.publishedAt) return 'PLANNED';
      return i.acknowledgedAt ? 'DRIVER_ACKNOWLEDGED' : 'PUBLISHED';
  }
}

/** Planned trips with an E3 header that are still running or about to (vehicle / driver busy). */
export const ACTIVE_TRIP_STATUSES_FOR_OVERLAP: readonly PlannedTripStatus[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];

/**
 * Menus E3 adds to the ETMS role templates (P6) for companies whose add-on is switched on from now on (existing roles
 * are never changed). The dispatcher works SITE-scoped (ASSIGNED data scope).
 */
export const ETMS_E3_TEMPLATE_PERMISSIONS: Record<string, PermissionMap> = {
  'Transport admin': {
    etms_schedules: ['view', 'create', 'edit', 'delete', 'export'],
    etms_bookings: ['view', 'create', 'edit', 'delete', 'export'],
    etms_dispatch: ['view', 'edit', 'command', 'export'],
  },
  'Transport dispatcher': {
    etms_schedules: ['view', 'create', 'edit', 'delete'],
    etms_bookings: ['view', 'create', 'edit'],
    etms_dispatch: ['view', 'edit', 'command'],
  },
};
