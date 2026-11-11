/**
 * English source labels for transport enums (translated where shown with t()). Same wording as the web app
 * (apps/web/src/features/transport/dispatch/e3-format.ts, people-format.ts) so the shared hi / ta translations apply.
 */
import type { ConsentPurpose, PassengerNoticeKind, TransportBookingStatus, TransportDirection, TransportPassengerStatus, TransportTripDerivedState } from '@veetracer/shared';
import type { Tone } from '@/lib/theme';

export const DIRECTION_LABEL: Record<TransportDirection, string> = { IN: 'To site (login)', OUT: 'From site (logout)' };

export const TRIP_STATE_META: Record<TransportTripDerivedState, { label: string; tone: Tone }> = {
  PLANNED: { label: 'Planned', tone: 'neutral' },
  PUBLISHED: { label: 'Published', tone: 'info' },
  DRIVER_ACKNOWLEDGED: { label: 'Driver acknowledged', tone: 'info' },
  EN_ROUTE: { label: 'En route', tone: 'info' },
  AT_STOP: { label: 'At a stop', tone: 'warning' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  INCOMPLETE: { label: 'Incomplete', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  DETACHED: { label: 'Vehicle removed', tone: 'neutral' },
};

export const PASSENGER_STATUS_META: Record<TransportPassengerStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'neutral' },
  BOARDED: { label: 'Boarded', tone: 'success' },
  NO_SHOW: { label: 'No-show', tone: 'destructive' },
  DROPPED: { label: 'Dropped', tone: 'success' },
  CANCELLED: { label: 'Removed', tone: 'neutral' },
};

/** Passenger-facing booking status words (the web's dispatcher hints are not shown to passengers). */
export const BOOKING_STATUS_META: Record<TransportBookingStatus, { label: string; tone: Tone }> = {
  REQUESTED: { label: 'Needs approval', tone: 'warning' },
  PENDING_ASSIGNMENT: { label: 'Waiting for a seat', tone: 'info' },
  ASSIGNED: { label: 'Assigned', tone: 'success' },
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'destructive' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  WAITLISTED: { label: 'Waitlisted', tone: 'warning' },
  FAILED: { label: 'Failed', tone: 'destructive' },
};

export const CONSENT_PURPOSE_META: Record<ConsentPurpose, { label: string; description: string }> = {
  TRANSPORT_PROFILE: {
    label: 'Transport planning',
    description: 'Your home location and profile may be used to plan your pickups. Without it, no location of yours is used for routing.',
  },
  PICKUP_LOCATION_SHARE: { label: 'Live pickup location', description: 'You may share your live location around a pickup.' },
  SOS_LOCATION: { label: 'SOS location', description: 'Your location is sent with an SOS alert.' },
  NOTIFICATIONS_SMS: { label: 'SMS notifications', description: 'Trip updates may be sent to you by SMS.' },
};

export const NOTICE_KIND_LABEL: Record<PassengerNoticeKind, string> = {
  CONSENT_RECORDED_OFFLINE: 'Your transport desk recorded a consent you gave on paper.',
  CONSENT_WITHDRAWN_BY_ADMIN: 'Your transport desk withdrew a consent on your behalf.',
  LOGIN_PASSWORD_SET: 'A password was set for your login.',
  LOGIN_RESET_ISSUED: 'A password reset was issued for your login.',
  LOGIN_DISABLED: 'Your login was disabled.',
  TRANSPORT_STOPPED_CONSENT_WITHDRAWN: 'You withdrew consent to use your location, so your upcoming bookings that needed it were cancelled.',
};

/** Passenger-facing texts for API error codes; others fall back to the server message. */
export const ERROR_TEXT: Record<string, string> = {
  NOT_A_PASSENGER: 'Your account is not linked to an active passenger profile. Ask your transport desk.',
  CONSENT_NOTICE_OUTDATED: 'The notice was updated. Please read the new version.',
  CONSENT_NOTICE_MISSING: 'Your company has not published this notice yet.',
  ETMS_DISABLED: 'Employee transport is not switched on for your company.',
  DRIVER_INACTIVE: 'Your driver login is not active. Contact your dispatcher.',
  NOT_FOUND: 'This trip is no longer assigned to you.',
  AFTER_CUTOFF: 'The cancellation cut-off for this booking has passed. Call your transport desk.',
  INVALID_STATE: 'This booking can no longer be cancelled here (its trip may have started). Call your transport desk.',
};

// ───────────── Driver ─────────────

export const DRIVER_EVENT_LABEL: Record<string, string> = {
  ACKNOWLEDGE: 'Acknowledge trip',
  ARRIVED: 'Arrived at stop',
  BOARDED: 'Boarded',
  NO_SHOW: 'No-show',
  DROPPED: 'Dropped',
  DEPARTED: 'Left the stop',
  REPORT_DELAY: 'Delay reported',
  REPORT_BREAKDOWN: 'Breakdown reported',
  COMPLETE_TRIP: 'Complete trip',
};

export const REASON_LABEL: Record<string, string> = {
  TRAFFIC: 'Traffic',
  ROAD_BLOCKED: 'Road blocked',
  WEATHER: 'Weather',
  VEHICLE_ISSUE: 'Vehicle issue',
  PASSENGER_LATE: 'Passenger late',
  ENGINE: 'Engine',
  TYRE: 'Tyre',
  ACCIDENT: 'Accident',
  FUEL: 'Fuel',
  NOT_AT_PICKUP: 'Not at the pickup point',
  UNREACHABLE: 'Could not be reached',
  CANCELLED_AT_DOOR: 'Cancelled at the door',
  OTHER: 'Other',
};

/** Driver-facing texts for rejection / error codes (contract DRIVER_ERROR_CODES). */
export const DRIVER_CODE_TEXT: Record<string, string> = {
  NOT_A_DRIVER: 'Your login is not linked to a driver. Contact your dispatcher.',
  DRIVER_INACTIVE: 'Your driver login is not active. Contact your dispatcher.',
  DRIVER_DOCUMENTS_EXPIRED: 'Your licence has expired. Trips cannot be started.',
  NOT_ASSIGNED: 'This trip is no longer assigned to you.',
  NOT_FOUND: 'This trip is no longer assigned to you.',
  TRIP_CLOSED: 'The trip is already closed.',
  TRIP_NOT_STARTED: 'Start the trip first.',
  INVALID_STATE: 'Not possible in the current trip state.',
  OUTSIDE_START_WINDOW: 'Too early or too late to start this trip.',
  VEHICLE_BUSY: 'The vehicle is on another active trip.',
  STALE_COMMAND: 'The command was too old when it reached the server. Try again while online.',
  ONLINE_ONLY: 'This needs a connection.',
  NOT_AT_STOP: 'The vehicle GPS is not at this stop.',
  STOP_NOT_ARRIVED: 'Mark the stop as arrived first.',
  WAIT_NOT_ELAPSED: 'Wait a few minutes after arriving before marking a no-show.',
  NOT_AT_DROP_STOP: 'This is not the passenger’s drop stop.',
  UNRESOLVED_PASSENGERS: 'Record every passenger at this stop first.',
  PASSENGERS_ON_BOARD: 'Passengers are still on board.',
  CONFLICT: 'A different outcome was already recorded.',
  OUT_OF_ORDER: 'Waiting for an earlier action to sync.',
  CLOCK_SKEW: 'The phone clock is wrong. Check the date and time.',
  DUTY_OPEN: 'A duty is already open.',
  NO_OPEN_DUTY: 'No duty is open.',
  ALREADY_RECORDED: 'Already recorded.',
  LATE: 'Received after the trip closed: no effect.',
};
