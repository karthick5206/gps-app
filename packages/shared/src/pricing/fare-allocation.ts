/** On-demand fare allocation (doc 19 §5.9): private stays private; shared methods per passenger, exact sums. */
import { allocateLargestRemainder, divRound, formatMicro, minorToMicro, sumBig } from './money';
import { currencyExponent, formatMinor } from './currency';
import type { FareAllocation, FareAllocationInput, PricingIssue } from './types';

const km = (m: number) => `${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, '0')} km`;

export function allocateFare(input: FareAllocationInput): FareAllocation {
  const issues: PricingIssue[] = [];
  const cur = input.currency;
  const privateFare = (note: string): FareAllocation => {
    const amt = input.vehicleTripMinor ?? 0n;
    const first = input.passengers[0];
    const shares = first ? [{ passengerId: first.passengerId, amountMinor: amt, basis: `private ride: vehicle trip price ${formatMinor(amt, cur)}${note}` }] : [];
    return { appliedAs: 'PRIVATE', method: 'PRIVATE', shares, totalMinor: sumBig(shares.map((s) => s.amountMinor)), issues };
  };
  if (input.preference === 'PRIVATE') {
    if (input.method !== undefined && input.method !== null) {
      issues.push({ code: 'SHARED_FARE_NOT_ALLOWED', message: 'A private ride is never priced with a shared fare method' });
    }
    return privateFare('');
  }
  if (input.preference === 'FLEXIBLE' && !input.coRidersOnBoard) return privateFare(' (flexible ride delivered without co-riders)');

  const ps = input.passengers;
  const byWeight = (label: string): FareAllocation => {
    const total = input.vehicleTripMinor ?? 0n;
    const parts = allocateLargestRemainder(total, ps.map((p) => BigInt(Math.max(0, p.onboardDistanceM))));
    const sumKm = ps.reduce((s, p) => s + Math.max(0, p.onboardDistanceM), 0);
    const shares = ps.map((p, i) => ({ passengerId: p.passengerId, amountMinor: parts[i], basis: `${label}: ${km(p.onboardDistanceM)} of ${km(sumKm)} passenger-km × ${formatMinor(total, cur)}` }));
    return { appliedAs: 'SHARED', method: input.method, shares, totalMinor: total, issues };
  };
  switch (input.method) {
    case 'DISTANCE_SHARE':
      return byWeight('distance share');
    case 'CONTRACT_RULE':
      return byWeight('contract rule (distance share)');
    case 'EQUAL_SPLIT': {
      if (!input.allowEqualSplit) {
        issues.push({ code: 'EQUAL_SPLIT_NOT_ALLOWED', message: 'Equal split must be explicitly allowed by the contract' });
        return { appliedAs: 'SHARED', method: 'EQUAL_SPLIT', shares: [], totalMinor: 0n, issues };
      }
      const total = input.vehicleTripMinor ?? 0n;
      const parts = allocateLargestRemainder(total, ps.map(() => 1n));
      const shares = ps.map((p, i) => ({ passengerId: p.passengerId, amountMinor: parts[i], basis: `equal split of ${formatMinor(total, cur)} over ${ps.length}` }));
      return { appliedAs: 'SHARED', method: 'EQUAL_SPLIT', shares, totalMinor: total, issues };
    }
    case 'FIXED_PER_PASSENGER': {
      const f = input.fixedPerPassengerMinor ?? 0n;
      const shares = ps.map((p) => ({ passengerId: p.passengerId, amountMinor: f, basis: `fixed shared fare ${formatMinor(f, cur)}` }));
      return { appliedAs: 'SHARED', method: 'FIXED_PER_PASSENGER', shares, totalMinor: sumBig(shares.map((s) => s.amountMinor)), issues };
    }
    case 'OWN_FARE': {
      const rate = input.perKmRateMicro ?? 0n;
      const base = minorToMicro(input.baseFareMinor ?? 0n, cur);
      const disc = BigInt(input.sharedDiscountPpm ?? 0);
      const shares = ps.map((p) => {
        // micro × 1000 (per-km over metres) × 1e6 (discount ppm): one rounding at the end.
        const gross = base * 1000n + rate * BigInt(p.directDistanceM); // micro × 1000
        const net = gross * (1_000_000n - disc); // micro × 1000 × 1e6
        const amountMinor = divRound(net, 1_000_000_000n * 10n ** BigInt(6 - currencyExponent(cur)), input.roundingMode);
        return { passengerId: p.passengerId, amountMinor, basis: `own fare: (${formatMinor(input.baseFareMinor ?? 0n, cur)} + ${km(p.directDistanceM)} × ${formatMicro(rate)}/km) − ${formatMicro(disc * 100n, 4).replace(/\.?0+$/, '')} % shared discount` };
      });
      return { appliedAs: 'SHARED', method: 'OWN_FARE', shares, totalMinor: sumBig(shares.map((s) => s.amountMinor)), issues };
    }
  }
  return privateFare('');
}
