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
const PASSENGER_KINDS: readonly string[] = ['TRIP_STARTING_SOON', 'VEHICLE_APPROACHING', 'TRIP_DELAYED', 'TRIP_CANCELLED'];

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
export function transportPushTarget(data: TransportPushData | null | undefined, roles: Pick<TransportRoles, 'passenger' | 'driver'>): string | null {
  if (!isTransportPush(data)) return null;
  const d = data as TransportPushData & { kind: string };
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
 * A trip / booking id taken from a route (deep link `veetrax://duty/trip/<id>` or a typed URL), or null when it is not a
 * UUID (security review I1): only a validated id is ever put into an API path. Expo Router may hand over an array.
 */
export function routeUuid(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
}
