import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeAlarm {
  start(title: string, text: string, alertId: string): void;
  stop(): void;
  canFullScreen?(): boolean;
  openFullScreenSettings?(): void;
  ringingAlertId?(): string | null;
}

// Null on iOS and in Expo Go: the normal notification sound and the SOS screen still work there.
const Native = requireOptionalNativeModule<NativeAlarm>('VeetraxAlarm');

/** Starts the looping alarm (the push service does this by itself for emergency pushes). */
export function startAlarm(title: string, text: string, alertId: string): void {
  Native?.start(title, text, alertId);
}

export function stopAlarm(): void {
  Native?.stop();
}

/** Android 14+: whether the SOS screen may open over the lock screen. True where it doesn't apply (iOS, older Android). */
export function canUseFullScreen(): boolean {
  return Native?.canFullScreen?.() ?? true;
}

/** Opens the Android setting that allows full-screen SOS alerts for VeeTrax. */
export function openFullScreenSettings(): void {
  Native?.openFullScreenSettings?.();
}

/** The alert whose alarm is ringing now (to open its SOS screen when the app comes forward), or null. */
export function ringingAlertId(): string | null {
  return Native?.ringingAlertId?.() ?? null;
}
