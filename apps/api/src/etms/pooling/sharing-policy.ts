import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_RIDE_PRIORITY,
  DEFAULT_SHARING_LIMITS,
  RIDE_PREFERENCES,
  transportSettingsOf,
  type BookingPoolingInput,
  type RidePreference,
  type SharingLimits,
  type TransportSharingPolicyDto,
} from '@veetracer/shared';
import { conflict } from '../dispatch/e3-common';
import { defaultPreference, limitsSnapshot, LimitsError, needsAcceptance, validateLimits } from './pooling-rules';

type Db = Pick<Prisma.TransactionClient, 'transportSharingPolicy' | 'company'>;

/** The built-in policy (version 0) every company has until it saves its own (P2 defaults). */
export const DEFAULT_POLICY_TEXT =
  'Shared rides: other passengers may ride with you and the vehicle may stop for them on the way. Your pickup is within the maximum wait after your requested time, and your ride is never longer than the agreed detour or maximum ride time. Private rides are never shared.';

export interface PolicyRow {
  id: string | null;
  dto: TransportSharingPolicyDto;
}

function priorityOf(json: unknown): Record<RidePreference, number> {
  const out = { ...DEFAULT_RIDE_PRIORITY };
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const k of RIDE_PREFERENCES) {
      const v = (json as Record<string, unknown>)[k];
      if (typeof v === 'number' && v > 0 && v <= 100) out[k] = v;
    }
  }
  return out;
}

function limitsPair(json: unknown): { SHARED: SharingLimits; FLEXIBLE: SharingLimits } {
  const j = (json && typeof json === 'object' ? json : {}) as { SHARED?: SharingLimits; FLEXIBLE?: SharingLimits };
  const one = (v: SharingLimits | undefined) => {
    try {
      return v ? validateLimits(v) : { ...DEFAULT_SHARING_LIMITS };
    } catch {
      return { ...DEFAULT_SHARING_LIMITS };
    }
  };
  return { SHARED: one(j.SHARED), FLEXIBLE: one(j.FLEXIBLE ?? j.SHARED) };
}

/** The company's current sharing policy: its latest saved version, else the built-in version 0. */
export async function currentPolicy(db: Db, companyId: string): Promise<PolicyRow> {
  const [row, company] = await Promise.all([
    db.transportSharingPolicy.findFirst({ where: { companyId }, orderBy: { version: 'desc' } }),
    db.company.findUnique({ where: { id: companyId }, select: { settings: true } }),
  ]);
  const companyMaxRideS = transportSettingsOf(company?.settings).maxRideS ?? null;
  if (!row) {
    return {
      id: null,
      dto: { version: 0, effectiveFrom: null, text: DEFAULT_POLICY_TEXT, allowFlexible: true, limits: { SHARED: { ...DEFAULT_SHARING_LIMITS }, FLEXIBLE: { ...DEFAULT_SHARING_LIMITS } }, companyMaxRideS, priority: { ...DEFAULT_RIDE_PRIORITY } },
    };
  }
  return {
    id: row.id,
    dto: { version: row.version, effectiveFrom: row.effectiveFrom.toISOString(), text: row.text, allowFlexible: row.allowFlexible, limits: limitsPair(row.limits), companyMaxRideS, priority: priorityOf(row.priority) },
  };
}

export interface ResolvedPooling {
  ridePreference: RidePreference;
  sharingPolicyId: string | null;
  sharingPolicyVersion: number | null;
  limits: SharingLimits;
}

/**
 * Pooling fields of a new booking (doc 20 §3.1): the preference (default by journey, P3), the policy acceptance
 * (SHARED / FLEXIBLE point-to-point rides must name the CURRENT version: 409 POLICY_ACCEPTANCE_REQUIRED /
 * POLICY_VERSION_STALE), FLEXIBLE only when the policy offers it, and the immutable limits snapshot (requested limits
 * may only tighten the policy: 400 LIMITS_ABOVE_POLICY).
 */
export async function resolvePooling(db: Db, companyId: string, journey: 'COMMUTE' | 'POINT_TO_POINT', input: BookingPoolingInput): Promise<ResolvedPooling> {
  const pref = input.ridePreference ?? defaultPreference(journey);
  const policy = await currentPolicy(db, companyId);
  if (pref === 'FLEXIBLE' && !policy.dto.allowFlexible) throw conflict('FLEXIBLE_NOT_ALLOWED', 'Flexible rides are not offered; choose shared or private');
  const accepting = input.acceptedPolicyVersion !== undefined && input.acceptedPolicyVersion !== null;
  if (needsAcceptance(pref, journey)) {
    if (!accepting) throw conflict('POLICY_ACCEPTANCE_REQUIRED', 'Accept the sharing policy to book a shared or flexible ride', { version: policy.dto.version });
  }
  if (accepting && input.acceptedPolicyVersion !== policy.dto.version) throw conflict('POLICY_VERSION_STALE', 'The sharing policy changed; read and accept the current version', { version: policy.dto.version });
  let limits: SharingLimits;
  try {
    limits = limitsSnapshot(pref, policy.dto.limits, input.limits, policy.dto.companyMaxRideS);
  } catch (e) {
    if (e instanceof LimitsError) throw new BadRequestException({ message: e.message, code: e.code === 'LIMITS_ABOVE_POLICY' ? 'LIMITS_ABOVE_POLICY' : 'VALIDATION_FAILED' });
    throw e;
  }
  const accepted = accepting || needsAcceptance(pref, journey);
  return { ridePreference: pref, sharingPolicyId: accepted ? policy.id : null, sharingPolicyVersion: accepted ? policy.dto.version : null, limits };
}
