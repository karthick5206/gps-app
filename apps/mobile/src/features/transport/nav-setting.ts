import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * "Open stops in a navigation app" (owner decision L6, OPEN). Off by default: under O9 no new external sharing of
 * passenger or driver location happens unless someone turns it on. When on, the driver trip screen offers a Navigate
 * button that hands only the stop coordinates and "Stop <n>" to the phone's chooser (`geo:` intent, nav-handoff.ts).
 * Stored per device; cleared to the default on a fresh install.
 */
const KEY = 'vt.driver.navHandoff';
let enabled = false;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const navHandoff = {
  get: () => enabled,
  async restore() {
    if (loaded) return;
    loaded = true;
    try {
      enabled = (await SecureStore.getItemAsync(KEY)) === '1';
      emit();
    } catch {
      /* keystore unavailable: keep the default (off) */
    }
  },
  set(next: boolean) {
    enabled = next;
    SecureStore.setItemAsync(KEY, next ? '1' : '0').catch(() => undefined);
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    void navHandoff.restore();
    return () => {
      listeners.delete(l);
    };
  },
};

export function useNavHandoff(): boolean {
  return useSyncExternalStore(navHandoff.subscribe, navHandoff.get);
}
