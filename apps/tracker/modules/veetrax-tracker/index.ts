import { requireOptionalNativeModule } from 'expo';

/**
 * JS API of the native tracking engine (Android foreground service; see android/…/trackerengine).
 * Tracking, the queue and uploads run natively, also when the JS app is not running.
 */

export interface NativeTrackerConfig {
  intervalSec: number;
  stoppedIntervalSec: number;
  distanceM: number;
  maxAccuracyM: number;
  batchMax: number;
}

/** Why tracking stopped on its own (null after a user Stop). */
export type StopReason = 'REVOKED' | 'INVALID' | 'INACTIVE' | null;

export interface TrackerStatus {
  running: boolean;
  wanted: boolean;
  hasToken: boolean;
  serverUrl: string;
  /** "moving" = high-accuracy GPS; "stationary" = low-power heartbeat mode. */
  mode: 'moving' | 'stationary';
  lastFixAt: number | null;
  lastAcc: number | null;
  lastSpd: number | null;
  lastAcceptedAt: number | null;
  lastUploadAt: number | null;
  lastError: string | null;
  failures: number;
  backoffUntil: number | null;
  queueSize: number;
  mockCount: number;
  droppedCount: number;
  stopReason: StopReason;
  config: NativeTrackerConfig;
}

export type StartResult = 'started' | 'no_token' | 'no_permission' | (string & {});
export type SosResult = 'sent' | 'queued' | 'rejected' | 'no_location' | 'no_token' | 'stopped' | 'unavailable';

interface NativeModuleShape {
  start(token: string, serverUrl: string | null, config: Partial<NativeTrackerConfig> | null): Promise<StartResult>;
  stop(): Promise<boolean>;
  isRunning(): boolean;
  getStatus(): Promise<TrackerStatus>;
  setConfig(config: Partial<NativeTrackerConfig>): Promise<boolean>;
  setCredentials(token: string, serverUrl: string | null): Promise<boolean>;
  sendSos(): Promise<SosResult>;
  flush(): Promise<boolean>;
  resetStopReason(): Promise<boolean>;
  clear(): Promise<boolean>;
  openAutostartSettings(): Promise<'oem' | 'app_details' | 'none'>;
  hasOemAutostart(): boolean;
  manufacturer(): string;
  takeCrash(): string | null;
  deviceInfo(): DeviceInfo;
  installId(): string;
  savedToken(): string;
}

export interface DeviceInfo {
  manufacturer: string;
  model: string;
  android: string;
  sdk: number;
}

/** Null on platforms without the native module (iOS / web for now). */
const Native = requireOptionalNativeModule<NativeModuleShape>('VeetraxTracker');

export const isAvailable = Native != null;

const unavailable = () => new Error('VeeTrax tracker engine is only available on Android');

export function start(token: string, serverUrl: string, config?: Partial<NativeTrackerConfig>): Promise<StartResult> {
  return Native ? Native.start(token, serverUrl, config ?? null) : Promise.reject(unavailable());
}

export function stop(): Promise<boolean> {
  return Native ? Native.stop() : Promise.resolve(false);
}

export function isRunning(): boolean {
  return Native ? Native.isRunning() : false;
}

export function getStatus(): Promise<TrackerStatus | null> {
  return Native ? Native.getStatus() : Promise.resolve(null);
}

export function setConfig(config: Partial<NativeTrackerConfig>): Promise<boolean> {
  return Native ? Native.setConfig(config) : Promise.resolve(false);
}

export function setCredentials(token: string, serverUrl: string): Promise<boolean> {
  return Native ? Native.setCredentials(token, serverUrl) : Promise.resolve(false);
}

export function sendSos(): Promise<SosResult> {
  return Native ? Native.sendSos() : Promise.resolve('unavailable');
}

export function flush(): Promise<boolean> {
  return Native ? Native.flush() : Promise.resolve(false);
}

export function resetStopReason(): Promise<boolean> {
  return Native ? Native.resetStopReason() : Promise.resolve(false);
}

export function clear(): Promise<boolean> {
  return Native ? Native.clear() : Promise.resolve(false);
}

export function openAutostartSettings(): Promise<'oem' | 'app_details' | 'none'> {
  return Native ? Native.openAutostartSettings() : Promise.resolve('none');
}

export function hasOemAutostart(): boolean {
  return Native ? Native.hasOemAutostart() : false;
}

export function manufacturer(): string {
  return Native ? Native.manufacturer() : '';
}

/** The last native crash (stack trace) saved by CrashLog, cleared once read. */
export function takeCrash(): string | null {
  try {
    return Native ? Native.takeCrash() : null;
  } catch {
    return null;
  }
}

/** Android ID for this app on this phone (stable across updates and reinstalls), or '' when unavailable. */
export function installId(): string {
  try {
    return Native ? Native.installId() : '';
  } catch {
    return '';
  }
}

/** The token held by the native engine, or '' (used when the app's own copy was lost). */
export function savedToken(): string {
  try {
    return Native ? Native.savedToken() : '';
  } catch {
    return '';
  }
}

export function deviceInfo(): DeviceInfo | null {
  try {
    return Native ? Native.deviceInfo() : null;
  } catch {
    return null;
  }
}
