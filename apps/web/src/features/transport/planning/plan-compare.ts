/**
 * E4 WP-W compare with the WP-A metrics (GET /route-plans/compare; definitions ROUTE_PLAN_METRIC_DEFINITIONS). Pure
 * (`node --test`). Rows = metrics, columns = plans; a best-value marker per row (`bestOf`: none when all tie or fewer
 * than two plans have a value). The help texts are plain-language versions of the shared definitions (same keys).
 */
import { ROUTE_PLAN_METRIC_DEFINITIONS, type RoutePlanMetricsDto } from '@veetracer/shared';
import { bestOf, formatDuration, formatKm, unassignedReason } from './planner-format.ts';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(vars?.[n] ?? ''));

export type MetricKey = keyof typeof ROUTE_PLAN_METRIC_DEFINITIONS;

/** Plain-language help for each shared metric definition (the tooltip of the row). */
export const METRIC_HELP: Record<MetricKey, string> = {
  vehiclesUsed: 'Routes that carry at least one stop.',
  passengersAssigned: 'Seats taken by passengers who are on a route.',
  bookingsAssigned: 'Bookings that are on a route.',
  totalDistanceM: 'Road distance of all routes together. Empty when a route has no engine distance.',
  totalTravelS: 'Driving time of all routes together (road estimate, no live traffic). Empty when a route is not timed.',
  maxRideS: 'Longest time one passenger spends in the vehicle, from pickup to drop.',
  avgRideS: 'Average time a passenger spends in the vehicle.',
  occupancy: 'Seats taken out of the vehicle seats, per route.',
  avgOccupancy: 'Average of the routes’ seat use (routes with seats set).',
  deadlineCompliance: 'Passengers who reach the site (login) or leave it (logout) inside their booked window, out of those with a window and a time.',
  excluded: 'Bookings that are on no route, by reason.',
  strategy: 'The strategy of the last optimisation. Empty for raw weights or a plan not optimised yet.',
};

export interface CompareRow {
  key: 'vehiclesUsed' | 'passengersAssigned' | 'totalDistanceM' | 'totalTravelS' | 'maxRideS' | 'avgRideS' | 'avgOccupancy' | 'deadlineCompliance' | 'excluded';
  label: string;
  best: 'min' | 'max';
  help: MetricKey;
}

export const E4_COMPARE_ROWS: readonly CompareRow[] = [
  { key: 'vehiclesUsed', label: 'Vehicles used', best: 'min', help: 'vehiclesUsed' },
  { key: 'passengersAssigned', label: 'Passengers seated', best: 'max', help: 'passengersAssigned' },
  { key: 'totalDistanceM', label: 'Total distance', best: 'min', help: 'totalDistanceM' },
  { key: 'totalTravelS', label: 'Total drive time', best: 'min', help: 'totalTravelS' },
  { key: 'maxRideS', label: 'Longest ride', best: 'min', help: 'maxRideS' },
  { key: 'avgRideS', label: 'Average ride', best: 'min', help: 'avgRideS' },
  { key: 'avgOccupancy', label: 'Average occupancy', best: 'max', help: 'avgOccupancy' },
  { key: 'deadlineCompliance', label: 'On time', best: 'max', help: 'deadlineCompliance' },
  { key: 'excluded', label: 'Not on a route', best: 'min', help: 'excluded' },
];

/** The compare answer carries the WP-A metrics (older servers / mocks do not). */
export const hasE4Metrics = (plans: readonly RoutePlanMetricsDto[]): boolean => plans.length > 0 && plans.every((p) => p.vehiclesUsed !== undefined);

export function e4Value(m: RoutePlanMetricsDto, key: CompareRow['key']): number | null {
  switch (key) {
    case 'vehiclesUsed':
      return m.vehiclesUsed ?? null;
    case 'passengersAssigned':
      return m.passengersAssigned ?? null;
    case 'totalDistanceM':
      return m.totalDistanceM ?? null;
    case 'totalTravelS':
      return m.totalTravelS ?? null;
    case 'maxRideS':
      return m.maxRideS ?? null;
    case 'avgRideS':
      return m.avgRideS ?? null;
    case 'avgOccupancy':
      return m.avgOccupancy ?? null;
    case 'deadlineCompliance':
      return m.deadlineCompliance?.ratio ?? null;
    case 'excluded':
      return m.excludedBookings ?? (m.excluded ? m.excluded.reduce((n, e) => n + e.bookings, 0) : null);
  }
}

const pct = (r: number) => `${Math.round(r * 100)} %`;

export function e4Text(m: RoutePlanMetricsDto, key: CompareRow['key'], t: Translate = english): string {
  const v = e4Value(m, key);
  switch (key) {
    case 'totalDistanceM':
      return formatKm(v);
    case 'totalTravelS':
    case 'maxRideS':
    case 'avgRideS':
      return formatDuration(v, t);
    case 'avgOccupancy':
      return v === null ? '—' : pct(v);
    case 'deadlineCompliance': {
      const d = m.deadlineCompliance;
      return d && d.total > 0 ? `${d.inside} / ${d.total}${d.ratio !== null ? ` (${pct(d.ratio)})` : ''}` : '—';
    }
    case 'passengersAssigned':
      return v === null ? '—' : t('{{n}} of {{total}}', { n: v, total: m.passengers });
    default:
      return v === null ? '—' : String(v);
  }
}

/** Excluded bookings by reason, as "reason: n" lines (unassigned reason texts, incl. fleet_too_small). */
export function excludedLines(m: RoutePlanMetricsDto, t: Translate = english): string[] {
  return (m.excluded ?? []).filter((e) => e.bookings > 0).map((e) => `${t(unassignedReason(e.reason))}: ${e.bookings}`);
}

/** Column indexes holding the best value of each row. */
export function e4Best(plans: readonly RoutePlanMetricsDto[]): Record<CompareRow['key'], number[]> {
  const out = {} as Record<CompareRow['key'], number[]>;
  for (const r of E4_COMPARE_ROWS) out[r.key] = bestOf(plans.map((p) => e4Value(p, r.key)), r.best);
  return out;
}

export const COMPARE_STRINGS = [...Object.values(METRIC_HELP), ...E4_COMPARE_ROWS.map((r) => r.label), '{{n}} of {{total}}'] as const;
