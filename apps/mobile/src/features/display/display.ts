import { DISPLAY_SIZES, MAP_ICON_SCALE, TEXT_SCALE, type DisplaySize } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * Readability settings: text size (multiplies the app's font sizes, on top of the phone's own font setting) and
 * map icon size. Saved on the device and in the profile (shared with the web app).
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const KEYS = { text: 'vt.textSize', icons: 'vt.mapIconSize' } as const;
let state: { textSize: DisplaySize; mapIconSize: DisplaySize } = { textSize: 'normal', mapIconSize: 'normal' };

const valid = (v: unknown): v is DisplaySize => DISPLAY_SIZES.includes(v as DisplaySize);

export const display = {
  get: () => state,
  set(next: { textSize?: DisplaySize; mapIconSize?: DisplaySize }) {
    const merged = { textSize: next.textSize ?? state.textSize, mapIconSize: next.mapIconSize ?? state.mapIconSize };
    if (merged.textSize === state.textSize && merged.mapIconSize === state.mapIconSize) return;
    state = merged;
    SecureStore.setItemAsync(KEYS.text, merged.textSize).catch(() => undefined);
    SecureStore.setItemAsync(KEYS.icons, merged.mapIconSize).catch(() => undefined);
    listeners.forEach((l) => l());
  },
  async restore() {
    try {
      const [t, i] = await Promise.all([SecureStore.getItemAsync(KEYS.text), SecureStore.getItemAsync(KEYS.icons)]);
      display.set({ textSize: valid(t) ? t : undefined, mapIconSize: valid(i) ? i : undefined });
    } catch {
      /* keystore unavailable: defaults */
    }
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useDisplay() {
  const s = useSyncExternalStore(display.subscribe, display.get);
  return { ...s, textScale: TEXT_SCALE[s.textSize], iconScale: MAP_ICON_SCALE[s.mapIconSize] };
}
