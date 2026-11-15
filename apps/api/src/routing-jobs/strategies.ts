import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_ROUTING_STRATEGY,
  DETOUR_GUARD_COST_PER_S,
  GROUPING_PREFERENCES,
  isMaxRideS,
  isRoutingStrategy,
  KEEP_DIRECTIONS_DETOUR,
  MAX_RIDE_BOUNDS_S,
  ROUTE_PLAN_PREFERENCE_BOUNDS,
  routePlanLocks,
  VEHICLE_SIZE_PREFERENCES,
  type RoutePlanPreferences,
  type RoutingStrategy,
  type VehicleSizePreference,
} from '@veetracer/shared';
import type { SolverWeights } from './optimize-problem';

/**
 * E4 WP-A: optimisation strategies and run preferences → solver weights and options (pure; no I/O). Evidence: doc 18 §6
 * and `evidence/2026-11-15-e4-grouping/e4-strategies-presets.json` (the prototype runs on the production road matrix).
 *
 * | Strategy           | vehicle | distance | time | routeDuration | rideTime |
 * |--------------------|---------|----------|------|---------------|----------|
 * | BALANCED (default) | 3600    | 0        | 2    | 0             | 1        |
 * | FEWER_VEHICLES     | 20000   | 0        | 1    | 0             | 0        |
 * | SHORTEST_DISTANCE  | 2000    | 1        | 0    | 0             | 0        |
 * | FASTEST            | 120     | 0        | 1    | 0             | 0        |
 * | COMFORT            | 1800    | 0        | 1    | 0             | 2        |
 *
 * A strategy only chooses objective weights: seats, wheelchair spaces, consent, company isolation, time windows, the
 * site window and the company max ride stay hard constraints whatever it is. `rideTime` (cost per passenger-second of
 * ride) is read by the solver from WP-S on; an older solver ignores the key (the other weights still apply).
 */
export const STRATEGY_WEIGHTS: Readonly<Record<RoutingStrategy, Readonly<SolverWeights>>> = {
  BALANCED: { vehicle: 3600, distance: 0, time: 2, routeDuration: 0, rideTime: 1 },
  FEWER_VEHICLES: { vehicle: 20000, distance: 0, time: 1, routeDuration: 0, rideTime: 0 },
  SHORTEST_DISTANCE: { vehicle: 2000, distance: 1, time: 0, routeDuration: 0, rideTime: 0 },
  FASTEST: { vehicle: 120, distance: 0, time: 1, routeDuration: 0, rideTime: 0 },
  COMFORT: { vehicle: 1800, distance: 0, time: 1, routeDuration: 0, rideTime: 2 },
};

export function strategyWeights(s: RoutingStrategy): SolverWeights {
  return { ...STRATEGY_WEIGHTS[s] };
}

const invalid = (message: string) => new BadRequestException({ message, code: 'VALIDATION_FAILED' });

/**
 * Preferred occupancy p (0.5–1) → vehicle weight factor 2^(4 × (p − 0.75)): 0.5 → 0.5, 0.75 → 1, 1 → 2. A higher target
 * makes another vehicle dearer, so the solver fills the ones in use first (still within seats and max ride).
 */
export function occupancyFactor(p: number): number {
  return 2 ** (4 * (p - 0.75));
}

/** Normalised, validated preferences (400 VALIDATION_FAILED on a bad value). Unknown keys are dropped. */
export function checkPreferences(raw: unknown): RoutePlanPreferences | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('preferences must be an object');
  const p = raw as Record<string, unknown>;
  const out: RoutePlanPreferences = {};
  if (p.maxRideS !== undefined) {
    if (!isMaxRideS(p.maxRideS)) throw invalid(`preferences.maxRideS must be whole seconds between ${MAX_RIDE_BOUNDS_S.min} and ${MAX_RIDE_BOUNDS_S.max}`);
    out.maxRideS = p.maxRideS;
  }
  if (p.detourGuard !== undefined) {
    const g = p.detourGuard as { ratio?: unknown; extraMin?: unknown } | null;
    const b = ROUTE_PLAN_PREFERENCE_BOUNDS;
    const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (!g || typeof g !== 'object' || !num(g.ratio, b.detourRatio.min, b.detourRatio.max) || !num(g.extraMin, b.detourExtraMin.min, b.detourExtraMin.max)) {
      throw invalid(`preferences.detourGuard needs ratio ${b.detourRatio.min}–${b.detourRatio.max} and extraMin ${b.detourExtraMin.min}–${b.detourExtraMin.max}`);
    }
    out.detourGuard = { ratio: g.ratio as number, extraMin: g.extraMin as number };
  }
  if (p.preferredOccupancy !== undefined) {
    const { min, max } = ROUTE_PLAN_PREFERENCE_BOUNDS.preferredOccupancy;
    if (typeof p.preferredOccupancy !== 'number' || !Number.isFinite(p.preferredOccupancy) || p.preferredOccupancy < min || p.preferredOccupancy > max) throw invalid(`preferences.preferredOccupancy must be ${min}–${max}`);
    out.preferredOccupancy = p.preferredOccupancy;
  }
  if (p.vehicleSize !== undefined) {
    if (!(VEHICLE_SIZE_PREFERENCES as readonly unknown[]).includes(p.vehicleSize)) throw invalid(`preferences.vehicleSize must be one of ${VEHICLE_SIZE_PREFERENCES.join(', ')}`);
    out.vehicleSize = p.vehicleSize as VehicleSizePreference;
  }
  if (p.groupingPreference !== undefined) {
    if (!(GROUPING_PREFERENCES as readonly unknown[]).includes(p.groupingPreference)) throw invalid(`preferences.groupingPreference must be one of ${GROUPING_PREFERENCES.join(', ')}`);
    out.groupingPreference = p.groupingPreference as RoutePlanPreferences['groupingPreference'];
  }
  for (const k of ['preservePins', 'preserveLocks'] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'boolean') throw invalid(`preferences.${k} must be true or false`);
    out[k] = p[k] as boolean;
  }
  return out;
}

export interface ResolvedOptimisation {
  /** The strategy named (or BALANCED when neither a strategy nor weights were given); null for raw weights alone. */
  strategy: RoutingStrategy | null;
  /** The weights sent to the solver (after the occupancy factor). */
  weights: SolverWeights;
  /** 'weights' when raw weights were given (they win over a strategy named with them, which is still recorded). */
  weightsSource: 'strategy' | 'weights';
  preferences?: RoutePlanPreferences;
}

/**
 * Strategy + raw weights + preferences → the run's weights. Raw weights (already checked) win over a strategy; with
 * neither, BALANCED. A preferred occupancy scales the vehicle weight (rounded).
 */
export function resolveOptimisation(req: { strategy?: unknown; weights?: SolverWeights; preferences?: RoutePlanPreferences }): ResolvedOptimisation {
  if (req.strategy !== undefined && req.strategy !== null && !isRoutingStrategy(req.strategy)) throw invalid('Unknown strategy');
  const named = (req.strategy ?? null) as RoutingStrategy | null;
  const base = req.weights ? { ...req.weights } : strategyWeights(named ?? DEFAULT_ROUTING_STRATEGY);
  const p = req.preferences?.preferredOccupancy;
  const weights = p === undefined ? base : { ...base, vehicle: Math.round(base.vehicle * occupancyFactor(p)) };
  return { strategy: req.weights ? named : (named ?? DEFAULT_ROUTING_STRATEGY), weights, weightsSource: req.weights ? 'weights' : 'strategy', ...(req.preferences ? { preferences: req.preferences } : {}) };
}

/**
 * Preference max ride vs the plan's effective max ride (override, else company policy): never above it (400
 * MAX_RIDE_ABOVE_POLICY). Raising the limit is only possible through `maxRideOverride` (etms_settings:edit, whole
 * company, reason, audited), which is applied first. With no policy and no override any bounded value is a tightening.
 */
export function checkPreferenceMaxRide(pref: RoutePlanPreferences | undefined, effectiveS: number | null): void {
  if (!pref?.maxRideS || effectiveS === null || pref.maxRideS <= effectiveS) return;
  throw new BadRequestException({
    message: `The preferred maximum ride (${Math.round(pref.maxRideS / 60)} min) is above the plan's maximum ride (${Math.round(effectiveS / 60)} min); only an authorised maximum-ride override can raise it`,
    code: 'MAX_RIDE_ABOVE_POLICY',
    effectiveMaxRideS: effectiveS,
  });
}

/** Stored preferences (RoutePlan.options.preferences), tolerant: an invalid value reads as none. */
export function storedPreferencesOf(options: unknown): RoutePlanPreferences | undefined {
  const o = options && typeof options === 'object' && !Array.isArray(options) ? (options as Record<string, unknown>).preferences : undefined;
  try {
    return checkPreferences(o);
  } catch {
    return undefined;
  }
}

/** Solver trip.detourGuard (WP-S contract) from the preferences; KEEP_DIRECTIONS without one = ratio 1.6, +10 min. */
export function detourGuardOf(pref: RoutePlanPreferences | undefined): { ratio: number; extraS: number; costPerS: number } | null {
  const g = pref?.detourGuard ?? (pref?.groupingPreference === 'KEEP_DIRECTIONS' ? KEEP_DIRECTIONS_DETOUR : null);
  return g ? { ratio: g.ratio, extraS: Math.round(g.extraMin * 60), costPerS: DETOUR_GUARD_COST_PER_S } : null;
}

/** The run's max ride: the plan's snapshot, tightened by the preference (never loosened). */
export function runMaxRideS(planMaxRideS: number | null, pref: RoutePlanPreferences | undefined): number | null {
  const p = pref?.maxRideS ?? null;
  if (p === null) return planMaxRideS;
  return planMaxRideS === null ? p : Math.min(planMaxRideS, p);
}

/**
 * vehicleSize → per-vehicle solver fixedCost (only vehicles with seats; others keep the default vehicle weight):
 * SMALLER = vehicle weight × seats / average seats (big vehicles dearer), LARGER = × average seats / seats (big vehicles
 * cheaper); factor clamped to 0.25–4; ANY / absent / no seats → none.
 */
export function vehicleFixedCosts(vehicles: { assignmentId: string; capacity: number | null }[], vehicleWeight: number, size: VehicleSizePreference | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!size || size === 'ANY') return out;
  const sized = vehicles.filter((v) => v.capacity !== null && v.capacity > 0);
  if (!sized.length) return out;
  const avg = sized.reduce((n, v) => n + (v.capacity as number), 0) / sized.length;
  for (const v of sized) {
    const ratio = (v.capacity as number) / avg;
    const f = Math.min(4, Math.max(0.25, size === 'SMALLER' ? ratio : 1 / ratio));
    out.set(v.assignmentId, Math.round(vehicleWeight * f));
  }
  return out;
}

/**
 * Lock / pin sets of one run: the plan's (routePlanLocks), minus pins when preservePins is false, minus locks when
 * preserveLocks is false (authorised and audited at the reservation) — but published routes always stay frozen.
 */
export function runLockSets(options: unknown, publishedAssignmentIds: Iterable<string> = []): { lockedAssignmentIds: Set<string>; pinnedStopIds: Set<string> } {
  const locks = routePlanLocks(options);
  const pref = storedPreferencesOf(options);
  const locked = pref?.preserveLocks === false ? new Set<string>() : locks.lockedAssignmentIds;
  for (const id of publishedAssignmentIds) locked.add(id);
  return { lockedAssignmentIds: locked, pinnedStopIds: pref?.preservePins === false ? new Set<string>() : locks.pinnedStopIds };
}
