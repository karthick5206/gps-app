/**
 * Which shell the signed-in user gets (ETMS E5, doc 08 §4.1, doc 09 §2.2, owner decisions D4 / D5 / P3).
 *
 * Pure (no React Native imports) so `node --test` can check it. The client choice only drives navigation: the server
 * stays the authority (every `/api/me/transport/*` and `/api/driver/v1/*` route checks the menu key AND the person's
 * own passenger profile / driver link, and answers 403 NOT_A_PASSENGER / DRIVER_INACTIVE otherwise).
 *
 * - `etms_self` → Passenger section, `etms_driver` → Driver section, only while the company has the `etms` add-on.
 * - A user who also holds any fleet / admin menu keeps the fleet shell and gets "My commute" / "My transport duty"
 *   entries inside it (P3: dual-role users). The Admin role is built from every menu, so admins land here too.
 * - Driver wins over passenger when a user holds only those two keys (a driver may also ride: commute stays reachable).
 */
import type { Action, MenuKey, PermissionMap } from '@veetracer/shared';

export type Shell = 'fleet' | 'passenger' | 'driver';

export interface TransportRoles {
  /** The company has the ETMS add-on. */
  etms: boolean;
  /** May open the Passenger section ("My commute"). */
  passenger: boolean;
  /** May open the Driver section ("My transport duty"). */
  driver: boolean;
  /** May open the read-only SOS incident screen (`etms_incidents:view`; r114, QA B2). */
  incidents: boolean;
  /** Holds at least one fleet / admin menu (anything other than the two self-service keys). */
  fleet: boolean;
  shell: Shell;
}

/** Self-service keys that do not make someone a fleet user. */
const SELF_KEYS: readonly MenuKey[] = ['etms_self', 'etms_driver'];

interface MeLike {
  permissions: PermissionMap;
  company: { features: readonly string[] };
  user?: { isSuperAdmin?: boolean };
}

function has(perms: PermissionMap, key: MenuKey, action: Action = 'view'): boolean {
  return perms[key]?.includes(action) ?? false;
}

export function transportRoles(me: MeLike | undefined | null): TransportRoles {
  if (!me) return { etms: false, passenger: false, driver: false, incidents: false, fleet: true, shell: 'fleet' };
  const etms = me.company.features.includes('etms');
  const passenger = etms && has(me.permissions, 'etms_self');
  const driver = etms && has(me.permissions, 'etms_driver');
  const incidents = etms && has(me.permissions, 'etms_incidents');
  const fleet =
    !!me.user?.isSuperAdmin ||
    (Object.keys(me.permissions) as MenuKey[]).some((k) => !SELF_KEYS.includes(k) && (me.permissions[k]?.length ?? 0) > 0);
  // A user with no permission at all keeps the existing fleet shell (it shows its own empty states).
  const shell: Shell = fleet ? 'fleet' : driver ? 'driver' : passenger ? 'passenger' : 'fleet';
  return { etms, passenger, driver, incidents, fleet, shell };
}

/** Where `/` lands for each shell: the fleet home, the passenger "My commute" tab, the driver "My duty" tab. */
export const SHELL_HOME = { fleet: '/', passenger: '/my-commute', driver: '/my-duty' } as const satisfies Record<Shell, string>;

export type AppHome = (typeof SHELL_HOME)[Shell] | '/login' | '/offline-sos';

/**
 * The root navigator's home for the current auth state. `_layout.tsx` passes it as `redirectTo` on every
 * `Stack.Protected`, so any guarded route (`/` = the fleet `(tabs)` index on sign-in, cold start, the deep link
 * `veetrax:///`, `router.replace('/')`, `<Redirect href="/" />`) redirects here. Without it expo-router falls back to
 * the first unguarded group, `/(passenger)` or `/(driver)`, which has no index route: "Unmatched Route".
 */
export function appHome(status: string, shell: Shell | null | undefined): AppHome {
  if (status === 'offline') return '/offline-sos';
  if (status !== 'authenticated') return '/login';
  return SHELL_HOME[shell ?? 'fleet'];
}
