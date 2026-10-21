import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Tracker from '../../modules/veetrax-tracker';
import { SERVER_URL, type TrackerConfig } from './api';
import { getToken, store } from './state';

/**
 * JS side of tracking: a thin layer over the native engine (modules/veetrax-tracker). expo-location is used only
 * for permission prompts / checks; fixes, the queue and uploads are native.
 */

export type { TrackerStatus } from '../../modules/veetrax-tracker';
export { Tracker };

const POLL_MS = 2000;

/** Native status, refreshed every 2 s while the app is in the foreground (no polling in the background). */
export function useTrackerStatus(): [Tracker.TrackerStatus | null, () => void] {
  const [status, setStatus] = useState<Tracker.TrackerStatus | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const read = () => Tracker.getStatus().then(setStatus).catch(() => undefined);
    const begin = () => {
      read();
      if (!timer) timer = setInterval(read, POLL_MS);
    };
    const end = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') begin();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? begin() : end()));
    return () => (end(), sub.remove());
  }, [nonce]);
  return [status, () => setNonce((n) => n + 1)];
}

/** Starts the native service with the stored token and config. Returns null on success, else an error text. */
export async function startNative(): Promise<string | null> {
  const token = await getToken();
  if (!token) return 'Not activated';
  if (Platform.OS === 'android') {
    // Ask for Google's high-accuracy mode (GPS + Wi-Fi + cell). The user can decline; tracking still works.
    await Location.enableNetworkProviderAsync().catch(() => undefined);
  }
  const r = await Tracker.start(token, SERVER_URL, store.config());
  return r === 'started' ? null : r;
}

/** The user switches tracking off. */
export async function stopTracking(): Promise<void> {
  await Tracker.stop();
}

/** Stores a config from the server and hands it to the native engine (which re-requests GPS if needed). */
export async function applyConfig(next: TrackerConfig | undefined): Promise<void> {
  if (!next) return;
  store.setConfig(next);
  await Tracker.setConfig(next).catch(() => undefined);
}

export interface PermissionState {
  servicesOn: boolean;
  foreground: boolean;
  precise: boolean;
  background: boolean;
  canAskForeground: boolean;
  canAskBackground: boolean;
}

export async function readPermissions(): Promise<PermissionState> {
  const [fg, bg, servicesOn] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Location.hasServicesEnabledAsync().catch(() => true),
  ]);
  const accuracy = fg.android?.accuracy;
  return {
    servicesOn,
    foreground: fg.granted,
    precise: fg.granted && (Platform.OS !== 'android' || accuracy === undefined || accuracy === 'fine'),
    background: bg.granted,
    canAskForeground: fg.canAskAgain,
    canAskBackground: bg.canAskAgain,
  };
}

/**
 * Called when the app opens: if tracking is wanted but the service is not running (force-stop, OEM killer,
 * a start refused in the background), start it again while we are in the foreground (always allowed).
 */
export async function resumeIfWanted(): Promise<void> {
  const st = await Tracker.getStatus().catch(() => null);
  if (!st?.wanted || st.running || st.stopReason) return;
  const perms = await readPermissions().catch(() => null);
  if (!perms?.foreground) return;
  await startNative().catch(() => undefined);
}
