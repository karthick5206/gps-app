import * as Battery from 'expo-battery';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

export const PACKAGE = Constants.expoConfig?.android?.package ?? 'com.sasvata.veetrax.tracker';
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

export function deviceName(): string {
  const name = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ');
  return name || Device.deviceName || 'Phone';
}

/** True when Android battery optimisation applies to this app (tracking may be throttled or killed). */
export async function batteryOptimised(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  return Battery.isBatteryOptimizationEnabledAsync().catch(() => false);
}

/** Opens the system dialog to exempt this app, or the battery-optimisation list if the dialog is unavailable. */
export async function openBatterySettings(): Promise<void> {
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, {
      data: `package:${PACKAGE}`,
    });
  } catch {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS).catch(() => undefined);
  }
}

/** Android 13+ needs POST_NOTIFICATIONS for the tracking notification to be visible. */
export async function notificationsGranted(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => false);
}

export async function requestNotifications(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => null);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

export function openAppSettings(): void {
  Linking.openSettings().catch(() => undefined);
}
