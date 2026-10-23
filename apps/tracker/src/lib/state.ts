import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { DEFAULT_CONFIG, type TrackerConfig } from './api';
import { kvGet, kvSet } from './db';

/**
 * UI-side persistent state plus a tiny change-notification store. Tracking state (wanted, queue, last fix,
 * upload status, stop reason) is owned by the native engine; read it with `useTrackerStatus()` (tracking.ts).
 */

const TOKEN_KEY = 'veetrax_tracker_token';

export interface SessionInfo {
  uniqueId: string;
  objectName: string;
  companyName: string;
  mobile?: string;
  email?: string | null;
  accountType?: string | null;
  trialEndsAt?: string | null;
  licenceEndsAt?: string | null;
}

/** Session row from a /me or /activate/verify response. */
export function sessionFrom(r: {
  uniqueId: string;
  objectName: string;
  companyName: string;
  mobile?: string;
  email?: string | null;
  accountType?: string | null;
  trialEndsAt?: string | null;
  licenceEndsAt?: string | null;
}): SessionInfo {
  return {
    uniqueId: r.uniqueId,
    objectName: r.objectName,
    companyName: r.companyName,
    mobile: r.mobile,
    email: r.email ?? null,
    accountType: r.accountType ?? null,
    trialEndsAt: r.trialEndsAt ?? null,
    licenceEndsAt: r.licenceEndsAt ?? null,
  };
}

let tokenCache: string | null | undefined;

export async function getToken(): Promise<string | null> {
  if (tokenCache !== undefined) return tokenCache;
  tokenCache = await SecureStore.getItemAsync(TOKEN_KEY);
  return tokenCache;
}

/** Synchronous check after getToken() has run once (the root layout waits for it). */
export function hasToken(): boolean {
  return !!tokenCache;
}

export async function setToken(token: string | null): Promise<void> {
  tokenCache = token;
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
  emit();
}

export const store = {
  session: () => kvGet<SessionInfo | null>('session', null),
  setSession: (s: SessionInfo | null) => (kvSet('session', s), emit()),
  /** Last config from the server; passed to the native engine on start. */
  config: () => ({ ...DEFAULT_CONFIG, ...kvGet<Partial<TrackerConfig>>('config', {}) }),
  setConfig: (c: TrackerConfig) => kvSet('config', c),
  /** Message shown on the activation screen after a forced sign-out. */
  notice: () => kvGet<string | null>('notice', null),
  setNotice: (n: string | null) => (kvSet('notice', n), emit()),
  /** /me answered 403 INACTIVE (the native engine sets its own stopReason when an upload gets it). */
  inactive: () => kvGet<boolean>('inactive', false),
  setInactive: (on: boolean) => (kvSet('inactive', on), emit()),
  /** Next time to ask /me whether an INACTIVE device was switched on again. */
  inactiveCheckAt: () => kvGet<number>('inactiveCheckAt', 0),
  setInactiveCheckAt: (t: number) => kvSet('inactiveCheckAt', t),
  /** The user confirmed the OEM autostart / background settings. */
  oemDone: () => kvGet<boolean>('oemDone', false),
  setOemDone: (on: boolean) => (kvSet('oemDone', on), emit()),
};

// ---- change notification for React ----

let version = 0;
const listeners = new Set<() => void>();

export function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders when any state above changes (or emit() is called). Read values with `store.*()` during render. */
export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
