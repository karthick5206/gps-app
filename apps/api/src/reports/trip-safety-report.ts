import { TRIP_SAFETY_TYPES, TRIP_SAFETY_WEIGHTS, TripDto, TripSafetyOccurrence, TripSafetyReportRow, TripSafetyType } from '@veetracer/shared';

/** Alert fields the trip safety report reads. */
export interface SafetyAlert {
  id: string;
  objectId: string;
  type: string;
  occurredAt: Date;
  lat: number | null;
  lng: number | null;
  address: string | null;
  data: unknown;
}

/** Driver event (evidence) of an alert. */
export interface SafetyEvidence {
  id: string;
  alertId: string | null;
  hasClip: boolean;
}

export interface SafetyAssignment {
  objectId: string;
  driverName: string;
  fromTime: Date;
  toTime: Date | null;
}

const isSafetyType = (t: string): t is TripSafetyType => (TRIP_SAFETY_TYPES as readonly string[]).includes(t);

/** The violation types to count: the report's alert type filter (only safety types), else all of them. */
export function tripSafetyTypes(alertTypes?: string[]): TripSafetyType[] {
  const chosen = (alertTypes ?? []).filter(isSafetyType);
  return chosen.length ? chosen : [...TRIP_SAFETY_TYPES];
}

export function tripSafetyScore(counts: Partial<Record<TripSafetyType, number>>): number {
  const penalty = Object.entries(counts).reduce((sum, [type, n]) => sum + (TRIP_SAFETY_WEIGHTS[type as TripSafetyType] ?? 0) * (n ?? 0), 0);
  return Math.max(0, Math.round(100 - penalty));
}

const speedOf = (data: unknown): number | null => {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const v = d.speedKph ?? d.speed;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
};

/**
 * Buckets violation alerts into trips: an alert belongs to the trip of its vehicle whose start ≤ alert time ≤ end.
 * Trips and alerts are each sorted by time, so one pass per vehicle is enough.
 */
export function tripSafetyRows(
  trips: (TripDto & { plateNumber?: string | null })[],
  alerts: SafetyAlert[],
  evidence: SafetyEvidence[],
  assignments: SafetyAssignment[],
  types: readonly TripSafetyType[] = TRIP_SAFETY_TYPES,
): TripSafetyReportRow[] {
  const wanted = new Set<string>(types);
  const byAlert = new Map(evidence.filter((e) => e.alertId).map((e) => [e.alertId!, e]));
  const alertsByObject = new Map<string, SafetyAlert[]>();
  for (const a of alerts) {
    if (!wanted.has(a.type)) continue;
    const list = alertsByObject.get(a.objectId) ?? [];
    list.push(a);
    alertsByObject.set(a.objectId, list);
  }
  for (const list of alertsByObject.values()) list.sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime());

  return trips.map((trip) => {
    const start = Date.parse(trip.startTime);
    const end = Date.parse(trip.endTime);
    const inTrip = (alertsByObject.get(trip.objectId) ?? []).filter((a) => a.occurredAt.getTime() >= start && a.occurredAt.getTime() <= end);
    const counts: Partial<Record<TripSafetyType, number>> = {};
    const occurrences: TripSafetyOccurrence[] = inTrip.map((a) => {
      const type = a.type as TripSafetyType;
      counts[type] = (counts[type] ?? 0) + 1;
      const ev = byAlert.get(a.id);
      return { alertId: a.id, type, occurredAt: a.occurredAt.toISOString(), lat: a.lat, lng: a.lng, address: a.address, speedKph: speedOf(a.data), driverEventId: ev?.id ?? null, hasClip: !!ev?.hasClip };
    });
    const driver = assignments.find((d) => d.objectId === trip.objectId && d.fromTime.getTime() <= start && (!d.toTime || d.toTime.getTime() > start));
    return {
      ...trip,
      plateNumber: trip.plateNumber ?? null,
      driverName: driver?.driverName ?? null,
      counts,
      total: occurrences.length,
      score: tripSafetyScore(counts),
      occurrences,
    };
  });
}
