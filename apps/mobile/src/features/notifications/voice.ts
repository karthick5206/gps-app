import { ALERT_TYPE_MAP, type AlertDto } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import * as Speech from 'expo-speech';
import { useSyncExternalStore } from 'react';
import { currentLocale, i18n } from '@/lib/i18n';

/**
 * Voice announcements: every new alert is read aloud through the speaker while the app is open (text-to-speech in the
 * app language). Saved on this phone.
 */
const KEY = 'vt.voiceAlerts';
const MAX_QUEUED = 3;
const listeners = new Set<() => void>();
let on = false;
let queued = 0;

export const voiceAlerts = {
  get: () => on,
  set(next: boolean) {
    if (next === on) return;
    on = next;
    SecureStore.setItemAsync(KEY, next ? '1' : '0').catch(() => undefined);
    listeners.forEach((l) => l());
    if (next) Speech.speak(i18n.t('Voice announcements are on'), { language: currentLocale() });
  },
  async restore() {
    try {
      on = (await SecureStore.getItemAsync(KEY)) === '1';
      listeners.forEach((l) => l());
    } catch {
      /* keystore unavailable: stays off */
    }
  },
};

export function useVoiceAlerts(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
  );
}

/** "Overspeed for TN 09 BB 9421. Speed 92 km/h …" (the server's message only in English). */
export function alertSpeech(a: Pick<AlertDto, 'type' | 'plateNumber' | 'objectName' | 'message'>): string {
  const label = i18n.t(ALERT_TYPE_MAP[a.type]?.label ?? a.type);
  const head = i18n.t('{{alert}} for {{vehicle}}', { alert: label, vehicle: a.plateNumber || a.objectName });
  return i18n.language.startsWith('en') ? `${head}. ${a.message}` : head;
}

/** Reads a new alert aloud when announcements are on (skipped when several are already waiting). */
export function announceAlert(a: AlertDto): void {
  if (!on || a.status !== 'NEW' || queued >= MAX_QUEUED) return;
  queued++;
  const done = () => {
    queued = Math.max(0, queued - 1);
  };
  Speech.speak(alertSpeech(a), { language: currentLocale(), rate: 1, onDone: done, onStopped: done, onError: done });
}
