import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeAlarm {
  start(title: string, text: string, alertId: string): void;
  stop(): void;
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
