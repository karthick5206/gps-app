/**
 * Automatic route planning switches (v1.16.0, owner decision 2026-11-13: "keep automatic routing off now; add an option
 * in admin; if I enable it, it should work").
 *
 * Routing (optimisation jobs, the Route planning page, the routing worker's GraphHopper / optimiser traffic) is ACTIVE
 * for a company only when all three hold:
 *
 *   1. the server's `ETMS_ROUTING` is not `off` (and `ETMS` is not `off`): the emergency hard kill switch in
 *      apps/api/.env. Unset, empty, `auto` or `on` all mean "the database switches decide" (mode `auto`). Only an
 *      explicit `off` kills routing, whatever the UI says (a restart of the API and the worker applies it);
 *   2. the platform switch "Automatic route planning" is ON (Super Admin, table RoutingSettings, default OFF). It can
 *      only be switched on while the readiness check passes (optimiser reachable and healthy with the right Python /
 *      OR-Tools, a routing worker alive, GraphHopper healthy);
 *   3. the company's own switch is ON (`Company.settings.etms.autoRouting`, Transport → Settings, default OFF).
 *
 * Fresh installs and upgrades therefore stay OFF without editing .env: the platform switch starts OFF.
 */

export type RoutingEnvMode = 'off' | 'auto';

/** Why routing is not active for a company (null = active). */
export type RoutingOffReason = 'ENV_OFF' | 'PLATFORM_OFF' | 'COMPANY_OFF';

/** `ETMS_ROUTING` / `ETMS` as the API reads them: only an explicit `off` (of either) is the hard kill switch. */
export function routingEnvModeOf(env: { ETMS?: string; ETMS_ROUTING?: string }): RoutingEnvMode {
  const etms = (env.ETMS ?? '').trim().toLowerCase();
  const routing = (env.ETMS_ROUTING ?? '').trim().toLowerCase();
  return etms === 'off' || routing === 'off' ? 'off' : 'auto';
}

/** The three-switch rule (doc above). */
export function routingOffReason(input: { envMode: RoutingEnvMode; platform: boolean; company: boolean }): RoutingOffReason | null {
  if (input.envMode === 'off') return 'ENV_OFF';
  if (!input.platform) return 'PLATFORM_OFF';
  if (!input.company) return 'COMPANY_OFF';
  return null;
}

/** Readiness items checked before the platform switch may go ON (and shown on System Health). */
export const ROUTING_READINESS_KEYS = ['env', 'optimizerConfig', 'optimizer', 'optimizerVersion', 'worker', 'engine'] as const;
export type RoutingReadinessKey = (typeof ROUTING_READINESS_KEYS)[number];

/** Human labels (English source strings; the web translates them). */
export const ROUTING_READINESS_LABELS: Record<RoutingReadinessKey, string> = {
  env: 'Server kill switch (ETMS_ROUTING) not set to off',
  optimizerConfig: 'Optimiser address and token configured',
  optimizer: 'Optimiser service answering',
  optimizerVersion: 'Optimiser Python and OR-Tools versions',
  worker: 'Routing worker running',
  engine: 'Road engine (GraphHopper) healthy',
};

/** Minimum Python of the optimiser service (ortools cp314 wheels, doc 17 R-9). */
export const ROUTING_MIN_PYTHON: readonly [number, number] = [3, 14];

export interface RoutingReadinessCheck {
  key: RoutingReadinessKey;
  ok: boolean;
  /** What is missing / what was found (never a host, token or coordinate). */
  detail: string | null;
}

export interface RoutingReadinessDto {
  ready: boolean;
  checks: RoutingReadinessCheck[];
  checkedAt: string;
}

/** GET /api/admin/routing (Super Admin, Platform Settings → Route planning). */
export interface RoutingPlatformSwitchDto {
  /** The platform switch as stored (default false). */
  enabled: boolean;
  envMode: RoutingEnvMode;
  /** enabled and envMode = auto: companies that switched it on plan automatically. */
  active: boolean;
  updatedAt: string | null;
  /** Name of who changed it last (Super Admin), or null. */
  updatedBy: string | null;
  /** Companies with their own switch on (count only). */
  companiesOn: number;
  /** Optimisation jobs still queued or running (they finish, or are cancelled cleanly, after a switch-off). */
  openJobs: number;
  readiness: RoutingReadinessDto;
}

/** PUT /api/admin/routing body. ON is refused (409 ROUTING_NOT_READY, with the readiness) unless every check passes. */
export interface UpdateRoutingPlatformSwitchInput {
  enabled: boolean;
}

/** Python version string ("3.14.0") at least ROUTING_MIN_PYTHON. */
export function pythonVersionOk(v: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec((v ?? '').trim());
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > ROUTING_MIN_PYTHON[0] || (maj === ROUTING_MIN_PYTHON[0] && min >= ROUTING_MIN_PYTHON[1]);
}
