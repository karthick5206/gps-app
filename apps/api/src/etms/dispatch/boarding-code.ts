import { createHmac } from 'node:crypto';

/**
 * v1.16.7 boarding OTP: a 4-digit code per seat (TransportTripPassenger id), derived from the server secret, so nothing
 * is stored and the passenger's app and the server always agree. Shown to the passenger (GET /me/transport/trips) and
 * checked on the driver's BOARDED event while the company setting `etms.boardingOtp` is on.
 */
export function boardingCodeFor(passengerTripId: string, secret: string = process.env.ETMS_BOARDING_SECRET || process.env.JWT_SECRET || 'veetrax-boarding'): string {
  const n = createHmac('sha256', `boarding:${secret}`).update(passengerTripId).digest().readUInt32BE(0) % 10_000;
  return String(n).padStart(4, '0');
}

/** Company setting `etms.boardingOtp` (default off). */
export function boardingOtpOn(settings: unknown): boolean {
  const e = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>).etms : undefined;
  return typeof e === 'object' && e !== null && (e as Record<string, unknown>).boardingOtp === true;
}
