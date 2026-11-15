import type { DriverHoursPolicy, DriverHoursProblem, VehicleAvailabilityKind } from '@veetracer/shared';

/**
 * Pure vehicle-timeline and driver working-hour rules (doc 20 §3.3 / §3.4, C1). Used by the publish transaction
 * (DispatchService.apply: VEHICLE_UNAVAILABLE / VEHICLE_TURNAROUND / DRIVER_HOURS), the live insertion and the plan
 * pre-checks. Times are epoch ms.
 */

export interface Span {
  start: number;
  end: number;
}

export interface AvailabilityRow {
  kind: VehicleAvailabilityKind | string;
  startsAt: Date | number;
  endsAt: Date | number;
}

const ms = (d: Date | number) => (typeof d === 'number' ? d : d.getTime());
const DAY = 86_400_000;

/**
 * Is the vehicle available for a trip over `span`?
 *  - a DOWNTIME / RESERVED window overlapping it, or maintenance (open-ended from `maintenanceSince`) → VEHICLE_UNAVAILABLE;
 *  - when the vehicle has OPERATING windows within a day of the trip, the trip must lie inside one → VEHICLE_UNAVAILABLE;
 *  - another active trip of the vehicle closer than `turnaroundS` before / after it → VEHICLE_TURNAROUND (only when a
 *    turnaround is set; overlap itself is VEHICLE_BUSY, the E3 rule).
 */
export function vehicleTimelineProblem(span: Span, rows: readonly AvailabilityRow[], maintenanceSince: Date | null, others: readonly Span[], turnaroundS: number | null): { code: 'VEHICLE_UNAVAILABLE' | 'VEHICLE_TURNAROUND'; message: string } | null {
  if (maintenanceSince && maintenanceSince.getTime() < span.end) return { code: 'VEHICLE_UNAVAILABLE', message: 'The vehicle is under maintenance' };
  for (const r of rows) {
    if (r.kind === 'OPERATING') continue;
    if (ms(r.startsAt) < span.end && ms(r.endsAt) > span.start) return { code: 'VEHICLE_UNAVAILABLE', message: `The vehicle is ${r.kind === 'RESERVED' ? 'reserved' : 'down'} at that time` };
  }
  const operating = rows.filter((r) => r.kind === 'OPERATING' && ms(r.startsAt) < span.end + DAY && ms(r.endsAt) > span.start - DAY);
  if (operating.length && !operating.some((r) => ms(r.startsAt) <= span.start && ms(r.endsAt) >= span.end)) return { code: 'VEHICLE_UNAVAILABLE', message: 'The trip is outside the vehicle\'s operating hours' };
  if (turnaroundS && turnaroundS > 0) {
    const t = turnaroundS * 1000;
    for (const o of others) {
      if (o.start < span.end && o.end > span.start) continue; // overlap: VEHICLE_BUSY elsewhere
      if ((o.end <= span.start && span.start - o.end < t) || (o.start >= span.end && o.start - span.end < t)) return { code: 'VEHICLE_TURNAROUND', message: `The vehicle needs ${Math.round(turnaroundS / 60)} min between trips` };
    }
  }
  return null;
}

/** Gap that separates two duties when the policy sets no minimum rest. */
export const DEFAULT_DUTY_GAP_S = 6 * 3600;

/** Policy with every field null = nothing is checked (P7). */
export function hasDriverHours(p: DriverHoursPolicy | null | undefined): p is DriverHoursPolicy {
  return !!p && (p.maxDutyS !== null || p.maxDrivingS !== null || (p.breakAfterS !== null && p.breakS !== null));
}

/**
 * Working-hour problems of a driver's planned trips (any origin, active), the new / changed ones included. Trips are
 * grouped into duties (a gap ≥ minRestS, default 6 h, starts a new one); per duty: span (first start → last end) vs
 * maxDutyS, total driving (sum of trip durations) vs maxDrivingS, and continuous driving — trips separated by less than
 * breakS count as one stretch — vs breakAfterS. Only the duty containing `focus` (the trip being written) is judged, so
 * an old violation elsewhere never blocks an unrelated change.
 */
export function driverHoursProblems(trips: readonly Span[], policy: DriverHoursPolicy | null | undefined, focus?: Span): DriverHoursProblem[] {
  if (!hasDriverHours(policy) || !trips.length) return [];
  const sorted = [...trips].sort((a, b) => a.start - b.start || a.end - b.end);
  const gap = (policy.minRestS ?? DEFAULT_DUTY_GAP_S) * 1000;
  const duties: Span[][] = [];
  let cur: Span[] = [];
  let curEnd = -Infinity;
  for (const t of sorted) {
    if (cur.length && t.start - curEnd >= gap) {
      duties.push(cur);
      cur = [];
    }
    cur.push(t);
    curEnd = Math.max(curEnd, t.end);
  }
  if (cur.length) duties.push(cur);
  const out: DriverHoursProblem[] = [];
  for (const d of duties) {
    if (focus && !d.some((t) => t.start === focus.start && t.end === focus.end)) continue;
    const span = (Math.max(...d.map((t) => t.end)) - d[0].start) / 1000;
    if (policy.maxDutyS !== null && span > policy.maxDutyS) out.push({ kind: 'MAX_DUTY', valueS: Math.round(span), limitS: policy.maxDutyS });
    const driving = d.reduce((s, t) => s + (t.end - t.start) / 1000, 0);
    if (policy.maxDrivingS !== null && driving > policy.maxDrivingS) out.push({ kind: 'MAX_DRIVING', valueS: Math.round(driving), limitS: policy.maxDrivingS });
    if (policy.breakAfterS !== null && policy.breakS !== null) {
      let stretch = 0;
      let stretchEnd = -Infinity;
      let worst = 0;
      for (const t of d) {
        if (t.start - stretchEnd >= policy.breakS * 1000) stretch = 0;
        stretch += (t.end - t.start) / 1000;
        stretchEnd = Math.max(stretchEnd, t.end);
        worst = Math.max(worst, stretch);
      }
      if (worst > policy.breakAfterS) out.push({ kind: 'BREAK_REQUIRED', valueS: Math.round(worst), limitS: policy.breakAfterS });
    }
  }
  return out;
}
