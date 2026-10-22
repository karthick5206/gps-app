import { Platform } from 'react-native';
import { api } from './api';
import { kvGet, kvSet } from './db';
import { APP_VERSION } from './device';
import { Tracker } from './tracking';

/**
 * Crash reports: the native engine saves its own crashes (CrashLog.kt); JS errors that reach the global
 * handler are saved here. On the next start both are sent to the server once, so a crash on a customer's
 * phone can be diagnosed without adb.
 */

const KEY = 'jsCrash';

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsShape {
  getGlobalHandler(): ErrorHandler;
  setGlobalHandler(handler: ErrorHandler): void;
}

export function installJsCrashHandler(): void {
  const eu = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!eu) return;
  const previous = eu.getGlobalHandler();
  eu.setGlobalHandler((error, isFatal) => {
    try {
      const e = error instanceof Error ? error : new Error(String(error));
      kvSet(KEY, `${isFatal ? 'FATAL ' : ''}${e.name}: ${e.message}\n${e.stack ?? ''}`.slice(0, 8000));
    } catch {
      // storage unavailable: nothing more we can do
    }
    previous(error, isFatal);
  });
}

/** Sends a pending native / JS crash report. True when there was one (the screen can say so). */
export async function reportCrashes(): Promise<boolean> {
  const native = Tracker.takeCrash();
  let js: string | null = null;
  try {
    js = kvGet<string | null>(KEY, null);
    if (js) kvSet(KEY, null);
  } catch {
    js = null;
  }
  if (!native && !js) return false;
  const info = Tracker.deviceInfo();
  await api
    .diagnostics({
      appVersion: APP_VERSION,
      platform: Platform.OS,
      device: info ? `${info.manufacturer} ${info.model} (Android ${info.android}, SDK ${info.sdk})` : String(Platform.Version),
      nativeCrash: native,
      jsCrash: js,
    })
    .catch(() => undefined);
  return true;
}
