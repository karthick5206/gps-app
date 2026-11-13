/**
 * ETMS E5 WP 5.3: passenger self-service (doc 05 §2.8, doc 08 §4.2). Every route is `/api/me/transport/*`, menu
 * `etms_self` + the caller's own active passenger profile (403 NOT_A_PASSENGER), company add-on `etms`, AND the company
 * setting `etms.selfBooking` (TransportSettingsDto.selfBooking, default OFF: 404 SELF_BOOKING_DISABLED). Only
 * `GET /me/transport/policy` answers while it is off, so the app knows whether to show the booking screens.
 */
import type { MeAdhocPolicyFields } from './transport-adhoc';
import type { TransportBookingStatus, TransportDirection, TransportPassengerStatus, TransportPickupMode } from './transport-trips';

/** Limits of passenger self-service (server-enforced; the app mirrors them for its forms). */
export const TRANSPORT_SELF_LIMITS = {
  /** A passenger books at most this many days ahead (the dispatcher's limit is TRANSPORT_E3_LIMITS.adhocMaxDaysAhead). */
  maxDaysAhead: 14,
  /** Saved places per passenger. */
  maxPlaces: 10,
  placeLabelMax: 60,
  bookingNoteMax: 200,
  reportNoteMax: 500,
  /** A report is accepted from 2 h before the trip's planned start until 48 h after its planned end. */
  reportBeforeStartMin: 120,
  reportAfterEndMin: 48 * 60,
} as const;

/** Error code of every gated self-service route while the company setting is off (plain 404, like ETMS_DISABLED). */
export const SELF_BOOKING_DISABLED = 'SELF_BOOKING_DISABLED';

/** A shift the passenger may book (active shifts of their company). */
export interface MeBookableShiftDto {
  id: string;
  name: string;
  /** Office site name (the company end of the trip), null when the shift has none. */
  siteName: string | null;
  /** Minutes after local midnight (login / logout). */
  startMin: number;
  endMin: number;
  overnight: boolean;
  /** Weekdays the shift runs: 0 = Sunday … 6 = Saturday. */
  days: number[];
  timeZone: string;
}

/** A company pickup point (Poi of category STOP / OFFICE …) the passenger may choose instead of a personal point. */
export interface MeCompanyStopDto {
  id: string;
  name: string;
}

/** GET /me/transport/policy: what the passenger may do (doc 08 "Book (ad-hoc)": cut-offs, modes, limits). */
export interface MeTransportPolicyDto extends MeAdhocPolicyFields {
  /** Company setting `etms.selfBooking` (default false). When false every other route below answers 404. */
  selfBooking: boolean;
  /** Booking cut-off before the window start, minutes (company `etms.bookingCutoffMin`, default 60). */
  cutoffMin: number;
  maxDaysAhead: number;
  /** Bookable shifts and company stops; empty while selfBooking is off. */
  shifts: MeBookableShiftDto[];
  stops: MeCompanyStopDto[];
  /** The caller's own routing consent (TRANSPORT_PROFILE): needed for a home or saved-place pickup. */
  routingConsent: boolean;
  /**
   * Whether this server accepts passenger SOS (`POST /me/transport/sos`, WP 5.4). False until the durable SOS route is
   * deployed; the app then shows only the call buttons (never a button that cannot be delivered).
   */
  sos: boolean;
  deskPhone: string | null;
}

// ───────────────────────────── Saved places ─────────────────────────────

/**
 * A saved place: a personal point stored on the passenger's own profile (`preferences.places`). Coordinates are only
 * returned while the routing consent is active (doc 02 §7, 10 §4); without it `lat` / `lng` are null and the place
 * cannot be used for a booking (403 CONSENT_REQUIRED). Erasure removes them with the profile preferences.
 */
export interface MePlaceDto {
  id: string;
  label: string;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

export interface MePlaceInput {
  label: string;
  lat: number;
  lng: number;
}

export interface MePlaceUpdateInput {
  label?: string;
  lat?: number;
  lng?: number;
}

// ───────────────────────────── Booking ─────────────────────────────

/**
 * The passenger's end of the trip: home (the profile's routing pickup, only with consent; without it the booking is
 * made "needs location" exactly like a dispatcher booking), a saved place (consent required), or a company stop.
 * The company end is always the shift's site.
 */
export type MePlaceRef = { kind: 'HOME' } | { kind: 'SAVED'; placeId: string } | { kind: 'STOP'; poiId: string };

/** POST /me/transport/bookings (Idempotency-Key header). One seat, own profile, an active shift, before its cut-off. */
export interface MeCreateBookingInput {
  serviceDate: string;
  direction: TransportDirection;
  shiftId: string;
  place: MePlaceRef;
  note?: string;
}

// ───────────────────────────── Commute ─────────────────────────────

export interface MeScheduleDto {
  id: string;
  shiftName: string;
  direction: TransportDirection;
  days: number[];
  pickupMode: TransportPickupMode;
  stopName: string | null;
  validFrom: string;
  validTo: string | null;
  /** Upcoming exceptions (next TRANSPORT_SELF_LIMITS.maxDaysAhead days): leave days / overrides set by the desk. */
  exceptions: { date: string; kind: string }[];
}

/** GET /me/transport/schedule: the recurring commute and the upcoming bookings it made. */
export interface MeCommuteDto {
  schedules: MeScheduleDto[];
  upcoming: { id: string; serviceDate: string; direction: TransportDirection; status: TransportBookingStatus; windowStart: string; windowEnd: string; timeZone: string }[];
}

// ───────────────────────────── Confirm / report ─────────────────────────────

export const ME_CONFIRM_KINDS = ['PICKUP', 'DROP'] as const;
export type MeConfirmKind = (typeof ME_CONFIRM_KINDS)[number];

/**
 * POST /me/transport/trips/:id/confirm. Owner decision P5 default: the driver is authoritative; the passenger's
 * confirmation is recorded as a dispute signal only (trip event PASSENGER_CONFIRM) and never changes the seat status.
 * Idempotent on clientEventId (same id + same user + same command = DUPLICATE).
 */
export interface MeTripConfirmInput {
  clientEventId: string;
  kind: MeConfirmKind;
}

export interface MeTripConfirmResult {
  clientEventId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE';
  /** The seat status the driver / dispatcher recorded (authoritative). */
  myStatus: TransportPassengerStatus;
  /** True when the passenger's confirmation contradicts the recorded status (e.g. PICKUP on a NO_SHOW): the desk sees it. */
  mismatch: boolean;
}

export const ME_REPORT_CATEGORIES = ['DELAY', 'MISSED_PICKUP', 'VEHICLE', 'DRIVER_BEHAVIOUR', 'ROUTE', 'OTHER'] as const;
export type MeReportCategory = (typeof ME_REPORT_CATEGORIES)[number];

/** POST /me/transport/trips/:id/reports: delay / missed pickup / concern (trip event PASSENGER_REPORT). Not an SOS. */
export interface MeTripReportInput {
  clientEventId: string;
  category: MeReportCategory;
  note?: string;
}

export interface MeTripReportResult {
  clientEventId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE';
  receivedAt: string;
}

/** Whether a passenger confirmation contradicts the authoritative seat status (pure; server and app). */
export function confirmMismatch(kind: MeConfirmKind, status: TransportPassengerStatus): boolean {
  if (kind === 'PICKUP') return status === 'NO_SHOW' || status === 'CANCELLED';
  return status === 'NO_SHOW' || status === 'CANCELLED' || status === 'PENDING';
}
