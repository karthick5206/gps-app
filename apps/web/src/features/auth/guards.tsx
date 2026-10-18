import type { Action, MenuKey } from '@veetracer/shared';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { FullScreenLoader } from '@/components/full-screen-loader';
import { ForbiddenPage } from '@/features/errors/ErrorPages';
import { useAuth } from './auth-context';

/** Gate for the authenticated app: waits for session restore + `Me`, else redirects to /login. */
export function RequireAuth() {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading' || (status === 'authenticated' && !me)) return <FullScreenLoader />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Public auth pages redirect to the app when already signed in. */
export function RedirectIfAuthenticated() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;
  return <Outlet />;
}

export function RequirePermission({ menu, action = 'view', children }: { menu: MenuKey; action?: Action; children: ReactNode }) {
  const { can } = useAuth();
  return can(menu, action) ? children : <ForbiddenPage />;
}
