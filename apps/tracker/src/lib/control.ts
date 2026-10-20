import * as Location from 'expo-location';
import { requestNotifications } from './device';
import { store } from './state';
import { S } from './strings';
import { startUpdates } from './tracking';
import { flush } from './uploader';

export type BeginResult = { ok: true; backgroundDenied: boolean } | { ok: false; message: string };

/**
 * Asks for the permissions (foreground, then background, then notifications) and starts tracking.
 * Call only after the in-app disclosure was accepted, or when the permissions are already granted.
 */
export async function beginTracking(): Promise<BeginResult> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, message: S.permDeniedForeground };

  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) bg = await Location.requestBackgroundPermissionsAsync().catch(() => bg);

  await requestNotifications();

  store.setBlocked(null);
  store.setWanted(true);
  try {
    await startUpdates();
  } catch (e) {
    store.setWanted(false);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  flush(true).catch(() => undefined);
  return { ok: true, backgroundDenied: !bg.granted };
}

/** True when tracking can start without showing the disclosure (everything already granted). */
export async function permissionsReady(): Promise<boolean> {
  const [fg, bg] = await Promise.all([Location.getForegroundPermissionsAsync(), Location.getBackgroundPermissionsAsync()]);
  return fg.granted && bg.granted;
}
