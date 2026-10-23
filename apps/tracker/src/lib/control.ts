import * as Location from 'expo-location';
import { api, ApiError } from './api';
import { requestNotifications } from './device';
import { getToken, sessionFrom, setToken, store } from './state';
import { S } from './strings';
import { applyConfig, startNative, Tracker, type TrackerStatus } from './tracking';

export type BeginResult = { ok: true; backgroundDenied: boolean } | { ok: false; message: string };

const INACTIVE_RECHECK_MS = 60 * 60_000;

/**
 * Asks for the permissions (foreground, then background, then notifications) and starts the native service.
 * Call only after the in-app disclosure was accepted, or when the permissions are already granted.
 */
export async function beginTracking(): Promise<BeginResult> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, message: S.permDeniedForeground };

  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) bg = await Location.requestBackgroundPermissionsAsync().catch(() => bg);

  await requestNotifications();

  const err = await startNative().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (err) return { ok: false, message: err === 'no_permission' ? S.permDeniedForeground : err };
  return { ok: true, backgroundDenied: !bg.granted };
}

/** True when tracking can start without showing the disclosure (everything already granted). */
export async function permissionsReady(): Promise<boolean> {
  const [fg, bg] = await Promise.all([Location.getForegroundPermissionsAsync(), Location.getBackgroundPermissionsAsync()]);
  return fg.granted && bg.granted;
}

/** Stops tracking and clears the token and all local data. `notice` is shown on the activation screen. */
export async function signOut(notice: string | null): Promise<void> {
  await Tracker.clear().catch(() => undefined);
  await setToken(null);
  store.setInactive(false);
  store.setInactiveCheckAt(0);
  store.setNotice(notice);
  store.setSession(null);
}

/** Handles 401 / 403 INACTIVE from a JS call (/me). Returns true when the error was one of those. */
export async function handleAuthError(e: unknown): Promise<boolean> {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401) {
    await signOut(e.code === 'REVOKED' ? S.reasonRevoked : S.reasonInvalid);
    return true;
  }
  if (e.status === 403 && e.code === 'INACTIVE') {
    await Tracker.stop().catch(() => undefined);
    store.setInactive(true);
    store.setInactiveCheckAt(Date.now() + INACTIVE_RECHECK_MS);
    return true;
  }
  return false;
}

/**
 * Reacts to a stop decided by the native uploader: REVOKED / INVALID → sign out (the engine already deleted
 * the token and queue). INACTIVE is shown on the home screen and re-checked hourly.
 */
export async function syncStopReason(st: TrackerStatus | null): Promise<void> {
  if (!st) return;
  if (st.stopReason === 'REVOKED') await signOut(S.reasonRevoked);
  else if (st.stopReason === 'INVALID') await signOut(S.reasonInvalid);
}

/** Tracking is blocked by the administrator (from an upload or from /me). */
export function isInactive(st: TrackerStatus | null): boolean {
  return st?.stopReason === 'INACTIVE' || store.inactive();
}

/** While INACTIVE: at most hourly, ask /me; when it works again, clear the stop reason (the user starts again). */
export async function recheckInactive(st: TrackerStatus | null, force = false): Promise<void> {
  const token = await getToken();
  if (!token || !isInactive(st)) return;
  if (!force && Date.now() < store.inactiveCheckAt()) return;
  store.setInactiveCheckAt(Date.now() + INACTIVE_RECHECK_MS);
  try {
    const me = await api.me(token);
    await Tracker.resetStopReason();
    store.setInactive(false);
    store.setSession(sessionFrom(me));
    await applyConfig(me.config);
  } catch (e) {
    await handleAuthError(e);
  }
}
