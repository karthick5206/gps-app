/**
 * "Needs attention" on Daily transport (pure, `node --test`): the exceptions a transport desk acts on, worked out from
 * the dispatch board — trips not started on time, running late, without a driver, on a vehicle with document issues,
 * finished with outcomes missing; riders still waiting close to their time, waiting for approval or without a point.
 */
import type { DispatchBoardDto } from '@veetracer/shared';

export type ExceptionKind = 'NOT_STARTED' | 'LATE' | 'NO_DRIVER' | 'NOT_COMPLIANT' | 'OUTCOME_MISSING' | 'WAITING_SOON' | 'TO_APPROVE' | 'NO_LOCATION' | 'SOS';

export interface DeskException {
  kind: ExceptionKind;
  severity: 'red' | 'amber';
  count: number;
  /** Trips concerned (open the trip). */
  tripIds: string[];
  /** Waiting bookings concerned (tick them). */
  bookingIds: string[];
  /** Vehicle / passenger names for the line. */
  names: string[];
}

/** Late / not started thresholds (minutes). */
export const NOT_STARTED_AFTER_MIN = 10;
export const LATE_AFTER_MIN = 10;
/** Riders still waiting this close to their pickup window. */
export const WAITING_SOON_MIN = 60;

const RUNNING = new Set(['EN_ROUTE', 'AT_STOP', 'IN_PROGRESS']);

export function deskExceptions(board: Pick<DispatchBoardDto, 'trips' | 'queue' | 'vehicles' | 'complianceMode'>, now: number, openSos = 0): DeskException[] {
  const out: DeskException[] = [];
  const push = (kind: ExceptionKind, severity: DeskException['severity'], tripIds: string[], bookingIds: string[], names: string[]) => {
    const count = tripIds.length + bookingIds.length;
    if (count) out.push({ kind, severity, count, tripIds, bookingIds, names });
  };
  const live = board.trips.filter((t) => !t.cancelledAt && t.derivedState !== 'CANCELLED');
  const label = (t: (typeof live)[number]) => t.vehicleName ?? t.name;

  if (openSos > 0) out.push({ kind: 'SOS', severity: 'red', count: openSos, tripIds: [], bookingIds: [], names: [] });
  const notStarted = live.filter((t) => t.plannedTripStatus === 'SCHEDULED' && !!t.publishedAt && !!t.plannedStart && Date.parse(t.plannedStart) < now - NOT_STARTED_AFTER_MIN * 60_000);
  push('NOT_STARTED', 'red', notStarted.map((t) => t.id), [], notStarted.map(label));
  const late = live.filter((t) => RUNNING.has(t.derivedState) && (t.delaySec ?? 0) >= LATE_AFTER_MIN * 60);
  push('LATE', 'amber', late.map((t) => t.id), [], late.map((t) => `${label(t)} (+${Math.round((t.delaySec ?? 0) / 60)} min)`));
  const noDriver = live.filter((t) => t.plannedTripStatus === 'SCHEDULED' && !t.driverId);
  push('NO_DRIVER', 'amber', noDriver.map((t) => t.id), [], noDriver.map(label));
  if (board.complianceMode !== 'OFF') {
    const bad = new Set(board.vehicles.filter((v) => v.compliance?.length).map((v) => v.objectId));
    const onBad = live.filter((t) => t.plannedTripStatus === 'SCHEDULED' && t.objectId && bad.has(t.objectId));
    push('NOT_COMPLIANT', board.complianceMode === 'BLOCK' ? 'red' : 'amber', onBad.map((t) => t.id), [], onBad.map(label));
  }
  const missing = live.filter((t) => (t.derivedState === 'COMPLETED' || t.derivedState === 'INCOMPLETE') && t.passengerCounts.pending > 0);
  push('OUTCOME_MISSING', 'amber', missing.map((t) => t.id), [], missing.map((t) => `${label(t)} (${t.passengerCounts.pending})`));

  const soon = board.queue.filter((b) => (b.status === 'PENDING_ASSIGNMENT' || b.status === 'REQUESTED' || b.status === 'WAITLISTED') && Date.parse(b.windowStart) <= now + WAITING_SOON_MIN * 60_000 && Date.parse(b.windowEnd) > now);
  push('WAITING_SOON', 'red', [], soon.map((b) => b.id), soon.map((b) => b.passenger.displayName));
  const approve = board.queue.filter((b) => b.status === 'REQUESTED' || b.status === 'WAITLISTED');
  push('TO_APPROVE', 'amber', [], approve.map((b) => b.id), approve.map((b) => b.passenger.displayName));
  const noPoint = board.queue.filter((b) => b.needsLocation || b.pointsHidden === 'CONSENT_REQUIRED');
  push('NO_LOCATION', 'amber', [], noPoint.map((b) => b.id), noPoint.map((b) => b.passenger.displayName));
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
}
