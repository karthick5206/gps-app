import { useQuery, useQueryClient } from '@tanstack/react-query';
import { can as canDo, type Action, type LoginResponse, type Me, type MenuKey } from '@veetracer/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, AppState } from 'react-native';
import { api, refreshAccessTokenOutcome, setSessionExpiredHandler } from '@/lib/api';
import type { OfflineIdentity } from '@/features/transport/sos-context';
import { forgetOfflineIdentity, loadOfflineIdentity } from '@/features/transport/sos-store';
import { serverChoice } from '@/lib/config';
import { session } from '@/lib/session';
import { liveStore } from '@/features/live/live-store';
import { unregisterPush } from '@/features/notifications/push';
import { applyThemePreference, restoreThemePreference } from '@/features/theme/theme';
import { i18n, restoreLanguage, setLanguage } from '@/lib/i18n';
import { display } from '@/features/display/display';
import { voiceAlerts } from '@/features/notifications/voice';
import { basemap } from '@/features/map/basemap';

/**
 * `offline` (r114, QA B4): the app started with a saved session but could not reach the server, and the last signed-in
 * user had an ETMS SOS section (passenger / driver). The session is kept (not signed out) and only the offline SOS
 * screen is shown until the server answers again. Every other user keeps the old behaviour (sign-in screen).
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'offline';

export interface AuthContextValue {
  status: AuthStatus;
  /** Set while `status === 'offline'`: whose SOS queues to load. */
  offlineIdentity: OfflineIdentity | null;
  /** Offline: try the server again now. */
  retryOnline: () => void;
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
  const [offlineIdentity, setOfflineIdentity] = useState<OfflineIdentity | null>(null);
  const companyId = useSyncExternalStore(session.subscribe, session.getCompanyId);

  // Restore the session from the refresh token in the keystore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([session.load(), serverChoice.restore(), restoreThemePreference(), restoreLanguage(), display.restore(), basemap.restore(), voiceAlerts.restore()]);
      const outcome = session.getRefreshToken() ? await refreshAccessTokenOutcome() : 'rejected';
      const identity = outcome === 'offline' ? await loadOfflineIdentity() : null;
      if (cancelled) return;
      if (outcome === 'ok') return setStatus('authenticated');
      if (identity) {
        // No connection, and this phone's user has an SOS section: keep the session, open the offline SOS screen.
        setOfflineIdentity(identity);
        return setStatus('offline');
      }
      session.clear();
      setStatus('anonymous');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Offline: retry the server every 15 s and when the app comes to the foreground.
  const retryOnline = useCallback(() => {
    void refreshAccessTokenOutcome().then((outcome) => {
      if (outcome === 'offline') return;
      setOfflineIdentity(null);
      if (outcome === 'ok') return setStatus('authenticated');
      forgetOfflineIdentity();
      session.clear();
      setStatus('anonymous');
    });
  }, []);
  useEffect(() => {
    if (status !== 'offline') return;
    const id = setInterval(retryOnline, 15_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') retryOnline();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [status, retryOnline]);

  const signOut = useCallback(() => {
    forgetOfflineIdentity();
    setOfflineIdentity(null);
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

  const value = useMemo<AuthContextValue>(
    () => ({ status, offlineIdentity, retryOnline, me, companyId, signIn, signOut, switchCompany, can }),
    [status, offlineIdentity, retryOnline, me, companyId, signIn, signOut, switchCompany, can],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
