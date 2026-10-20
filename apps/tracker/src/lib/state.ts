import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { DEFAULT_CONFIG, type TrackerConfig } from './api';
import { kvGet, kvMerge, kvSet } from './db';

/** Persistent app state shared by the UI and the background task, plus a tiny change-notification store. */

const TOKEN_KEY = 'veetrax_tracker_token';

export interface SessionInfo { uniqueId: string; objectName: string; companyName: string }

export interface TrackStatus {
  lastFixAt?: number;
  lastAcc?: number | null;
  lastSpd?: number | null;
  lastUploadAt?: number;
  lastError?: string | null;
  failures?: number;
  backoffUntil?: number;
}

/** Set when the server answered 403 INACTIVE: tracking is stopped, token kept, re-checked hourly. */
export interface Blocked { code: 'INACTIVE'; at: number; nextCheckAt: number }

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
}

export const store = {
  session: () => kvGet<SessionInfo | null>('session', null),
  setSession: (s: SessionInfo | null) => (kvSet('session', s), emit()),
  config: () => ({ ...DEFAULT_CONFIG, ...kvGet<Partial<TrackerConfig>>('config', {}) }),
  setConfig: (c: TrackerConfig) => kvSet('config', c),
  /** The user wants tracking on (survives restarts; used to auto-resume). */
  wanted: () => kvGet<boolean>('wanted', false),
  setWanted: (on: boolean) => (kvSet('wanted', on), emit()),
  status: () => kvGet<TrackStatus>('status', {}),
  patchStatus: (p: Partial<TrackStatus>) => (kvMerge<TrackStatus>('status', p), emit()),
  blocked: () => kvGet<Blocked | null>('blocked', null),
  setBlocked: (b: Blocked | null) => (kvSet('blocked', b), emit()),
  /** Message shown on the activation screen after a forced sign-out. */
  notice: () => kvGet<string | null>('notice', null),
  setNotice: (n: string | null) => (kvSet('notice', n), emit()),
  lastT: () => kvGet<number>('lastT', 0),
  setLastT: (t: number) => kvSet('lastT', t),
  /** Location-update options changed while the app was in the background; restart when it is active. */
  pendingRestart: () => kvGet<boolean>('pendingRestart', false),
  setPendingRestart: (on: boolean) => kvSet('pendingRestart', on),
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
