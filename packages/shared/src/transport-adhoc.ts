/**
 * WP 3.9 wave 2 (owner decisions 2026-11-12, after D-A1..D-A4):
 *   D-A5 approval — passenger ad-hoc requests need approval when the company setting `etms.selfBookingApproval` is on
 *        (DEFAULT ON: absent = approval required). Approved → PENDING_ASSIGNMENT (dispatch as usual); rejected →
 *        REJECTED with the reason. The passenger is notified either way (BOOKING_APPROVED / BOOKING_REJECTED, generic).
 *   D-A6 approvers — anyone with `etms_bookings:approve` in scope: Transport admin (company) and branch dispatchers for
 *        their own branches (the existing approve / reject / bulk-approve routes, unchanged permissions).
 *   D-A7 passenger choices — pickup and destination from home, saved places, company places (offices / shuttle stops /
 *        sites the passenger may use) or a one-time map point (personal point: needs the passenger's active consent,
 *        D-A3), with an optional own time window; point-to-point allowed. Self-service rules stay: never after the
 *        cut-off (409 AFTER_CUTOFF), at most TRANSPORT_SELF_LIMITS.maxDaysAhead days ahead, one seat.
 *   D-A8 group rides — one dispatcher form books several passengers (e.g. a site visit): one linked booking per passenger
 *        (shared `groupId`, `purpose`), created all-or-nothing, dispatchable together on one trip; each passenger gets
 *        BOOKING_CREATED.
 * Schema (Lead amends the undeployed migration 20261121090000_etms_booking_journey): TransportBooking.groupId UUID NULL
 * (indexed), TransportBooking.purpose TEXT NULL.
 */
import type { GeoPoint, TransportBookingDto, TransportBookingJourney, TransportDirection } from './transport-trips';

export const TRANSPORT_ADHOC_LIMITS = {
  /** Passengers per group booking (2..groupMax). */
  groupMin: 2,
  groupMax: 30,
  purposeMax: 120,
  // D-A9 passenger self profile (server-enforced; the apps mirror them in their forms).
  emergencyContactsMax: 3,
  contactNameMax: 80,
  contactPhoneMax: 20,
  contactRelationMax: 40,
  accessibilityNotesMax: 500,
  homeAddressMax: 200,
  /** GET /me/transport/geocode: searches per passenger per minute (429 RATE_LIMITED beyond). */
  geocodePerMinute: 20,
  geocodeMinChars: 3,
  geocodeMaxHits: 6,
} as const;

// ───────────────────────────── Passenger ad-hoc request (D-A5, D-A7) ─────────────────────────────

/**
 * One end of a passenger's request. HOME: the profile's routing pickup (consent required, else 409 CONSENT_REQUIRED —
 * a request never becomes "needs location"); SAVED: a saved place (consent required); PLACE: a company place from
 * `GET /me/transport/request-places`; MAP: a one-time point picked on the self-hosted map (consent required; label
 * optional, ≤ 60 chars); SHIFT_SITE: the chosen shift's site (requires `shiftId`).
 */
export type MeAdhocEndRef =
  | { kind: 'HOME' }
  | { kind: 'SAVED'; placeId: string }
  | { kind: 'PLACE'; poiId: string }
  | { kind: 'MAP'; lat: number; lng: number; label?: string | null }
  | { kind: 'SHIFT_SITE' };

/**
 * POST /api/me/transport/requests (header Idempotency-Key, required; permission etms_self; 404 SELF_BOOKING_DISABLED
 * while `etms.selfBooking` is off). COMMUTE needs `direction` and either `shiftId` or a window; POINT_TO_POINT needs a
 * window, `direction` ignored. Status: REQUESTED when approval is required (D-A5), else PENDING_ASSIGNMENT. Same
 * eligibility / consent / duplicate / overlap rules as every booking (NOT_ELIGIBLE, CONSENT_REQUIRED,
 * BOOKING_DUPLICATE, BOOKING_OVERLAP, AFTER_CUTOFF). Answer: MeBookingDto (+ `needsApproval`).
 */
export interface MeAdhocRequestInput {
  serviceDate: string;
  journey: TransportBookingJourney;
  direction?: TransportDirection;
  shiftId?: string | null;
  pickup: MeAdhocEndRef;
  destination: MeAdhocEndRef;
  windowStart?: string;
  windowEnd?: string;
  /** Why the ride is needed (e.g. "Client visit"); shown to the transport team. */
  purpose?: string | null;
  note?: string | null;
}

/** GET /api/me/transport/request-places?q= — company places a passenger may pick (active Pois of categories OFFICE and SHUTTLE_STOP, plus the shift sites), at most 50. */
export interface MeRequestPlaceDto {
  id: string;
  name: string;
  category: string | null;
}

/** Added to MeTransportPolicyDto (GET /me/transport/policy). */
export interface MeAdhocPolicyFields {
  /** Passenger ad-hoc requests are possible (= selfBooking on). */
  adhocRequests: boolean;
  /** Requests wait for transport-team approval (company `etms.selfBookingApproval`, default true). */
  approvalRequired: boolean;
}

// ───────────────────────────── Group booking (D-A8) ─────────────────────────────

/** Pickup of a group: one common point (company place or one-time point), or each passenger's own home pickup (consent required for each). */
export type TransportGroupPickup = { mode: 'COMMON'; point: GeoPoint } | { mode: 'OWN' };

/**
 * POST /api/transport/bookings/group (header Idempotency-Key, required; etms_bookings:create; every passenger in the
 * caller's scope — one out of scope → 404 for the whole request). Creates one booking per passenger, sharing `groupId`
 * and `purpose`, in ONE transaction: all or nothing. Per-passenger failures answer 422 GROUP_INVALID with
 * `failures: { passengerId, code, reason? }[]` (code = NOT_ELIGIBLE / CONSENT_REQUIRED / BOOKING_DUPLICATE /
 * BOOKING_OVERLAP / NEEDS_LOCATION). Same cut-off / late-reason rule as a single booking. Each passenger gets
 * BOOKING_CREATED. A replay with the same key answers the same group.
 */
export interface CreateTransportGroupBookingInput {
  passengerIds: string[];
  serviceDate: string;
  journey: TransportBookingJourney;
  direction?: TransportDirection;
  shiftId?: string | null;
  pickup: TransportGroupPickup;
  drop: GeoPoint;
  windowStart?: string;
  windowEnd?: string;
  /** Required, ≤ purposeMax (e.g. "Site visit — plant 2"). */
  purpose: string;
  note?: string | null;
  hold?: boolean;
  lateReason?: string;
}

export interface TransportGroupBookingResult {
  groupId: string;
  bookings: TransportBookingDto[];
}

export interface TransportGroupFailure {
  passengerId: string;
  code: string;
  reason?: string;
}

/**
 * Fields added by wave 2 (the API agent adds them to the existing DTOs):
 *   TransportBookingDto.groupId: string | null; TransportBookingDto.purpose: string | null;
 *   TransportBookingListQuery.groupId?: string;
 *   MeBookingDto.purpose: string | null; MeBookingDto.needsApproval: boolean (status REQUESTED);
 *   TransportSettingsDto.selfBookingApproval?: boolean (absent = true) — a managed key of PUT /transport/settings;
 *   notification kinds BOOKING_APPROVED, BOOKING_REJECTED (passenger, generic text, push data { kind, bookingId, notificationId }).
 */
export type AdhocWave2Note = never;

// ───────────────────────────── Passenger self profile and home location (D-A9, owner 2026-11-12) ─────────────────────────────

/**
 * D-A9: a passenger maintains their own transport profile in the app (and the web "My transport" page):
 *   - views name, employee code, branch, office, default stop, login email / mobile (read-only: identity, D5), home
 *     address label, emergency contacts, accessibility needs;
 *   - edits the HOME location (used as pickup to the office and drop from it) by self-hosted address search
 *     (GET /me/transport/geocode?q=, Photon behind the GEOCODER_NOT_PRIVATE guard, rate-limited per user) or by a map
 *     pin / typed lat-lng. Needs the active routing consent (409 CONSENT_REQUIRED); audited (before/after without
 *     coordinates in the audit summary); homeGeocodeSource PHOTON | PIN | TYPED. New and schedule-generated bookings use
 *     the new point; already-made bookings keep their snapshot (answer `openBookingsKept` = count, the app says so);
 *   - edits the default stop (one of the allowed company stops), emergency contacts (≤ 3 { name, phone, relation? }),
 *     accessibility { wheelchair?, notes? }.
 * Permission etms_self; own profile only (PeopleService.myProfileRow: 403 NOT_A_PASSENGER). No schema change.
 */
export interface MeTransportProfileDto {
  displayName: string;
  employeeCode: string;
  branchName: string | null;
  officeName: string | null;
  defaultStop: { id: string; name: string } | null;
  email: string | null;
  mobile: string | null;
  /** Home: label always; coordinates only while the routing consent is active (else null). */
  home: { address: string | null; lat: number | null; lng: number | null; source: string | null } | null;
  emergencyContacts: { name: string; phone: string; relation?: string | null }[];
  accessibility: { wheelchair?: boolean; notes?: string | null };
  routingConsent: boolean;
}

/** PATCH /api/me/transport/profile — any subset. */
export interface MeTransportProfileUpdateInput {
  defaultStopId?: string | null;
  emergencyContacts?: { name: string; phone: string; relation?: string | null }[];
  accessibility?: { wheelchair?: boolean; notes?: string | null };
}

/** PUT /api/me/transport/home — set (or with `clear: true` remove) the home location. */
export interface MeHomeLocationInput {
  lat?: number;
  lng?: number;
  /** Address text (from the search hit or typed), ≤ 200 chars. */
  address?: string | null;
  source?: 'PHOTON' | 'PIN' | 'TYPED';
  clear?: boolean;
}

export interface MeHomeLocationResult {
  profile: MeTransportProfileDto;
  /** Open bookings that keep their earlier point. */
  openBookingsKept: number;
}

/** GET /api/me/transport/geocode?q= (min 3 chars, ≤ 6 hits, self-hosted only). */
export interface MeGeocodeHitDto {
  label: string;
  lat: number;
  lng: number;
}
