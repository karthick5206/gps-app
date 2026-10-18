import type { ThemePreference } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { Appearance } from 'react-native';

/**
 * Light / dark / system theme. The choice is the user's profile preference (shared with the web app); it is also kept
 * on the device so the right theme shows on the next launch before the profile loads.
 */
const KEY = 'vt.theme';

export function applyThemePreference(pref: ThemePreference): void {
  Appearance.setColorScheme(pref === 'system' ? 'unspecified' : pref);
  SecureStore.setItemAsync(KEY, pref).catch(() => undefined);
}

/** Applies the theme saved on the device (call once at startup). */
export async function restoreThemePreference(): Promise<void> {
  try {
    const saved = (await SecureStore.getItemAsync(KEY)) as ThemePreference | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') Appearance.setColorScheme(saved === 'system' ? 'unspecified' : saved);
  } catch {
    /* keystore unavailable: follow the system */
  }
}
