import type { Action, MenuKey } from '@veetracer/shared';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { FullScreenLoader } from '@/components/full-screen-loader';
import { ForbiddenPage } from '@/features/errors/ErrorPages';
import { useAuth } from './auth-context';

/** Who was signed in when the app last ran a protected page (module-level: lives as long as the tab). */
let lastUserId: string | null = null;

/** Where to go after signing in, and for whom: null user = a link opened while signed out (anyone may follow it). */
interface ReturnTo {
  from?: string;
  user?: string | null;
}

/** Gate for the authenticated app: waits for session restore + `Me`, else redirects to /login. */
export function RequireAuth() {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading' || (status === 'authenticated' && !me)) return <FullScreenLoader />;
  if (status === 'anonymous') {
    const state: ReturnTo = { from: location.pathname + location.search, user: lastUserId };
    return <Navigate to="/login" replace state={state} />;
  }
  lastUserId = me?.user.id ?? null;
  return <Outlet />;
}

/**
 * Public auth pages redirect to the app when already signed in: back to the page that asked for sign-in, but only for
 * the same person. Another account goes to its landing page — the old page (e.g. a vehicle of another company) would
 * only show "Object not found".
 */
export function RedirectIfAuthenticated() {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading' || (status === 'authenticated' && !me)) return <FullScreenLoader />;
  if (status === 'authenticated') {
    const r = (location.state as ReturnTo | null) ?? {};
    const sameUser = !r.user || r.user === me?.user.id;
    return <Navigate to={r.from && sameUser ? r.from : '/'} replace />;
  }
  return <Outlet />;
}

export function RequirePermission({ menu, action = 'view', children }: { menu: MenuKey; action?: Action; children: ReactNode }) {
  const { can } = useAuth();
  return can(menu, action) ? children : <ForbiddenPage />;
}
