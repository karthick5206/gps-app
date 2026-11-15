/**
 * E4 WP-W: optimisation strategy, run preferences and alternatives → request fields (pure; no React, no path aliases,
 * so `node --test` runs it). The strategy is the primary control; explicit weights stay an "Advanced" option and win
 * when given (API rule). Preferences are optional: an untouched form sends nothing. Errors are English i18n keys.
 *
 * Max ride: a preference can only tighten the plan's limit (the authorised override, else the company policy; the API
 * answers 400 MAX_RIDE_ABOVE_POLICY above it), so a value above the limit is capped here and the screen says so.
 */
import {
  DEFAULT_ROUTING_STRATEGY,
  ROUTE_PLAN_ALTERNATIVES,
  ROUTE_PLAN_PREFERENCE_BOUNDS,
  ROUTING_STRATEGIES,
  ROUTING_STRATEGY_INFO,
  type RoutePlanAlternativesRequest,
  type RoutePlanPreferences,
  type RoutingStrategy,
  type VehicleSizePreference,
} from '@veetracer/shared';
import { parseMaxRideMinutes, minutesText } from './max-ride.ts';
import { completeWeights, emptyWeights, solverObjective, type PlannerWeights, type WeightDraft } from './planner-format.ts';

export { DEFAULT_ROUTING_STRATEGY, ROUTING_STRATEGIES, ROUTING_STRATEGY_INFO };

// ───────────────────────────── strategy + weights ─────────────────────────────

/** The strategy part of an optimise form: the strategy, and explicit weights only when "Advanced" is on. */
export interface StrategyDraft {
  strategy: RoutingStrategy;
  /** Advanced: send explicit weights (they win over the strategy on the server). */
  useWeights: boolean;
  weights: WeightDraft;
}

export const defaultStrategyDraft = (): StrategyDraft => ({ strategy: DEFAULT_ROUTING_STRATEGY, useWeights: false, weights: emptyWeights() });

/** Re-optimise starts from the plan's last run: its strategy, or its raw weights (Advanced on) when no strategy gave them. */
export function strategyDraftOf(plan: { strategy?: RoutingStrategy | null; weights?: PlannerWeights | null }): StrategyDraft {
  if (plan.strategy) return { strategy: plan.strategy, useWeights: false, weights: plan.weights ? { ...pickWeights(plan.weights) } : emptyWeights() };
  if (plan.weights) return { strategy: DEFAULT_ROUTING_STRATEGY, useWeights: true, weights: pickWeights(plan.weights) };
  return defaultStrategyDraft();
}

const pickWeights = (w: PlannerWeights): WeightDraft => ({ vehicle: w.vehicle, distance: w.distance, time: w.time, routeDuration: w.routeDuration });

export type RunFields = { strategy: RoutingStrategy; weights?: PlannerWeights; objective?: 'distance' | 'duration' };

/** Body fields of the strategy part: always the strategy; the weights (and their objective) only from Advanced. */
export function runFields(d: StrategyDraft): { ok: true; value: RunFields } | { ok: false; errors: string[] } {
  if (!d.useWeights) return { ok: true, value: { strategy: d.strategy } };
  const w = completeWeights(d.weights);
  if (!w) return { ok: false, errors: ['Set all four weights (at least one of distance, driving or route length above 0).'] };
  return { ok: true, value: { strategy: d.strategy, weights: w, objective: solverObjective(w) } };
}

// ───────────────────────────── preferences ─────────────────────────────

export const OCCUPANCY_CHOICES = ['none', '0.5', '0.75', '0.9', '1'] as const;
export type OccupancyChoice = (typeof OCCUPANCY_CHOICES)[number];

export interface PreferencesDraft {
  /** Minutes ('' = the plan's limit). */
  maxRideMinutes: string;
  detourOn: boolean;
  detourRatio: string;
  detourExtraMin: string;
  occupancy: OccupancyChoice;
  vehicleSize: VehicleSizePreference;
  keepDirections: boolean;
  preservePins: boolean;
  preserveLocks: boolean;
}

export const defaultPreferencesDraft = (): PreferencesDraft => ({
  maxRideMinutes: '',
  detourOn: false,
  detourRatio: '1.6',
  detourExtraMin: '10',
  occupancy: 'none',
  vehicleSize: 'ANY',
  keepDirections: false,
  preservePins: true,
  preserveLocks: true,
});

/** The form from the preferences stored with the plan's last optimisation. */
export function preferencesDraftOf(p: RoutePlanPreferences | null | undefined): PreferencesDraft {
  const d = defaultPreferencesDraft();
  if (!p) return d;
  const occ = OCCUPANCY_CHOICES.find((c) => c !== 'none' && Number(c) === p.preferredOccupancy) ?? 'none';
  return {
    ...d,
    maxRideMinutes: minutesText(p.maxRideS),
    detourOn: !!p.detourGuard,
    detourRatio: p.detourGuard ? String(p.detourGuard.ratio) : d.detourRatio,
    detourExtraMin: p.detourGuard ? String(p.detourGuard.extraMin) : d.detourExtraMin,
    occupancy: occ,
    vehicleSize: p.vehicleSize ?? 'ANY',
    keepDirections: p.groupingPreference === 'KEEP_DIRECTIONS',
  };
}

/** The max ride a preference may not exceed: the plan's override, else the company policy (null = no limit). */
export function maxRideCapS(policyS: number | null | undefined, overrideS: number | null | undefined): number | null {
  if (typeof overrideS === 'number' && overrideS > 0) return overrideS;
  return typeof policyS === 'number' && policyS > 0 ? policyS : null;
}

export interface PreferencesOptions {
  /** See maxRideCapS. */
  capS: number | null;
  /** Pins / locks only matter on a saved plan (re-optimise); new plans have none. */
  preserve: boolean;
  /** preserveLocks=false needs etms_planning:edit (API 403 otherwise); hidden and never sent without it. */
  canEditLocks: boolean;
}

export type PreferencesResult = { ok: true; value: RoutePlanPreferences | undefined; capped: boolean } | { ok: false; errors: string[] };

const num = (s: string): number | null => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** The `preferences` request field (undefined when nothing differs from the defaults). */
export function preferencesRequest(d: PreferencesDraft, o: PreferencesOptions): PreferencesResult {
  const errors: string[] = [];
  const out: RoutePlanPreferences = {};
  let capped = false;
  const ride = parseMaxRideMinutes(d.maxRideMinutes);
  if (!ride.ok) errors.push('Enter the maximum ride time in minutes (15–240).');
  else if (ride.seconds !== null) {
    if (o.capS !== null && ride.seconds > o.capS) {
      out.maxRideS = o.capS;
      capped = true;
    } else out.maxRideS = ride.seconds;
  }
  if (d.detourOn) {
    const B = ROUTE_PLAN_PREFERENCE_BOUNDS;
    const ratio = num(d.detourRatio);
    const extra = num(d.detourExtraMin);
    if (ratio === null || ratio < B.detourRatio.min || ratio > B.detourRatio.max) errors.push('Detour ratio must be between 1.2 and 3.');
    if (extra === null || !Number.isInteger(extra) || extra < B.detourExtraMin.min || extra > B.detourExtraMin.max) errors.push('Extra detour minutes must be a whole number from 0 to 60.');
    if (ratio !== null && extra !== null) out.detourGuard = { ratio, extraMin: extra };
  }
  if (d.occupancy !== 'none') out.preferredOccupancy = Number(d.occupancy);
  if (d.vehicleSize !== 'ANY') out.vehicleSize = d.vehicleSize;
  if (d.keepDirections) out.groupingPreference = 'KEEP_DIRECTIONS';
  if (o.preserve && !d.preservePins) out.preservePins = false;
  if (o.preserve && o.canEditLocks && !d.preserveLocks) out.preserveLocks = false;
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: Object.keys(out).length ? out : undefined, capped };
}

// ───────────────────────────── alternatives ─────────────────────────────

/** Toggle one strategy in the alternatives choice (kept in the shared order, at most ROUTE_PLAN_ALTERNATIVES.max). */
export function toggleStrategy(list: readonly RoutingStrategy[], s: RoutingStrategy, on: boolean): RoutingStrategy[] {
  const set = new Set(list);
  if (on) {
    if (set.size >= ROUTE_PLAN_ALTERNATIVES.max) return [...list];
    set.add(s);
  } else set.delete(s);
  return ROUTING_STRATEGIES.filter((x) => set.has(x));
}

export function alternativesError(list: readonly RoutingStrategy[]): string | null {
  return list.length < ROUTE_PLAN_ALTERNATIVES.min || list.length > ROUTE_PLAN_ALTERNATIVES.max ? 'Choose 2 to 5 strategies for alternatives.' : null;
}

/** POST /route-plans/:id/alternatives body (AlternativesDto). */
export function alternativesBody(plan: { version: number }, input: { strategies: readonly RoutingStrategy[]; timeLimitS?: number; preferences?: RoutePlanPreferences }): RoutePlanAlternativesRequest {
  return {
    strategies: [...input.strategies],
    expectedVersion: plan.version,
    ...(input.timeLimitS ? { timeLimitS: input.timeLimitS } : {}),
    ...(input.preferences ? { preferences: { ...input.preferences } } : {}),
  };
}

/** Every text of the strategy / preferences / alternatives controls (checked for hi / ta in plan-workspace.test.ts). */
export const STRATEGY_STRINGS = [
  ...ROUTING_STRATEGIES.flatMap((s) => [ROUTING_STRATEGY_INFO[s].label, ROUTING_STRATEGY_INFO[s].summary, ROUTING_STRATEGY_INFO[s].tradeOffs]),
  'Set all four weights (at least one of distance, driving or route length above 0).',
  'Detour ratio must be between 1.2 and 3.',
  'Extra detour minutes must be a whole number from 0 to 60.',
  'Choose 2 to 5 strategies for alternatives.',
] as const;
