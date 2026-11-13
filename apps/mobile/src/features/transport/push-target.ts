/**
 * Where a tapped ETMS push opens (pure, `node --test`; doc 02 §8.3, D7 / L4, contract `transport-driver.ts`).
 *
 * ETMS pushes are generic: the title / body say nothing personal and `data` carries only `{ kind, tripId,
 * notificationId }` (bookingId / incidentId in later phases). The app never shows anything from the payload: it opens
 * a screen that fetches the details over the authenticated API. Ids are validated (UUID) so a malformed payload cannot
 * build an arbitrary route.
 */
import type { TransportRoles } from './roles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors DRIVER_NOTIFICATION_KINDS / PASSENGER_NOTIFICATION_KINDS of @veetracer/shared (literal: no runtime import). */
const DRIVER_KINDS: readonly string[] = ['TRIP_ASSIGNED', 'TRIP_CHANGED', 'TRIP_UNASSIGNED', 'TRIP_CANCELLED'];
const PASSENGER_KINDS: readonly string[] = ['TRIP_STARTING_SOON', 'VEHICLE_APPROACHING', 'TRIP_DELAYED', 'TRIP_CANCELLED', 'BOOKING_CREATED'];

/** WP 3.9 (D-A4): the desk booked a ride for the passenger. Push data `{ kind, bookingId, notificationId }`, tripId null. */
export const BOOKING_CREATED = 'BOOKING_CREATED';

/** The passenger booking list, focused on one booking when its id is a valid UUID (the screen fetches it over the API). */
export function bookingsRoute(bookingId: unknown): string {
  return typeof bookingId === 'string' && UUID.test(bookingId) ? `/commute/bookings?bookingId=${bookingId.toLowerCase()}` : '/commute/bookings';
}

export type TransportPushData = Record<string, unknown>;

/** True when the payload looks like an ETMS push (and not a fleet alert, which carries `alertId`). */
export function isTransportPush(data: TransportPushData | null | undefined): boolean {
  if (!data || typeof data.alertId === 'string') return false;
  return typeof data.kind === 'string' && ['tripId', 'bookingId', 'incidentId', 'notificationId'].some((k) => typeof data[k] === 'string');
}

/**
 * Route for a tapped ETMS push, or null when there is nothing this user may open.
 * - Driver-only kinds open the driver trip (or the duty screen without a valid trip id); a revoked trip shows
 *   "no longer assigned" there.
 * - Passenger-only kinds open the passenger trip (or My commute).
 * - A kind both audiences receive (TRIP_CANCELLED) opens the trip in the section the user has; a user with both
 *   sections gets the matching list instead of guessing.
 */
export type PushRoles = Pick<TransportRoles, 'passenger' | 'driver'> & Partial<Pick<TransportRoles, 'incidents' | 'fleet'>>;

/** The dispatcher SOS push (`{ kind: 'SOS', sos: true, tripId, notificationId = incident id }`, WP 5.4). */
export function isSosPush(data: TransportPushData | null | undefined): boolean {
  return isTransportPush(data) && (data!.kind === 'SOS' || data!.sos === true);
}

/**
 * Where a tapped dispatcher SOS push opens (r114, QA B2). Its `tripId` is the RAISER's trip and its `notificationId`
 * is the incident id, so it must never be read as a passenger / driver trip push (that opened a 404 trip and marked
 * the incident id "read" in the wrong inbox).
 * - `etms_incidents:view` + a valid incident id → the read-only incident screen.
 * - Otherwise the user's notification list: fleet Alerts, the driver Inbox, or the passenger Notices.
 */
export function sosPushTarget(data: TransportPushData, roles: PushRoles): string | null {
  const raw = typeof data.incidentId === 'string' ? data.incidentId : data.notificationId;
  const incidentId = typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : null;
  if (roles.incidents && incidentId) return `/transport-incident/${incidentId}`;
  if (roles.fleet) return '/alerts';
  if (roles.driver) return '/driver-inbox';
  if (roles.passenger) return '/commute/notices';
  return null;
}

export function transportPushTarget(data: TransportPushData | null | undefined, roles: PushRoles): string | null {
  if (!isTransportPush(data)) return null;
  if (isSosPush(data)) return sosPushTarget(data as TransportPushData, roles);
  const d = data as TransportPushData & { kind: string };
  // A booking made for the passenger has no trip yet (tripId null): open the booking, never a trip screen.
  if (d.kind === BOOKING_CREATED) return roles.passenger ? bookingsRoute(d.bookingId) : null;
  const tripId = typeof d.tripId === 'string' && UUID.test(d.tripId) ? d.tripId : null;
  const forDriver = DRIVER_KINDS.includes(d.kind) || /^(driver|duty)/i.test(d.kind);
  const forPassenger = PASSENGER_KINDS.includes(d.kind) || (!forDriver && (typeof d.bookingId === 'string' || typeof d.tripId === 'string'));
  const driver = forDriver && roles.driver;
  const passenger = forPassenger && roles.passenger;
  if (driver && passenger) return '/duty';
  if (driver) return tripId ? `/duty/trip/${tripId}` : '/duty';
  if (passenger) {
    if (tripId) return `/commute/trip/${tripId}`;
    if (typeof d.bookingId === 'string' && UUID.test(d.bookingId)) return '/commute/bookings';
    return '/commute/notices';
  }
  return null;
}

/**
 * Where a row of the in-app transport inbox opens, or null when it has nothing to open. Only ids go into the route; the
 * screen fetches the details over the authenticated API. BOOKING_CREATED has no trip: it opens the booking (by
 * `bookingId` when the server sends one, else the Bookings list).
 */
export function inboxTarget(n: { kind: string; tripId?: string | null; bookingId?: unknown }, audience: 'passenger' | 'driver'): string | null {
  if (n.kind === BOOKING_CREATED) return audience === 'passenger' ? bookingsRoute(n.bookingId) : null;
  const tripId = typeof n.tripId === 'string' && UUID.test(n.tripId) ? n.tripId : null;
  if (!tripId) return null;
  return audience === 'driver' ? `/duty/trip/${tripId}` : `/commute/trip/${tripId}`;
}

/**
 * A trip / booking id taken from a route (deep link `veetrax://duty/trip/<id>` or a typed URL), or null when it is not a
 * UUID (security review I1): only a validated id is ever put into an API path. Expo Router may hand over an array.
 */
export function routeUuid(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
}
