import { ROUTING_READINESS_LABELS, type RoutingOffReason, type RoutingReadinessDto, type RoutingReadinessKey } from '@veetracer/shared';

/**
 * v1.16 automatic route planning (owner decision 2026-11-13): texts and pure helpers of the Super Admin switch
 * (Platform Settings → Route planning), its readiness checklist (also on System Health), the company switch
 * (Transport → Settings) and the planner's "switched off" state. Kept free of React so `node --test` runs it.
 */

/** Planner / settings text for why routing is off for this company. */
export const OFF_REASON_TEXT: Record<RoutingOffReason, string> = {
  ENV_OFF: 'Automatic routing is switched off on the server (emergency switch). Ask your administrator.',
  PLATFORM_OFF: 'Automatic routing is switched off. Ask your administrator.',
  COMPANY_OFF: 'Automatic routing is switched off for your company. A Transport admin can switch it on under Transport → Settings.',
};

export function offReasonText(reason: RoutingOffReason | null | undefined): string {
  return OFF_REASON_TEXT[reason ?? 'PLATFORM_OFF'];
}

/** Company settings note under the company switch, from the capabilities' offReason (when known). */
export function companySwitchNote(companyOn: boolean, reason: RoutingOffReason | null | undefined): string {
  if (reason === 'ENV_OFF') return 'The server’s emergency switch keeps automatic routing off for everyone right now.';
  if (reason === 'PLATFORM_OFF') return companyOn ? 'Saved. It starts working when VeeTrax switches automatic route planning on for the platform.' : 'VeeTrax has not switched automatic route planning on for the platform yet; your choice takes effect when it does.';
  if (companyOn && reason === null) return 'Automatic route planning is working for your company.';
  return 'Off: trips are planned by hand on the dispatch board.';
}

export const readinessLabel = (key: RoutingReadinessKey): string => ROUTING_READINESS_LABELS[key];

/** The readiness a refused switch-ON carried (409 ROUTING_NOT_READY body), if any. */
export function refusedReadiness(body: unknown): RoutingReadinessDto | null {
  const r = (body as { code?: unknown; readiness?: unknown } | null) ?? null;
  if (!r || r.code !== 'ROUTING_NOT_READY' || !r.readiness || typeof r.readiness !== 'object') return null;
  const rd = r.readiness as RoutingReadinessDto;
  return Array.isArray(rd.checks) ? rd : null;
}

/** Failing items, in checklist order (for the refusal toast). */
export function missingItems(r: RoutingReadinessDto | null | undefined): RoutingReadinessKey[] {
  return (r?.checks ?? []).filter((c) => !c.ok).map((c) => c.key);
}

/** Static UI strings of this feature (each needs hi + ta; checked by routing-switch-format.test.ts). */
export const ROUTING_SWITCH_STRINGS: readonly string[] = [
  ...Object.values(OFF_REASON_TEXT),
  ...Object.values(ROUTING_READINESS_LABELS),
  'The server’s emergency switch keeps automatic routing off for everyone right now.',
  'Saved. It starts working when VeeTrax switches automatic route planning on for the platform.',
  'VeeTrax has not switched automatic route planning on for the platform yet; your choice takes effect when it does.',
  'Automatic route planning is working for your company.',
  'Off: trips are planned by hand on the dispatch board.',
  'Route planning',
  'Automatic route planning',
  'Automatic routing is switched off',
  'Switch automatic route planning on for the platform',
  'Off by default. When on, companies that switched it on in their Transport settings can optimise routes automatically. It can only be switched on when every check below passes.',
  'Readiness',
  'Check again',
  'Ready',
  'Not ready',
  'Switched on',
  'Switched off',
  'Installed, switched off',
  'Emergency switch on the server: off',
  'Companies using it',
  'Optimisations queued or running',
  'Last changed',
  'Automatic route planning switched on',
  'Automatic route planning switched off. Optimisations already running finish; queued ones are cancelled and their plans stay editable.',
  'Cannot switch on yet: {{items}}',
  'Switching off never interrupts a running optimisation: it finishes (at most a few minutes). Optimisations still waiting are ended and their plans go back to drafts. Manual dispatch is not affected.',
  'Use automatic route planning',
  'Off by default. When on, your planners can optimise the day’s bookings into routes on the Route planning page.',
  'Automatic route planning is on for your company',
  'Automatic route planning is off for your company',
  'Change it under Platform Settings → Route planning.',
  'Automatic routing was switched off before this optimisation started. The plan is unchanged; plan by hand or ask your administrator.',
  'Only a Transport admin with whole-company access can change this.',
];
