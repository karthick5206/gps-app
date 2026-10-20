import * as Location from 'expo-location';
import { AppState, Platform } from 'react-native';
import type { TrackerConfig } from './api';
import { store } from './state';
import { S } from './strings';

export const LOCATION_TASK = 'veetrax-tracker-location';

const COLOR = '#0f766e';

function options(c: TrackerConfig): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: Math.max(1, c.intervalSec) * 1000,
    distanceInterval: Math.max(0, c.distanceM),
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: S.fgTitle,
      notificationBody: S.fgBody,
      notificationColor: COLOR,
      killServiceOnDestroy: false,
    },
  };
}

export async function isRunning(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

/** Starts (or restarts with new options) the background location updates. Permissions must already be granted. */
export async function startUpdates(): Promise<void> {
  if (Platform.OS === 'android') {
    // Ask for Google's high-accuracy mode (GPS + Wi-Fi + cell). The user can decline; tracking still works.
    await Location.enableNetworkProviderAsync().catch(() => undefined);
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK, options(store.config()));
  store.setPendingRestart(false);
}

export async function stopUpdates(): Promise<void> {
  if (await isRunning()) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
}

/** The user (or the server) switches tracking off. */
export async function stopTracking(): Promise<void> {
  store.setWanted(false);
  await stopUpdates();
}

/** Stores a config from the server; restarts location updates if the interval or distance changed. */
export async function applyConfig(next: TrackerConfig | undefined): Promise<void> {
  if (!next) return;
  const prev = store.config();
  store.setConfig(next);
  const changed = prev.intervalSec !== next.intervalSec || prev.distanceM !== next.distanceM;
  if (!changed || !store.wanted() || !(await isRunning())) return;
  // Android blocks (re)starting a foreground service from the background, so wait until the app is open.
  if (AppState.currentState === 'active') await startUpdates().catch(() => store.setPendingRestart(true));
  else store.setPendingRestart(true);
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
 * Called when the app opens: resumes tracking if it was on and stopped (e.g. after an update or force-stop),
 * and applies a pending restart. Needs foreground permission at least.
 */
export async function resumeIfWanted(): Promise<void> {
  if (!store.wanted() || store.blocked()) return;
  const perms = await readPermissions().catch(() => null);
  if (!perms?.foreground) return;
  if (!(await isRunning()) || store.pendingRestart()) await startUpdates().catch(() => undefined);
}
