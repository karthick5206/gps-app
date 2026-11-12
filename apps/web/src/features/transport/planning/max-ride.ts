/**
 * Owner decisions on the E4 route-optimisation patch (2026-11-11), web helpers (pure; no React, no path aliases):
 * - Decision 1: maximum ride time = company policy (transport settings) with an authorised, audited per-plan override
 *   (optimise / re-optimise dialogs). Who may override comes from GET /routing/capabilities (access.canOverrideMaxRide:
 *   etms_settings:edit with whole-company scope); the API enforces it again.
 * - Decision 2: at most ROUTING_LIMITS.planBookings (75) bookings per plan, read from the capabilities.
 */
import { MAX_RIDE_BOUNDS_S, MAX_RIDE_REASON_LENGTH, meaningfulOverrideReason, overrideReasonText, ROUTING_LIMITS, type MaxRideOverrideInput, type RoutePlanMaxRide, type RoutingCapabilities } from '@veetracer/shared';
import { formatDuration } from './planner-format.ts';

type Translate = (key: string, vars?: Record<string, unknown>) => string;

export const MAX_RIDE_MINUTES = { min: MAX_RIDE_BOUNDS_S.min / 60, max: MAX_RIDE_BOUNDS_S.max / 60 } as const;

/** Every text the max-ride / plan-size UI shows (checked for hi / ta in max-ride.test.ts). */
export const MAX_RIDE_STRINGS = [
  'Enter the maximum ride time in minutes (15–240).',
  'Give a reason for the override: at least 15 characters, in words.',
  'Company maximum ride time: {{value}}',
  'Company maximum ride time: no limit',
  '{{value}} · override: {{reason}}',
  '{{value}} · company policy',
  'No limit',
  'Not optimised yet',
  'Not optimised yet · override set: {{value}}',
  'Maximum ride time',
  'Longest time a passenger may spend in the vehicle. Route optimisation uses it unless a plan has an authorised override.',
  'Maximum ride time (minutes)',
  'Leave empty for no limit. 15–240 minutes.',
  'Maximum ride time saved.',
  'Override the company maximum ride time for this plan',
  'Maximum ride time for this plan (minutes)',
  'Reason for the override',
  'Required: at least {{n}} characters, in words. Recorded in the audit log with your name.',
  'Turning this off returns the plan to the company policy at the next optimisation.',
  'At most {{n}} bookings per plan. Split larger groups by shift, branch or site.',
] as const;

export type ParsedMinutes = { ok: true; seconds: number | null } | { ok: false; error: string };

/** Minutes typed by the user → seconds within the bounds; empty = no limit (null). */
export function parseMaxRideMinutes(text: string): ParsedMinutes {
  const s = text.trim();
  if (!s) return { ok: true, seconds: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: 'Enter the maximum ride time in minutes (15–240).' };
  const min = Number(s);
  if (min < MAX_RIDE_MINUTES.min || min > MAX_RIDE_MINUTES.max) return { ok: false, error: 'Enter the maximum ride time in minutes (15–240).' };
  return { ok: true, seconds: min * 60 };
}

/** Seconds → the minutes text of an input ('' for none). */
export const minutesText = (s: number | null | undefined): string => (typeof s === 'number' && s > 0 ? String(Math.round(s / 60)) : '');

export interface MaxRideOverrideDraft {
  enabled: boolean;
  minutes: string;
  reason: string;
}

/** The dialog starts from the plan's own override (or off). */
export function overrideDraftOf(plan: { maxRide?: RoutePlanMaxRide | null }): MaxRideOverrideDraft {
  const o = plan.maxRide?.override;
  return o ? { enabled: true, minutes: minutesText(o.maxRideS), reason: o.reason } : { enabled: false, minutes: '', reason: '' };
}

/**
 * The request field from the dialog: undefined = send nothing (no change; the plan keeps its override), null = clear
 * the plan's override, else the new override. Errors in English (translated by the screen).
 */
export function overrideRequest(draft: MaxRideOverrideDraft, current: RoutePlanMaxRide['override'] | null | undefined): { ok: true; value: MaxRideOverrideInput | null | undefined } | { ok: false; errors: string[] } {
  if (!draft.enabled) return { ok: true, value: current ? null : undefined };
  const errors: string[] = [];
  const parsed = parseMaxRideMinutes(draft.minutes);
  if (!parsed.ok || parsed.seconds === null) errors.push('Enter the maximum ride time in minutes (15–240).');
  const reason = overrideReasonText(draft.reason);
  if (!maxRideReasonValid(reason)) errors.push(MAX_RIDE_REASON_ERROR);
  if (errors.length || !parsed.ok || parsed.seconds === null) return { ok: false, errors };
  if (current && current.maxRideS === parsed.seconds && current.reason === reason) return { ok: true, value: undefined };
  return { ok: true, value: { maxRideS: parsed.seconds, reason } };
}

/** D-L4: the reason rule of every audited override (shared with publish: 15+ characters, two words; hi / ta letters count). */
export function maxRideReasonValid(raw: string): boolean {
  return meaningfulOverrideReason(raw) && overrideReasonText(raw).length <= MAX_RIDE_REASON_LENGTH.max;
}

export const MAX_RIDE_REASON_ERROR = 'Give a reason for the override: at least 15 characters, in words.';

/** Override fields are shown only to callers the API authorises. */
export const canOverrideMaxRide = (caps: Pick<RoutingCapabilities, 'access'> | null | undefined): boolean => caps?.access?.canOverrideMaxRide === true;

export function policyLabel(caps: Pick<RoutingCapabilities, 'access'> | null | undefined, t: Translate): string {
  const s = caps?.access?.maxRidePolicyS ?? null;
  return s ? t('Company maximum ride time: {{value}}', { value: formatDuration(s, t) }) : t('Company maximum ride time: no limit');
}

/** Plan detail: which max ride the last optimisation used and where it came from. */
export function maxRideSummary(m: RoutePlanMaxRide | null | undefined, t: Translate): string {
  if (!m || !m.appliedSource) return m?.override ? t('Not optimised yet · override set: {{value}}', { value: formatDuration(m.override.maxRideS, t) }) : t('Not optimised yet');
  if (m.appliedSource === 'none' || !m.appliedS) return t('No limit');
  const value = formatDuration(m.appliedS, t);
  return m.appliedSource === 'override' ? t('{{value}} · override: {{reason}}', { value, reason: m.override?.reason ?? '' }) : t('{{value}} · company policy', { value });
}

/** Bookings one plan may hold (create and optimise alike). */
export const planBookingsLimit = (caps: Pick<RoutingCapabilities, 'limits'> | null | undefined): number => (caps?.limits as { planBookings?: number } | undefined)?.planBookings ?? ROUTING_LIMITS.planBookings;
