/**
 * ETMS on-demand pooling and live dispatch (doc 20, phases B–D backend). Owner defaults P1–P8 apply:
 *   P1 PRIVATE = whole-trip exclusivity (nobody else on the private passenger's trip);
 *   P2 default sharing limits: max wait 15 min, max detour max(1.8 × direct, direct + 15 min), max ride = company max ride;
 *   P3 backfill: existing COMMUTE bookings → SHARED, existing POINT_TO_POINT → PRIVATE;
 *   P4 live auto-assign for unpublished plans and SCHEDULED trips within limits, proposals only for ACTIVE trips;
 *   P5 active-trip edits allowed: pending stops only, with driver acknowledgement (ROUTE_ACK);
 *   P6 priority weights PRIVATE 3 / FLEXIBLE 1.5 / SHARED 1;
 *   P7 no driver working-hour policy unless the company sets one;
 *   P8 boarded passengers of a broken-down vehicle are a dispatcher decision (never transferred automatically).
 * Web and mobile clients use these types; the server is the only judge of every rule.
 */
import type { DispatchChangeOp, TransportBookingStatus } from './transport-trips';

// ───────────────────────────── Ride preference, policy and limits (B1) ─────────────────────────────

/** How the passenger wants to ride. PRIVATE is never pooled; FLEXIBLE may be served either way. */
export const RIDE_PREFERENCES = ['SHARED', 'PRIVATE', 'FLEXIBLE'] as const;
export type RidePreference = (typeof RIDE_PREFERENCES)[number];

/** How a booking was actually served (set when it is seated; pricing reads it, doc 19). */
export const RIDE_SERVICES = ['SHARED', 'PRIVATE'] as const;
export type RideService = (typeof RIDE_SERVICES)[number];

/** Per-booking sharing limits: a snapshot taken when the booking is accepted, immutable afterwards (DB trigger). */
export interface SharingLimits {
  /** Pickup window = [requested, requested + maxWaitS] (hard). */
  maxWaitS: number;
  /** Ride ≤ max(direct × ratio, direct + extraS) (hard). */
  maxDetour: { ratio: number; extraS: number };
  /** Ride ≤ maxRideS (hard); null = no own limit beyond the detour rule (the company max ride applies). */
  maxRideS: number | null;
  /** Optional latest arrival (s after midnight of the service date, booking time zone); null = none. */
  arriveByS?: number | null;
}

/** P2 defaults (owner decision): 15 min wait, max(1.8 ×, +15 min) detour, company max ride. */
export const DEFAULT_SHARING_LIMITS: SharingLimits = { maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: null };

/** Bounds a policy or a passenger's tighter limits must stay within. */
export const SHARING_LIMIT_BOUNDS = {
  maxWaitS: { min: 0, max: 7_200 },
  ratio: { min: 1, max: 3 },
  extraS: { min: 0, max: 3_600 },
  maxRideS: { min: 300, max: 14_400 },
} as const;

/** P6 default priority weights (drop penalty multiplier in the solver). */
export const DEFAULT_RIDE_PRIORITY: Record<RidePreference, number> = { PRIVATE: 3, FLEXIBLE: 1.5, SHARED: 1 };

/**
 * GET /api/me/transport/sharing-policy (passenger, etms_self) and GET /api/transport/sharing-policy (desk,
 * etms_bookings view): the company's current sharing policy. `version` 0 = the built-in default (no policy saved yet).
 * A passenger accepts a version; a newer version never changes accepted bookings.
 */
export interface TransportSharingPolicyDto {
  version: number;
  effectiveFrom: string | null;
  /** Policy text shown to the passenger before acceptance (plain text, company language). */
  text: string;
  allowFlexible: boolean;
  /** Default limits per pooled preference (PRIVATE needs none). */
  limits: { SHARED: SharingLimits; FLEXIBLE: SharingLimits };
  /** Company max ride (Company.settings.etms.maxRideS) in seconds, the ceiling of every maxRideS; null = none. */
  companyMaxRideS: number | null;
  priority: Record<RidePreference, number>;
}

/** PUT /api/transport/sharing-policy (etms_settings edit, whole-company scope): saves a NEW version (append-only). */
export interface UpdateTransportSharingPolicyInput {
  text: string;
  allowFlexible?: boolean;
  limits: { SHARED: SharingLimits; FLEXIBLE: SharingLimits };
  priority?: Partial<Record<RidePreference, number>>;
}

export const SHARING_POLICY_TEXT_MAX = 4_000;

/**
 * Booking fields added by pooling (desk POST /api/transport/bookings, passenger POST /api/me/transport/requests):
 *   ridePreference — default COMMUTE → SHARED (commute rides are pooled by definition), POINT_TO_POINT → PRIVATE;
 *   acceptedPolicyVersion — required for SHARED / FLEXIBLE point-to-point rides; must be the current policy version
 *     (409 POLICY_ACCEPTANCE_REQUIRED / POLICY_VERSION_STALE with `{ version }`);
 *   limits — optional TIGHTER limits (never looser than the policy: 400 LIMITS_ABOVE_POLICY).
 * The server snapshots the effective limits at acceptance and returns them on the booking.
 */
export interface BookingPoolingInput {
  ridePreference?: RidePreference;
  acceptedPolicyVersion?: number;
  limits?: Partial<Pick<SharingLimits, 'maxWaitS' | 'maxRideS'>> & { maxDetour?: Partial<SharingLimits['maxDetour']> };
}

/** Booking fields returned by every booking DTO of a pooling server. */
export interface BookingPoolingView {
  ridePreference?: RidePreference;
  /** The policy version the passenger (or desk) accepted; null when none was needed. */
  sharingPolicyVersion?: number | null;
  /** The immutable limits snapshot; null for bookings created before pooling (the company policy applies). */
  limits?: SharingLimits | null;
  /** How the booking was served once seated; null before. */
  assignedService?: RideService | null;
  /** Dispatcher hold: excluded from planning and live dispatch without being cancelled. */
  holdFromPlanning?: boolean;
  holdReason?: string | null;
  holdAt?: string | null;
}

/**
 * PATCH /api/transport/bookings/:id/hold (etms_dispatch edit; audited). Only an unseated booking (REQUESTED /
 * PENDING_ASSIGNMENT / WAITLISTED) can be held (409 INVALID_STATE); `reason` required when holding. Version + 1.
 * A held booking is skipped by plan creation (`on_hold`), refused by a publish (409 BOOKING_ON_HOLD) and ignored by
 * live dispatch.
 */
export interface TransportBookingHoldInput {
  hold: boolean;
  reason?: string;
  expectedVersion: number;
}

export const BOOKING_HOLD_REASON_MAX = 300;

// ───────────────────────────── Vehicle availability and driver hours (C1) ─────────────────────────────

/** OPERATING = the vehicle may run (when a vehicle has OPERATING rows on a day, trips must lie inside one); DOWNTIME / RESERVED = it may not. */
export const VEHICLE_AVAILABILITY_KINDS = ['OPERATING', 'DOWNTIME', 'RESERVED'] as const;
export type VehicleAvailabilityKind = (typeof VEHICLE_AVAILABILITY_KINDS)[number];

export interface VehicleAvailabilityWindowDto {
  id: string;
  kind: VehicleAvailabilityKind;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

/** Default turnaround (s) between two trips of one vehicle when the vehicle has none set (planning only). */
export const DEFAULT_TURNAROUND_S = 120;

/**
 * GET / PUT /api/transport/vehicles/:objectId/availability (etms_vehicles view / edit; vehicle scope). PUT replaces the
 * windows that END after `from` (default now) with `windows` (past windows are history and stay) and sets the
 * turnaround. A trip that would break a window is refused at assignment / publish (409 VEHICLE_UNAVAILABLE /
 * VEHICLE_TURNAROUND); `maintenanceSince` (vehicle under maintenance) is an open-ended downtime.
 */
export interface PutVehicleAvailabilityInput {
  /** Seconds between two trips of this vehicle; null clears it (then not enforced at publish; planners use the default). */
  turnaroundS?: number | null;
  from?: string;
  windows: { kind: VehicleAvailabilityKind; startsAt: string; endsAt: string; reason?: string | null }[];
}

export interface VehicleAvailabilityDto {
  objectId: string;
  turnaroundS: number | null;
  maintenanceSince: string | null;
  windows: VehicleAvailabilityWindowDto[];
  /** Active planned trips (any origin) in the next 7 days: the busy part of the timeline. */
  busy: { plannedTripId: string; plannedStart: string; plannedEnd: string; status: string }[];
}

export const VEHICLE_AVAILABILITY_LIMITS = { maxWindows: 200, reasonMax: 200, turnaroundMaxS: 7_200, horizonDays: 60 } as const;

/**
 * Company working-hour policy of drivers (P7: none unless set). Every field null = not checked. Assignment / publish
 * (batch and live) refuse a trip that would break it: 409 DRIVER_HOURS with `{ problems: DriverHoursProblem[] }`.
 */
export interface DriverHoursPolicy {
  /** Longest duty span: first trip start → last trip end within one duty (s). */
  maxDutyS: number | null;
  /** Total planned driving (sum of trip durations) within one duty (s). */
  maxDrivingS: number | null;
  /** Continuous driving after which a break of `breakS` is needed (s). */
  breakAfterS: number | null;
  breakS: number | null;
  /** Minimum rest between two duties (s); a gap at least this long starts a new duty. */
  minRestS: number | null;
}

export const DRIVER_HOURS_PROBLEMS = ['MAX_DUTY', 'MAX_DRIVING', 'BREAK_REQUIRED'] as const;
export type DriverHoursProblemKind = (typeof DRIVER_HOURS_PROBLEMS)[number];
export interface DriverHoursProblem {
  kind: DriverHoursProblemKind;
  /** The value found and the limit (s). */
  valueS: number;
  limitS: number;
}

// ───────────────────────────── Pooling / live-dispatch settings ─────────────────────────────

export const LIVE_DISPATCH_POLICIES = ['AUTO', 'PROPOSE'] as const;
export type LiveDispatchPolicy = (typeof LIVE_DISPATCH_POLICIES)[number];

/**
 * GET / PUT /api/transport/pooling/settings (GET etms_dispatch view; PUT etms_settings edit, whole-company scope;
 * audited). Stored in Company.settings.etmsPooling. `liveDispatch` defaults OFF; the server's environment kill switch
 * ETMS_LIVE_DISPATCH=off wins over it (`killSwitch` true).
 */
export interface PoolingSettingsDto {
  liveDispatch: boolean;
  /** P4: unpublished plans and SCHEDULED trips: AUTO (default) or PROPOSE. ACTIVE trips are always PROPOSE. */
  scheduledPolicy: LiveDispatchPolicy;
  /** Delay re-evaluation: PROPOSE (default) or AUTO (within limits; pending passengers only). */
  delayPolicy: LiveDispatchPolicy;
  /** A reported / tracked delay above this (s) triggers the evaluation. */
  delayThresholdS: number;
  driverHours: DriverHoursPolicy | null;
  /** Read-only: the server environment switched live dispatch off (ETMS_LIVE_DISPATCH=off). */
  killSwitch: boolean;
}

export type UpdatePoolingSettingsInput = Partial<Omit<PoolingSettingsDto, 'killSwitch'>>;

export const DEFAULT_POOLING_SETTINGS: Omit<PoolingSettingsDto, 'killSwitch'> = { liveDispatch: false, scheduledPolicy: 'AUTO', delayPolicy: 'PROPOSE', delayThresholdS: 600, driverHours: null };

// ───────────────────────────── Live dispatch (D1) ─────────────────────────────

export const DISPATCH_TRIGGERS = ['NEW_BOOKING', 'CANCEL', 'DELAY', 'BREAKDOWN', 'MANUAL'] as const;
export type DispatchTrigger = (typeof DISPATCH_TRIGGERS)[number];

/**
 * QUEUED → DECIDED (options found, waiting to apply) → APPLIED (change set committed) | PROPOSED (needs the dispatcher:
 * ACTIVE trip, PROPOSE policy, boarded passengers of a breakdown) | REJECTED (no feasible option; the booking stays
 * visible as unassigned, with the reasons) | FAILED (error; retried by the worker up to 3 times).
 */
export const DISPATCH_REQUEST_STATUSES = ['QUEUED', 'DECIDED', 'PROPOSED', 'APPLIED', 'REJECTED', 'FAILED'] as const;
export type DispatchRequestStatus = (typeof DISPATCH_REQUEST_STATUSES)[number];

/** Why an option is not feasible / why a request was rejected. */
export const DISPATCH_REASON_CODES = [
  'NO_CANDIDATE',
  'CAPACITY',
  'PICKUP_WINDOW',
  'MAX_RIDE',
  'MAX_DETOUR',
  'COMMITMENT',
  'PRIVATE_NEEDS_EMPTY_VEHICLE',
  'PRIVATE_TRIP',
  'VEHICLE_BUSY',
  'VEHICLE_UNAVAILABLE',
  'DRIVER_HOURS',
  'TRIP_STARTED',
  'ON_HOLD',
  'NOT_ELIGIBLE',
  'CONSENT_REQUIRED',
  'NEEDS_LOCATION',
  'SOLVER_UNAVAILABLE',
  'ONBOARD_TRANSFER',
  /** P5: the driver has not acknowledged the trip's last live change; no further live insertion until they do. */
  'ROUTE_ACK_PENDING',
  /** P5: a live change has waited too long for the driver's acknowledgement (dispatcher proposal). */
  'ROUTE_ACK_OVERDUE',
  'DISABLED',
] as const;
export type DispatchReasonCode = (typeof DISPATCH_REASON_CODES)[number];

/** One way of serving a booking: insert into an existing trip, or a new trip on an idle vehicle. */
export interface DispatchOptionDto {
  optionId: string;
  kind: 'INSERT' | 'NEW_TRIP';
  tripId: string | null;
  objectId: string;
  vehicleName: string | null;
  /** State of the target: SCHEDULED trip, ACTIVE (started) trip, IDLE vehicle. */
  target: 'SCHEDULED' | 'ACTIVE' | 'IDLE';
  pickupEta: string;
  dropEta: string;
  /** Extra vehicle seconds this option costs (insertion cost). */
  addedS: number;
  /** Passengers already on the trip whose stop list changes (their committed times never do). */
  affectedPassengers: number;
  /** The change set this option applies (ids only; points come from the booking on the server). */
  changes: DispatchChangeOp[];
  /** P4: may be applied without a dispatcher (unpublished / SCHEDULED within limits); ACTIVE targets never. */
  autoApplicable: boolean;
  servedAs: RideService;
  /** How the option was found: the optimiser's insertion (pdp insertOnly) or the in-process fallback. */
  engine: 'SOLVER' | 'FALLBACK';
}

/**
 * POST /api/transport/dispatch/live/decide (etms_dispatch command; Idempotency-Key required when `apply`). Ranked
 * feasible options for one booking waiting for a seat. `apply: true` executes `optionId` (default: the best option)
 * through the normal change-set publish (same locks, version checks, consent and audit); an ACTIVE-trip option needs
 * the dispatcher's apply (P4/P5). 409 LIVE_DISPATCH_DISABLED while the company switch / kill switch is off.
 */
export interface LiveDispatchDecideInput {
  bookingId: string;
  apply?: boolean;
  optionId?: string;
  /**
   * The decision (`requestId` of an earlier answer, or a PROPOSED request of the log) whose stored option to apply: the
   * option exactly as shown (its trip version is re-checked). Without it, `apply` uses a fresh computation.
   */
  requestId?: string;
}

export interface LiveDispatchDecisionDto {
  requestId: string;
  bookingId: string;
  status: DispatchRequestStatus;
  options: DispatchOptionDto[];
  chosenOptionId: string | null;
  changeSetId: string | null;
  reasons: DispatchReasonCode[];
}

/** GET /api/transport/dispatch/live/requests (etms_dispatch view): the live decision log, newest first. */
export interface DispatchRequestDto {
  id: string;
  trigger: DispatchTrigger;
  status: DispatchRequestStatus;
  bookingId: string | null;
  tripId: string | null;
  bookingStatus: TransportBookingStatus | null;
  chosenOptionId: string | null;
  changeSetId: string | null;
  reasons: DispatchReasonCode[];
  /** Options considered (ids, kinds and costs only). */
  alternatives: { optionId: string; kind: 'INSERT' | 'NEW_TRIP'; tripId: string | null; objectId: string; addedS: number; target: 'SCHEDULED' | 'ACTIVE' | 'IDLE' }[];
  attempts: number;
  createdAt: string;
  decidedAt: string | null;
  durationMs: number | null;
}

export interface DispatchRequestListQuery {
  status?: DispatchRequestStatus;
  trigger?: DispatchTrigger;
  bookingId?: string;
  limit?: number;
}

/**
 * POST /api/driver/v1/trips/:id/route-ack (etms_driver edit; own trip): the driver acknowledges the live route change
 * `routeVersion` (P5). Older versions are accepted as no-ops; a newer one than the server's is 409 VERSION_CONFLICT.
 */
export interface DriverRouteAckInput {
  routeVersion: number;
  clientEventId: string;
}

export interface DriverRouteAckResult {
  tripId: string;
  routeVersion: number;
  acknowledgedVersion: number;
  pending: boolean;
}

/** Driver trip detail fields added by pooling (DriverTripDetailDto). */
export interface DriverRoutePoolingView {
  /** Bumped by every live change of a started trip (pending stops only). */
  routeVersion?: number;
  /** The driver has not acknowledged the latest live change yet. */
  routeAckPending?: boolean;
}

/** Passenger trip view fields added by pooling (MeTripDto). */
export interface MeTripPoolingView {
  /** Planned pickup time of this passenger (always, not only when it is the next stop), adjusted by the live delay. */
  estimatedPickupAt?: string | null;
  servedAs?: RideService | null;
  /** P5: the trip's route changed live and the driver has not acknowledged it yet: the shown times are tentative. */
  routePending?: boolean;
}

// ───────────────────────────── AREA plans (C2) ─────────────────────────────

/** SITE = today's site / shift plan (one direction). AREA = point-to-point pooling over an operating window. */
export const ROUTE_PLAN_SCOPES = ['SITE', 'AREA'] as const;
export type RoutePlanScope = (typeof ROUTE_PLAN_SCOPES)[number];

/**
 * POST /api/transport/route-plans with `scope: 'AREA'`: `windowStart` / `windowEnd` (≤ 24 h) instead of direction /
 * site / shift; a `depot` (company place) is required (vehicle start). Bookings selected: POINT_TO_POINT and COMMUTE
 * bookings waiting for a seat whose window overlaps the plan window, not on hold, by branch scope. Optimised with the
 * solver's pickup-and-delivery mode (contract v3); a vehicle route may hold several trips (RoutePlanStop.tripIndex),
 * each published as its own trip through the normal publish.
 */
export interface AreaRoutePlanFields {
  scope?: RoutePlanScope;
  windowStart?: string;
  windowEnd?: string;
}

/** Live dispatch environment switch values (ETMS_LIVE_DISPATCH). */
export const LIVE_DISPATCH_ENV = 'ETMS_LIVE_DISPATCH';
