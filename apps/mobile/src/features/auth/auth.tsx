import { useQuery, useQueryClient } from '@tanstack/react-query';
import { can as canDo, type Action, type LoginResponse, type Me, type MenuKey } from '@veetracer/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { api, refreshAccessToken, setSessionExpiredHandler } from '@/lib/api';
import { session } from '@/lib/session';
import { liveStore } from '@/features/live/live-store';
import { unregisterPush } from '@/features/notifications/push';
import { applyThemePreference, restoreThemePreference } from '@/features/theme/theme';
import { i18n, restoreLanguage, setLanguage } from '@/lib/i18n';
import { display } from '@/features/display/display';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  me: Me | undefined;
  companyId: string | null;
  signIn: (res: LoginResponse) => void;
  signOut: () => void;
  switchCompany: (companyId: string | null) => void;
  can: (menu: MenuKey, action?: Action) => boolean;
}

export const meQueryKey = (companyId: string | null) => ['me', companyId] as const;

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const companyId = useSyncExternalStore(session.subscribe, session.getCompanyId);

  // Restore the session from the refresh token in the keystore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([session.load(), restoreThemePreference(), restoreLanguage(), display.restore()]);
      const ok = session.getRefreshToken() ? await refreshAccessToken() : false;
      if (cancelled) return;
      if (!ok) session.clear();
      setStatus(ok ? 'authenticated' : 'anonymous');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(() => {
    void unregisterPush();
    const refreshToken = session.getRefreshToken();
    if (refreshToken) api.post('/auth/logout', { refreshToken }, { anonymous: true }).catch(() => undefined);
    session.clear();
    liveStore.reset();
    queryClient.clear();
    setStatus('anonymous');
  }, [queryClient]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      if (status !== 'authenticated') return;
      Alert.alert(i18n.t('Signed out'), i18n.t('Your session has expired. Please sign in again.'));
      signOut();
    });
  }, [signOut, status]);

  const meQuery = useQuery({
    queryKey: meQueryKey(companyId),
    queryFn: ({ signal }) => api.get<Me>('/auth/me', undefined, signal),
    enabled: status === 'authenticated',
    staleTime: 5 * 60_000,
  });

  // A stale company selection falls back to the platform company; other failures sign out.
  useEffect(() => {
    if (!meQuery.isError) return;
    if (companyId) session.setCompanyId(null);
    else signOut();
  }, [meQuery.isError, companyId, signOut]);

  const signIn = useCallback(
    (res: LoginResponse) => {
      session.setCompanyId(null);
      session.setTokens(res);
      queryClient.setQueryData(meQueryKey(null), res.me);
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
  // The profile theme (also set from the web app) wins once it is known.
  const themePref = me?.user.preferences.theme;
  useEffect(() => {
    if (themePref) applyThemePreference(themePref);
  }, [themePref]);
  const languagePref = me?.user.preferences.language;
  useEffect(() => {
    if (languagePref) setLanguage(languagePref);
  }, [languagePref]);
  const textSizePref = me?.user.preferences.textSize;
  const iconSizePref = me?.user.preferences.mapIconSize;
  useEffect(() => {
    display.set({ textSize: textSizePref, mapIconSize: iconSizePref });
  }, [textSizePref, iconSizePref]);
  const can = useCallback((menu: MenuKey, action: Action = 'view') => !!me && canDo(me.permissions, menu, action), [me]);

  const value = useMemo<AuthContextValue>(() => ({ status, me, companyId, signIn, signOut, switchCompany, can }), [status, me, companyId, signIn, signOut, switchCompany, can]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
