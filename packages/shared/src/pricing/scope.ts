/** Component scope matching (doc 19 §3.2 PricingComponent.scope). */
import type { PricingComponentInput, PricingComponentScope } from './types';
import type { RidePreference } from '../transport-pooling';

/** The facts a scope is matched against (TripFacts / PeriodFacts both fit). */
export interface ScopeFacts {
  vehicleCategory?: string | null;
  seats?: number | null;
  branchId?: string | null;
  journey?: string | null;
  ridePreference?: RidePreference | null;
  serviceType?: string | null;
}

const set = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

/** A component applies when every set scope field matches the facts (an unknown fact never matches a set field). */
export function scopeMatches(scope: PricingComponentScope | null | undefined, f: ScopeFacts): boolean {
  if (!scope) return true;
  if (set(scope.vehicleCategory) && scope.vehicleCategory !== f.vehicleCategory) return false;
  if (set(scope.minSeats) && !(typeof f.seats === 'number' && f.seats >= scope.minSeats)) return false;
  if (set(scope.maxSeats) && !(typeof f.seats === 'number' && f.seats <= scope.maxSeats)) return false;
  if (set(scope.branchIds) && !(f.branchId && scope.branchIds.includes(f.branchId))) return false;
  if (set(scope.journey) && scope.journey !== f.journey) return false;
  if (set(scope.ridePreference) && scope.ridePreference !== f.ridePreference) return false;
  if (set(scope.serviceType) && scope.serviceType !== f.serviceType) return false;
  return true;
}

export function componentsInScope(components: readonly PricingComponentInput[], f: ScopeFacts): PricingComponentInput[] {
  return components.filter((c) => scopeMatches(c.scope, f)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** Whether two scopes can apply to the same usage (no set field in both is disjoint). */
export function scopesOverlap(a: PricingComponentScope | null | undefined, b: PricingComponentScope | null | undefined): boolean {
  if (!a || !b) return true;
  const eq = <T>(x: T | null | undefined, y: T | null | undefined) => !set(x) || !set(y) || x === y;
  if (!eq(a.vehicleCategory, b.vehicleCategory) || !eq(a.journey, b.journey) || !eq(a.ridePreference, b.ridePreference) || !eq(a.serviceType, b.serviceType)) return false;
  if (set(a.branchIds) && set(b.branchIds) && !a.branchIds.some((x) => b.branchIds!.includes(x))) return false;
  const lo = Math.max(a.minSeats ?? 0, b.minSeats ?? 0);
  const hi = Math.min(a.maxSeats ?? Number.MAX_SAFE_INTEGER, b.maxSeats ?? Number.MAX_SAFE_INTEGER);
  return lo <= hi;
}
