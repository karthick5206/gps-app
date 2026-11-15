/**
 * Passenger ride preference (doc 20 §7, pure, `node --test`): shared / private / flexible, the company sharing policy
 * the passenger accepts (its version is sent with the request) and how the ride was served. Owner defaults P1–P8. The
 * server checks the acceptance, the version and the limits (POLICY_ACCEPTANCE_REQUIRED / POLICY_VERSION_STALE …). No
 * runtime import from @veetracer/shared, so this file runs under plain `node --test`.
 */
import type { BookingPoolingInput, RidePreference, RideService, SharingLimits, TransportBookingJourney, TransportSharingPolicyDto } from '@veetracer/shared';

export const PREFERENCE_LABEL: Record<RidePreference, string> = { SHARED: 'Shared', PRIVATE: 'Private', FLEXIBLE: 'Flexible' };
export const PREFERENCE_HINT: Record<RidePreference, string> = {
  SHARED: 'You may ride with colleagues going the same way, within the limits below.',
  PRIVATE: 'Nobody else rides on your trip.',
  FLEXIBLE: 'Shared or private, whichever gets you there best.',
};
export const SERVED_LABEL: Record<RideService, string> = { SHARED: 'Shared ride', PRIVATE: 'Private ride' };

/** P3: what the server uses when nothing is chosen. */
export function defaultPreference(journey: TransportBookingJourney): RidePreference {
  return journey === 'COMMUTE' ? 'SHARED' : 'PRIVATE';
}

export function preferenceChoices(policy: Pick<TransportSharingPolicyDto, 'allowFlexible'> | null | undefined): RidePreference[] {
  return policy && !policy.allowFlexible ? ['SHARED', 'PRIVATE'] : ['SHARED', 'PRIVATE', 'FLEXIBLE'];
}

/** Shared / flexible point-to-point rides need the current policy accepted; commute rides are shared by default. */
export function needsAcceptance(pref: RidePreference, journey: TransportBookingJourney): boolean {
  return pref !== 'PRIVATE' && journey === 'POINT_TO_POINT';
}

const min = (s: number) => Math.round(s / 60);

/** The accepted limits as short lines ("Wait at most 15 min", …); none for a private ride. */
export function limitLines(limits: SharingLimits | null | undefined, companyMaxRideS: number | null | undefined): { key: string; vars: Record<string, number> }[] {
  if (!limits) return [];
  const out: { key: string; vars: Record<string, number> }[] = [
    { key: 'Wait at most {{n}} min after your pickup time', vars: { n: min(limits.maxWaitS) } },
    { key: 'Detour at most {{ratio}}× the direct ride or +{{n}} min', vars: { ratio: limits.maxDetour.ratio, n: min(limits.maxDetour.extraS) } },
  ];
  const ride = limits.maxRideS ?? companyMaxRideS ?? null;
  if (ride !== null) out.push({ key: 'Ride at most {{n}} min', vars: { n: min(ride) } });
  return out;
}

export function limitsFor(policy: Pick<TransportSharingPolicyDto, 'limits'> | null | undefined, pref: RidePreference): SharingLimits | null {
  return policy && pref !== 'PRIVATE' ? policy.limits[pref] : null;
}

/**
 * The pooling fields of POST /me/transport/requests. No policy (older server): nothing is sent. Private: just the
 * preference. Shared / flexible: the accepted version (the explicit acceptance) — refused here when it is required and
 * not given, so the passenger sees why before sending.
 */
export function poolingFields(pref: RidePreference | null, accepted: boolean, policy: TransportSharingPolicyDto | null | undefined, journey: TransportBookingJourney): { ok: true; value: BookingPoolingInput } | { ok: false; error: string } {
  if (!policy) return { ok: true, value: {} };
  const p = pref ?? defaultPreference(journey);
  if (p === 'FLEXIBLE' && !policy.allowFlexible) return { ok: false, error: 'Flexible rides are not offered. Choose shared or private.' };
  if (p === 'PRIVATE') return { ok: true, value: { ridePreference: 'PRIVATE' } };
  if (needsAcceptance(p, journey) && !accepted) return { ok: false, error: 'Read and accept the sharing policy to book a shared or flexible ride.' };
  return { ok: true, value: { ridePreference: p, ...(accepted ? { acceptedPolicyVersion: policy.version } : {}) } };
}

/** Error codes of a request with pooling, as passenger text (null = use the general text). */
export function poolingErrorText(code: string | null | undefined): string | null {
  switch (code) {
    case 'POLICY_ACCEPTANCE_REQUIRED':
      return 'Read and accept the sharing policy to book a shared or flexible ride.';
    case 'POLICY_VERSION_STALE':
      return 'The sharing policy changed. Read the new policy and accept it again.';
    case 'FLEXIBLE_NOT_ALLOWED':
      return 'Flexible rides are not offered. Choose shared or private.';
    case 'LIMITS_ABOVE_POLICY':
      return 'The limits may only be tighter than the sharing policy.';
    default:
      return null;
  }
}

/** Trip card line: how the ride is served (shared / private) once the server says so. */
export function servedText(servedAs: RideService | null | undefined): string | null {
  return servedAs ? SERVED_LABEL[servedAs] : null;
}
