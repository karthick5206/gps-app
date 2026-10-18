import type { AuthTokens } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';

/**
 * Client session: access token in memory only; the refresh token and the company the Super Admin acts in are
 * kept in the device keystore (SecureStore). `load()` must finish before the first API call.
 */
type Listener = () => void;

const KEYS = { refreshToken: 'vt.refreshToken', companyId: 'vt.companyId' } as const;

let accessToken: string | null = null;
let refreshToken: string | null = null;
let companyId: string | null = null;
const listeners = new Set<Listener>();

function persist(key: string, value: string | null) {
  (value ? SecureStore.setItemAsync(key, value) : SecureStore.deleteItemAsync(key)).catch(() => undefined);
}

export const session = {
  async load() {
    try {
      [refreshToken, companyId] = await Promise.all([SecureStore.getItemAsync(KEYS.refreshToken), SecureStore.getItemAsync(KEYS.companyId)]);
    } catch {
      refreshToken = null;
      companyId = null;
    }
  },

  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,
  getCompanyId: () => companyId,

  setTokens(tokens: AuthTokens) {
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    persist(KEYS.refreshToken, tokens.refreshToken);
  },

  clear() {
    accessToken = null;
    refreshToken = null;
    persist(KEYS.refreshToken, null);
    session.setCompanyId(null);
  },

  setCompanyId(id: string | null) {
    if (id === companyId) return;
    companyId = id;
    persist(KEYS.companyId, id);
    listeners.forEach((l) => l());
  },

  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
