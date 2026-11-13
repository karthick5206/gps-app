import { ETMS_PLANNING_MENU } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '@/features/auth/auth-context';
import { ApiError } from '@/lib/api';
import { isEnabled } from '@/lib/flags';
import type { PlannerClient } from './planner-api';
import { httpPlannerClient } from './planner-http';

/** Small module (no E3 imports) so the shell can gate the menu without pulling the planner into the main chunk. */

export const PLANNING_MENU = ETMS_PLANNING_MENU;
export const PLANNING_PATH = '/transport/planning';
export const planPath = (id: string) => `${PLANNING_PATH}/${encodeURIComponent(id)}`;

// ───────────────────────────── client (real API; dev-only mock) ─────────────────────────────

const MOCK_KEY = 'vt.plannerMock';
let clientPromise: Promise<PlannerClient> | null = null;

/**
 * The API client. In a dev build only, `localStorage['vt.plannerMock'] = '1'` (or `'engine-down'`) swaps in the
 * synthetic in-memory API; production builds drop that branch and the mock module entirely.
 */
export function plannerClient(): Promise<PlannerClient> {
  if (clientPromise) return clientPromise;
  let mode: string | null = null;
  if (import.meta.env.DEV) {
    try {
      mode = globalThis.localStorage?.getItem(MOCK_KEY) ?? null;
    } catch {
      mode = null;
    }
  }
  clientPromise =
    import.meta.env.DEV && mode
      ? import('./planner-mock').then((m) => m.createMockPlannerClient({ mode: mode === 'engine-down' ? 'engine-down' : 'ok' }))
      : Promise.resolve(httpPlannerClient);
  return clientPromise;
}

export const call = async <T>(fn: (c: PlannerClient) => Promise<T>): Promise<T> => fn(await plannerClient());

export const plannerKeys = {
  capabilities: ['routing-capabilities'] as const,
  plans: ['route-plans'] as const,
  plan: (id: string) => ['route-plan', id] as const,
  history: (id: string) => ['route-plan-history', id] as const,
  job: (id: string) => ['routing-job', id] as const,
  compare: ['route-plans-compare'] as const,
};

// ───────────────────────────── gate (web flag + API capabilities) ─────────────────────────────

export function plannerFlagOn(): boolean {
  return isEnabled('etmsRouting');
}

export function useCapabilities(enabled = true) {
  return useQuery({
    queryKey: plannerKeys.capabilities,
    queryFn: ({ signal }) => call((c) => c.capabilities(signal)),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
  });
}

/**
 * Whether the planner menu is shown: web flag on (default on since v1.16), the user holds etms_planning:view, and the
 * API answered the capabilities. v1.16: also shown while automatic routing is switched off, so the page can say so
 * ("ask your administrator") once the Super Admin and the company switch it on, it simply works. Hidden while unknown.
 */
export function usePlannerMenuHidden(): boolean {
  const me = useMe();
  const has = !!me.permissions[PLANNING_MENU]?.includes('view');
  const flag = plannerFlagOn();
  const caps = useCapabilities(has && flag);
  return !(has && flag && caps.data !== undefined);
}

