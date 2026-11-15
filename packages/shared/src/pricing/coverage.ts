/** Hybrid contracts: no double charge (doc 19 §5.5 coverage matrix). */
import { componentsInScope, scopesOverlap } from './scope';
import type { PricingComponentInput, PricingComponentKind, PricingIssue, PricingPolicies, TripFacts } from './types';

export const TRIP_BASE_KINDS: readonly PricingComponentKind[] = ['BASE_FARE', 'PER_KM', 'SLAB_KM', 'FIXED_TRIP', 'HOURLY'];

const coversOf = (c: PricingComponentInput) => c.covers ?? [];

/**
 * INCLUDED_KM / INCLUDED_HOURS / EXCESS_KM / EXCESS_HOUR belong to the availability period when the version has an
 * availability fee, unless their params say `perTrip: true`; without an availability fee they are per trip.
 */
export function isPerTrip(c: PricingComponentInput): boolean {
  return (c.params as { perTrip?: unknown } | null)?.perTrip === true;
}

export function isTripCovered(components: readonly PricingComponentInput[], policies: PricingPolicies | null | undefined, facts: TripFacts): { covered: boolean; basis: string } {
  if (!facts.onDedicatedVehicle) return { covered: false, basis: 'not on a dedicated vehicle' };
  const fees = componentsInScope(components, facts).filter((c) => c.kind === 'AVAILABILITY_FEE');
  if (!fees.length) return { covered: false, basis: 'no availability fee applies' };
  if (fees.some((f) => coversOf(f).includes('TRIPS'))) return { covered: true, basis: 'covered by availability contract (fee covers trips)' };
  if (policies?.alsoChargeTrips) return { covered: false, basis: 'explicit hybrid: trips are also charged per trip' };
  return { covered: true, basis: 'covered by availability contract (vehicle time)' };
}

export function findDoubleCharges(components: readonly PricingComponentInput[], policies: PricingPolicies | null | undefined): PricingIssue[] {
  const issues: PricingIssue[] = [];
  const fees = components.filter((c) => c.kind === 'AVAILABILITY_FEE');
  const tripFees = fees.filter((f) => coversOf(f).includes('TRIPS'));
  if (tripFees.length && policies?.alsoChargeTrips) {
    issues.push({ code: 'DOUBLE_CHARGE', message: 'alsoChargeTrips contradicts an availability fee that covers trips' });
  }
  for (const fee of tripFees) {
    const clash = components.find((c) => TRIP_BASE_KINDS.includes(c.kind) && scopesOverlap(c.scope, fee.scope));
    if (clash && !policies?.alsoChargeTrips) {
      issues.push({ code: 'DOUBLE_CHARGE', message: `The availability fee covers trips, so ${clash.kind} in the same scope would charge the same trips twice` });
    }
  }
  for (const fee of fees.filter((f) => coversOf(f).includes('KM_INCLUDED'))) {
    const clash = components.find((c) => (c.kind === 'EXCESS_KM' || c.kind === 'INCLUDED_KM') && isPerTrip(c) && scopesOverlap(c.scope, fee.scope));
    if (clash) issues.push({ code: 'DOUBLE_CHARGE', message: `Per-trip ${clash.kind} overlaps the availability fee's included km: excess is billed once, at period close` });
  }
  return issues;
}
