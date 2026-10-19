import { useQuery, useQueryClient } from '@tanstack/react-query';
import { can as canDo, type Action, type LoginResponse, type Me, type MenuKey } from '@veetracer/shared';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, refreshAccessToken, setSessionExpiredHandler } from '@/lib/api';
import { session } from '@/lib/session';
import { themeStore } from '@/features/theme/theme-store';
import { i18n, setLanguage } from '@/lib/i18n';
import { displayStore } from '@/features/display/display-store';
import { liveStore } from '@/features/live/live-store';
import { AuthContext, meQueryKey, type AuthContextValue, type AuthStatus } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>(() => (session.getRefreshToken() ? 'loading' : 'anonymous'));
  const companyId = useSyncExternalStore(session.subscribe, session.getCompanyId);

  // Restore the session from the stored refresh token on first load.
  useEffect(() => {
    if (status !== 'loading') return;
    let cancelled = false;
    refreshAccessToken().then((ok) => {
      if (cancelled) return;
      if (!ok) session.clear();
      setStatus(ok ? 'authenticated' : 'anonymous');
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  const signOut = useCallback(() => {
    const refreshToken = session.getRefreshToken();
    if (refreshToken) api.post('/auth/logout', { refreshToken }, { anonymous: true }).catch(() => undefined);
    session.clear();
    liveStore.reset();
    queryClient.clear();
    setStatus('anonymous');
  }, [queryClient]);

  useEffect(() => {
    setSessionExpiredHandler((message) => {
      if (status !== 'authenticated') return;
      toast.error(message ? i18n.t(message) : i18n.t('Your session has expired. Please sign in again.'));
      signOut();
    });
  }, [signOut, status]);

  const meQuery = useQuery({
    queryKey: meQueryKey(companyId),
    queryFn: ({ signal }) => api.get<Me>('/auth/me', undefined, signal),
    enabled: status === 'authenticated',
    staleTime: 5 * 60_000,
  });

  // A stale company selection (e.g. deleted company) falls back to the platform company; other failures sign out.
  useEffect(() => {
    if (!meQuery.isError) return;
    if (companyId) {
      toast.error(i18n.t('The selected company is no longer available.'));
      session.setCompanyId(null);
    } else {
      signOut();
    }
  }, [meQuery.isError, companyId, signOut]);

  const signIn = useCallback(
    (res: LoginResponse) => {
      session.setCompanyId(null);
      session.setTokens(res);
      queryClient.setQueryData(meQueryKey(null), res.me);
      themeStore.setPreference(res.me.user.preferences.theme);
      if (res.me.user.preferences.language) setLanguage(res.me.user.preferences.language);
      displayStore.set({ textSize: res.me.user.preferences.textSize, mapIconSize: res.me.user.preferences.mapIconSize });
      setStatus('authenticated');
    },
    [queryClient],
  );

  const switchCompany = useCallback(
    (id: string | null) => {
      if (id === session.getCompanyId()) return;
      session.setCompanyId(id);
      liveStore.reset();
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
    [queryClient],
  );

  const me = meQuery.data;
  // The profile language (also set from the mobile app) wins once known.
  const profileLanguage = me?.user.preferences.language;
  useEffect(() => {
    if (profileLanguage) setLanguage(profileLanguage);
  }, [profileLanguage]);
  const profileTextSize = me?.user.preferences.textSize;
  const profileIconSize = me?.user.preferences.mapIconSize;
  useEffect(() => {
    displayStore.set({ textSize: profileTextSize, mapIconSize: profileIconSize });
  }, [profileTextSize, profileIconSize]);
  const can = useCallback((menu: MenuKey, action: Action = 'view') => !!me && canDo(me.permissions, menu, action), [me]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, companyId, signIn, signOut, switchCompany, can }),
    [status, me, companyId, signIn, signOut, switchCompany, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
