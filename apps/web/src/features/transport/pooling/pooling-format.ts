/**
 * On-demand pooling (doc 20 §7, pure, `node --test`): ride preference + sharing limits form mapping for the booking
 * dialogs, the dispatcher hold, and the settings / vehicle-availability form mapping. Mirrors the contract in
 * packages/shared/src/transport-pooling.ts so mistakes show inline; the server stays the judge of every rule
 * (POLICY_ACCEPTANCE_REQUIRED, LIMITS_ABOVE_POLICY, …). Owner defaults P1–P8 apply. No React, DOM or path aliases.
 */
import {
  BOOKING_HOLD_REASON_MAX,
  DEFAULT_POOLING_SETTINGS,
  SHARING_LIMIT_BOUNDS,
  SHARING_POLICY_TEXT_MAX,
  VEHICLE_AVAILABILITY_LIMITS,
  type BookingPoolingInput,
  type DriverHoursPolicy,
  type LiveDispatchPolicy,
  type PoolingSettingsDto,
  type PutVehicleAvailabilityInput,
  type RidePreference,
  type SharingLimits,
  type TransportBookingDto,
  type TransportBookingJourney,
  type TransportBookingStatus,
  type TransportSharingPolicyDto,
  type UpdatePoolingSettingsInput,
  type UpdateTransportSharingPolicyInput,
  type VehicleAvailabilityDto,
  type VehicleAvailabilityKind,
} from '@veetracer/shared';

export type Translate = (key: string, vars?: Record<string, unknown>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars?.[k] ?? ''));

// ───────────────────────────── Ride preference ─────────────────────────────

export const RIDE_PREFERENCE_LABEL: Record<RidePreference, string> = { SHARED: 'Shared', PRIVATE: 'Private', FLEXIBLE: 'Flexible' };
export const RIDE_PREFERENCE_HINT: Record<RidePreference, string> = {
  SHARED: 'Pooled with other passengers within the sharing limits.',
  PRIVATE: 'Nobody else rides on this trip.',
  FLEXIBLE: 'Shared or private, whichever serves the ride best.',
};
export const RIDE_SERVICE_LABEL: Record<'SHARED' | 'PRIVATE', string> = { SHARED: 'Shared ride', PRIVATE: 'Private ride' };

/** P3: the server default when no preference is sent (commute rides are pooled by definition). */
export function defaultPreference(journey: TransportBookingJourney): RidePreference {
  return journey === 'COMMUTE' ? 'SHARED' : 'PRIVATE';
}

/** The preferences the company offers (FLEXIBLE only when the policy allows it). */
export function preferenceChoices(policy: Pick<TransportSharingPolicyDto, 'allowFlexible'> | null | undefined): RidePreference[] {
  return policy && !policy.allowFlexible ? ['SHARED', 'PRIVATE'] : ['SHARED', 'PRIVATE', 'FLEXIBLE'];
}

/** SHARED / FLEXIBLE point-to-point rides need the current policy accepted (commute rides are SHARED without it). */
export function needsAcceptance(pref: RidePreference, journey: TransportBookingJourney): boolean {
  return pref !== 'PRIVATE' && journey === 'POINT_TO_POINT';
}

/** The limits a preference gets from the policy (PRIVATE: none, the ride is not pooled). */
export function policyLimits(policy: Pick<TransportSharingPolicyDto, 'limits'> | null | undefined, pref: RidePreference): SharingLimits | null {
  if (!policy || pref === 'PRIVATE') return null;
  return policy.limits[pref];
}

const minText = (s: number) => `${Math.round(s / 60)}`;

/** One line per limit, e.g. "Max wait 15 min", "Max detour 1.8× or +15 min", "Max ride 60 min". */
export function limitsLines(limits: SharingLimits | null | undefined, companyMaxRideS: number | null | undefined, t: Translate = english): string[] {
  if (!limits) return [];
  const out = [t('Max wait {{n}} min', { n: minText(limits.maxWaitS) }), t('Max detour {{ratio}}× or +{{n}} min', { ratio: limits.maxDetour.ratio, n: minText(limits.maxDetour.extraS) })];
  const ride = limits.maxRideS ?? companyMaxRideS ?? null;
  out.push(ride !== null ? t('Max ride {{n}} min', { n: minText(ride) }) : t('No maximum ride time'));
  return out;
}

/** The booking-dialog part of the form: preference (null = server default), acceptance and optional tighter limits. */
export interface PreferenceDraft {
  preference: RidePreference | null;
  accepted: boolean;
  /** Optional tighter limits in minutes ('' = the policy's). */
  maxWaitMin: string;
  maxRideMin: string;
}

export const emptyPreferenceDraft = (): PreferenceDraft => ({ preference: null, accepted: false, maxWaitMin: '', maxRideMin: '' });

export type PreferenceResult = { ok: true; value: BookingPoolingInput } | { ok: false; error: string };

const wholeMinutes = (v: string): number | null | 'bad' => {
  const s = v.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'bad';
  return Number(s);
};

/**
 * The pooling fields of a create request. No policy loaded (older server / still loading) or no preference chosen:
 * nothing is sent and the server applies its default. SHARED / FLEXIBLE send the accepted policy version when ticked
 * (required for point-to-point rides); tighter limits must lie within the policy and the shared bounds.
 */
export function poolingInput(d: PreferenceDraft, policy: TransportSharingPolicyDto | null | undefined, journey: TransportBookingJourney): PreferenceResult {
  if (!policy || !d.preference) return { ok: true, value: {} };
  const pref = d.preference;
  if (pref === 'FLEXIBLE' && !policy.allowFlexible) return { ok: false, error: 'Flexible rides are not offered; choose shared or private.' };
  if (pref === 'PRIVATE') return { ok: true, value: { ridePreference: 'PRIVATE' } };
  if (needsAcceptance(pref, journey) && !d.accepted) return { ok: false, error: 'Accept the sharing policy to book a shared or flexible ride.' };
  const base = policy.limits[pref];
  const value: BookingPoolingInput = { ridePreference: pref, ...(d.accepted ? { acceptedPolicyVersion: policy.version } : {}) };
  const wait = wholeMinutes(d.maxWaitMin);
  const ride = wholeMinutes(d.maxRideMin);
  if (wait === 'bad' || ride === 'bad') return { ok: false, error: 'Limits are whole minutes.' };
  const limits: NonNullable<BookingPoolingInput['limits']> = {};
  if (wait !== null) {
    const s = wait * 60;
    if (s > base.maxWaitS || s < SHARING_LIMIT_BOUNDS.maxWaitS.min) return { ok: false, error: 'The maximum wait may only be shorter than the policy’s.' };
    limits.maxWaitS = s;
  }
  if (ride !== null) {
    const s = ride * 60;
    const cap = base.maxRideS ?? policy.companyMaxRideS ?? SHARING_LIMIT_BOUNDS.maxRideS.max;
    if (s > cap || s < SHARING_LIMIT_BOUNDS.maxRideS.min) return { ok: false, error: 'The maximum ride may only be shorter than the policy’s (at least 5 minutes).' };
    limits.maxRideS = s;
  }
  if (Object.keys(limits).length) value.limits = limits;
  return { ok: true, value };
}

/** Pooling error codes of a booking create, as user text (the server message otherwise). */
export const POOLING_ERROR_TEXT: Record<string, string> = {
  POLICY_ACCEPTANCE_REQUIRED: 'Accept the sharing policy to book a shared or flexible ride.',
  POLICY_VERSION_STALE: 'The sharing policy changed. Read the current policy and accept it again.',
  FLEXIBLE_NOT_ALLOWED: 'Flexible rides are not offered; choose shared or private.',
  LIMITS_ABOVE_POLICY: 'The limits may only be tighter than the sharing policy.',
  LIMITS_IMMUTABLE: 'The ride preference and limits cannot change once accepted.',
  BOOKING_ON_HOLD: 'The booking is on hold. Release the hold first.',
  PRIVATE_RIDE_NOT_EXCLUSIVE: 'A private ride cannot share its trip.',
  VEHICLE_UNAVAILABLE: 'The vehicle is not available then (downtime, reserved or outside its operating hours).',
  VEHICLE_TURNAROUND: 'Not enough turnaround time between two trips of this vehicle.',
  DRIVER_HOURS: 'The driver’s working-hour policy would be broken.',
  COMMITMENT_VIOLATION: 'The change would break a committed pickup window or accepted limit.',
  LIVE_DISPATCH_DISABLED: 'Live dispatch is switched off.',
  NO_FEASIBLE_OPTION: 'No vehicle can take this booking within its limits.',
};

// ───────────────────────────── Hold ─────────────────────────────

const HOLDABLE: readonly TransportBookingStatus[] = ['REQUESTED', 'PENDING_ASSIGNMENT', 'WAITLISTED'];

/** Only an unseated booking can be held (409 INVALID_STATE otherwise). */
export function canHold(b: Pick<TransportBookingDto, 'status' | 'holdFromPlanning'>): boolean {
  return !b.holdFromPlanning && HOLDABLE.includes(b.status);
}

export function canRelease(b: Pick<TransportBookingDto, 'holdFromPlanning'>): boolean {
  return b.holdFromPlanning === true;
}

export function holdInput(b: Pick<TransportBookingDto, 'version'>, hold: boolean, reason?: string): { ok: true; value: { hold: boolean; reason?: string; expectedVersion: number } } | { ok: false; error: string } {
  const r = (reason ?? '').trim();
  if (hold && !r) return { ok: false, error: 'A reason is required.' };
  if (r.length > BOOKING_HOLD_REASON_MAX) return { ok: false, error: 'The reason is too long.' };
  return { ok: true, value: { hold, ...(hold ? { reason: r } : {}), expectedVersion: b.version } };
}

// ───────────────────────────── Sharing policy settings ─────────────────────────────

export interface LimitsDraft {
  maxWaitMin: string;
  ratio: string;
  extraMin: string;
  /** '' = no own limit (the company max ride applies). */
  maxRideMin: string;
}

export interface PolicyDraft {
  text: string;
  allowFlexible: boolean;
  SHARED: LimitsDraft;
  FLEXIBLE: LimitsDraft;
  priority: Record<RidePreference, string>;
}

const limitsDraftOf = (l: SharingLimits): LimitsDraft => ({ maxWaitMin: minText(l.maxWaitS), ratio: String(l.maxDetour.ratio), extraMin: minText(l.maxDetour.extraS), maxRideMin: l.maxRideS === null ? '' : minText(l.maxRideS) });

export function policyDraftOf(p: TransportSharingPolicyDto): PolicyDraft {
  return {
    text: p.text,
    allowFlexible: p.allowFlexible,
    SHARED: limitsDraftOf(p.limits.SHARED),
    FLEXIBLE: limitsDraftOf(p.limits.FLEXIBLE),
    priority: { PRIVATE: String(p.priority.PRIVATE), FLEXIBLE: String(p.priority.FLEXIBLE), SHARED: String(p.priority.SHARED) },
  };
}

const num = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v.trim()));

function limitsOf(d: LimitsDraft, label: string, errors: string[], t: Translate): SharingLimits | null {
  const B = SHARING_LIMIT_BOUNDS;
  const wait = num(d.maxWaitMin) * 60;
  const ratio = num(d.ratio);
  const extra = num(d.extraMin) * 60;
  const ride = d.maxRideMin.trim() === '' ? null : num(d.maxRideMin) * 60;
  const before = errors.length;
  if (!Number.isInteger(wait) || wait < B.maxWaitS.min || wait > B.maxWaitS.max) errors.push(t('{{what}}: max wait 0–{{n}} minutes.', { what: t(label), n: B.maxWaitS.max / 60 }));
  if (!Number.isFinite(ratio) || ratio < B.ratio.min || ratio > B.ratio.max) errors.push(t('{{what}}: detour ratio {{min}}–{{max}}.', { what: t(label), min: B.ratio.min, max: B.ratio.max }));
  if (!Number.isInteger(extra) || extra < B.extraS.min || extra > B.extraS.max) errors.push(t('{{what}}: extra detour 0–{{n}} minutes.', { what: t(label), n: B.extraS.max / 60 }));
  if (ride !== null && (!Number.isInteger(ride) || ride < B.maxRideS.min || ride > B.maxRideS.max)) errors.push(t('{{what}}: max ride {{min}}–{{max}} minutes, or empty.', { what: t(label), min: B.maxRideS.min / 60, max: B.maxRideS.max / 60 }));
  if (errors.length > before) return null;
  return { maxWaitS: wait, maxDetour: { ratio, extraS: extra }, maxRideS: ride };
}

/** PUT /transport/sharing-policy body (a new version) or the problems to show. */
export function policyInputOf(d: PolicyDraft, t: Translate = english): { ok: true; value: UpdateTransportSharingPolicyInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const text = d.text.trim();
  if (!text) errors.push(t('The policy text is required.'));
  if (text.length > SHARING_POLICY_TEXT_MAX) errors.push(t('The policy text is at most {{n}} characters.', { n: SHARING_POLICY_TEXT_MAX }));
  const shared = limitsOf(d.SHARED, 'Shared', errors, t);
  const flexible = limitsOf(d.FLEXIBLE, 'Flexible', errors, t);
  const priority: Partial<Record<RidePreference, number>> = {};
  for (const k of ['PRIVATE', 'FLEXIBLE', 'SHARED'] as const) {
    const v = num(d.priority[k]);
    if (!Number.isFinite(v) || v <= 0 || v > 10) errors.push(t('Priority {{what}}: a number above 0, at most 10.', { what: t(RIDE_PREFERENCE_LABEL[k]) }));
    else priority[k] = v;
  }
  if (errors.length || !shared || !flexible) return { ok: false, errors };
  return { ok: true, value: { text, allowFlexible: d.allowFlexible, limits: { SHARED: shared, FLEXIBLE: flexible }, priority } };
}

// ───────────────────────────── Pooling settings + driver hours ─────────────────────────────

/** off-server = ETMS_LIVE_DISPATCH=off (wins); off = the company switch (default OFF); on. */
export type LiveSwitch = 'on' | 'off' | 'off-server';

export function liveSwitch(s: Pick<PoolingSettingsDto, 'liveDispatch' | 'killSwitch'> | null | undefined): LiveSwitch {
  if (!s) return 'off';
  if (s.killSwitch) return 'off-server';
  return s.liveDispatch ? 'on' : 'off';
}

export interface PoolingSettingsDraft {
  liveDispatch: boolean;
  scheduledPolicy: LiveDispatchPolicy;
  delayPolicy: LiveDispatchPolicy;
  delayThresholdMin: string;
}

export function poolingDraftOf(s: PoolingSettingsDto | null | undefined): PoolingSettingsDraft {
  const v = s ?? { ...DEFAULT_POOLING_SETTINGS, killSwitch: false };
  return { liveDispatch: v.liveDispatch, scheduledPolicy: v.scheduledPolicy, delayPolicy: v.delayPolicy, delayThresholdMin: minText(v.delayThresholdS) };
}

export function poolingInputOf(d: PoolingSettingsDraft): { ok: true; value: UpdatePoolingSettingsInput } | { ok: false; error: string } {
  const m = num(d.delayThresholdMin);
  if (!Number.isInteger(m) || m < 1 || m > 240) return { ok: false, error: 'Delay threshold: 1–240 minutes.' };
  return { ok: true, value: { liveDispatch: d.liveDispatch, scheduledPolicy: d.scheduledPolicy, delayPolicy: d.delayPolicy, delayThresholdS: m * 60 } };
}

export type DriverHoursKey = keyof DriverHoursPolicy;
export const DRIVER_HOURS_FIELDS: { key: DriverHoursKey; label: string; hint: string }[] = [
  { key: 'maxDutyS', label: 'Longest duty (hours)', hint: 'First trip start to last trip end.' },
  { key: 'maxDrivingS', label: 'Most driving per duty (hours)', hint: 'Sum of planned trip durations.' },
  { key: 'breakAfterS', label: 'Break after driving (hours)', hint: 'Continuous driving before a break.' },
  { key: 'breakS', label: 'Break length (minutes)', hint: 'Needed with “Break after driving”.' },
  { key: 'minRestS', label: 'Rest between duties (hours)', hint: 'A gap this long starts a new duty.' },
];
/** Entered in minutes (breakS) or hours (the rest). */
const unitOf = (k: DriverHoursKey) => (k === 'breakS' ? 60 : 3600);

export type DriverHoursDraft = Record<DriverHoursKey, string>;

export function driverHoursDraftOf(p: DriverHoursPolicy | null | undefined): DriverHoursDraft {
  const out = {} as DriverHoursDraft;
  for (const { key } of DRIVER_HOURS_FIELDS) {
    const v = p?.[key] ?? null;
    out[key] = v === null ? '' : String(Math.round((v / unitOf(key)) * 100) / 100);
  }
  return out;
}

/** P7: every field empty = no policy (null). Values in hours (break length in minutes). */
export function driverHoursInputOf(d: DriverHoursDraft, t: Translate = english): { ok: true; value: DriverHoursPolicy | null } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out = {} as DriverHoursPolicy;
  let any = false;
  for (const { key, label } of DRIVER_HOURS_FIELDS) {
    const raw = d[key].trim();
    if (!raw) {
      out[key] = null;
      continue;
    }
    const v = Number(raw);
    const s = Math.round(v * unitOf(key));
    if (!Number.isFinite(v) || v <= 0 || s > 24 * 3600) {
      errors.push(t('{{what}}: a positive number up to 24 hours.', { what: t(label) }));
      continue;
    }
    out[key] = s;
    any = true;
  }
  if ((out.breakAfterS === null) !== (out.breakS === null) && !errors.length) errors.push(t('Set both “Break after driving” and “Break length”, or neither.'));
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: any ? out : null };
}

// ───────────────────────────── Vehicle availability ─────────────────────────────

export const AVAILABILITY_KIND_LABEL: Record<VehicleAvailabilityKind, string> = { OPERATING: 'Operating window', DOWNTIME: 'Downtime', RESERVED: 'Reserved' };

/** One editable window; times are wall times "YYYY-MM-DDTHH:mm" in the company zone. */
export interface AvailabilityRow {
  key: string;
  kind: VehicleAvailabilityKind;
  start: string;
  end: string;
  reason: string;
}

export interface AvailabilityDraft {
  /** '' = not set (planners use the 2-minute default; not enforced at publish). */
  turnaroundMin: string;
  rows: AvailabilityRow[];
}

/** Rows ending after `nowMs` (the ones a PUT replaces); past windows are history and stay on the server. */
export function availabilityDraftOf(dto: VehicleAvailabilityDto, nowMs: number, toWall: (ms: number) => string): AvailabilityDraft {
  return {
    turnaroundMin: dto.turnaroundS === null ? '' : String(Math.round((dto.turnaroundS / 60) * 10) / 10),
    rows: dto.windows.filter((w) => Date.parse(w.endsAt) > nowMs).map((w) => ({ key: w.id, kind: w.kind, start: toWall(Date.parse(w.startsAt)), end: toWall(Date.parse(w.endsAt)), reason: w.reason ?? '' })),
  };
}

export function availabilityInputOf(d: AvailabilityDraft, fromWall: (wall: string) => number, nowIso: string, t: Translate = english): { ok: true; value: PutVehicleAvailabilityInput } | { ok: false; errors: string[] } {
  const L = VEHICLE_AVAILABILITY_LIMITS;
  const errors: string[] = [];
  let turnaroundS: number | null = null;
  if (d.turnaroundMin.trim()) {
    const m = Number(d.turnaroundMin.trim());
    if (!Number.isFinite(m) || m < 0 || m * 60 > L.turnaroundMaxS) errors.push(t('Turnaround: 0–{{n}} minutes, or empty.', { n: L.turnaroundMaxS / 60 }));
    else turnaroundS = Math.round(m * 60);
  }
  if (d.rows.length > L.maxWindows) errors.push(t('At most {{n}} windows.', { n: L.maxWindows }));
  const windows: PutVehicleAvailabilityInput['windows'] = [];
  d.rows.forEach((r, i) => {
    const s = fromWall(r.start);
    const e = fromWall(r.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) errors.push(t('Row {{n}}: enter a start and an end.', { n: i + 1 }));
    else if (e <= s) errors.push(t('Row {{n}}: the end must be after the start.', { n: i + 1 }));
    else if (r.reason.length > L.reasonMax) errors.push(t('Row {{n}}: the reason is too long.', { n: i + 1 }));
    else windows.push({ kind: r.kind, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), reason: r.reason.trim() || null });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { turnaroundS, from: nowIso, windows } };
}
