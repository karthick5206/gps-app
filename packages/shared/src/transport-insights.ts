/**
 * Transport dashboard / management reports (GET /api/transport/insights?from&to, menu etms_dashboard): trips, people,
 * punctuality, seat use, km and safety for a date range, with breakdowns per day, per vehicle (the basis of trip / km
 * billing) and per shift. All counts come from the stored trips; nothing is estimated.
 */

/** A pickup counts as on time up to this many minutes after its planned time. */
export const ON_TIME_GRACE_MIN = 10;
/** Longest range one request may cover. */
export const INSIGHTS_MAX_DAYS = 92;

export interface TransportInsightsKpis {
  trips: number;
  tripsCompleted: number;
  tripsCancelled: number;
  tripsRunning: number;
  tripsNotStarted: number;
  /** Seats taken on trips (not cancelled passengers). */
  passengers: number;
  boarded: number;
  noShows: number;
  /** noShows / (boarded + noShows), 0..100; null without outcomes. */
  noShowPct: number | null;
  /** Pickup stops reached within ON_TIME_GRACE_MIN of the plan / pickup stops reached, 0..100; null without data. */
  onTimePct: number | null;
  /** Occupied / capacity over trips, 0..100; null without trips. */
  seatUsePct: number | null;
  /** Actual km of finished trips (GPS). */
  km: number;
  bookings: number;
  /** Bookings whose window ended without a seat (missed). */
  missedBookings: number;
  incidents: number;
}

export interface TransportInsightsDay {
  day: string;
  trips: number;
  passengers: number;
  km: number;
  onTimePct: number | null;
  noShows: number;
}

export interface TransportInsightsVehicle {
  objectId: string;
  vehicle: string;
  plateNumber: string | null;
  trips: number;
  tripsCompleted: number;
  km: number;
  passengers: number;
  seatUsePct: number | null;
  onTimePct: number | null;
}

export interface TransportInsightsShift {
  shift: string;
  direction: 'IN' | 'OUT';
  trips: number;
  passengers: number;
  noShows: number;
}

export interface TransportInsightsDto {
  from: string;
  to: string;
  kpis: TransportInsightsKpis;
  days: TransportInsightsDay[];
  vehicles: TransportInsightsVehicle[];
  shifts: TransportInsightsShift[];
}

export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
