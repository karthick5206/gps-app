import type { AuthTokens } from '@veetracer/shared';
import { storage, STORAGE_KEYS } from './storage';

/**
 * Client session: access token in memory only, refresh token in localStorage,
 * plus the company the Super Admin is acting in (sent as X-Company-Id).
 */
type Listener = () => void;

let accessToken: string | null = null;
let companyId: string | null = storage.get(STORAGE_KEYS.companyId);
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

export const session = {
  getAccessToken: () => accessToken,
  getRefreshToken: () => storage.get(STORAGE_KEYS.refreshToken),
  getCompanyId: () => companyId,

  setTokens(tokens: AuthTokens) {
    accessToken = tokens.accessToken;
    storage.set(STORAGE_KEYS.refreshToken, tokens.refreshToken);
  },

  clear() {
    accessToken = null;
    storage.set(STORAGE_KEYS.refreshToken, null);
    session.setCompanyId(null);
  },

  setCompanyId(id: string | null) {
    if (id === companyId) return;
    companyId = id;
    storage.set(STORAGE_KEYS.companyId, id);
    emit();
  },

  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
