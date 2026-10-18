import { normalizeTheme, themeScheme, type ThemePreference } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { Appearance } from 'react-native';
import { themeState } from '@/lib/theme';

/**
 * Colour theme (Teal & Saffron, Plum & Pink, Sky & Cobalt, Light, Dark). The choice is the user's profile preference
 * (shared with the web app); it is also kept on the device so the right theme shows on the next launch before the
 * profile loads. Native views (keyboard, pickers) follow the theme's light / dark scheme.
 */
const KEY = 'vt.theme';

function apply(theme: ThemePreference): void {
  themeState.set(theme);
  Appearance.setColorScheme(themeScheme(theme));
}

export function applyThemePreference(pref: ThemePreference): void {
  const theme = normalizeTheme(pref);
  apply(theme);
  SecureStore.setItemAsync(KEY, theme).catch(() => undefined);
}

/** Applies the theme saved on the device (call once at startup). */
export async function restoreThemePreference(): Promise<void> {
  try {
    apply(normalizeTheme(await SecureStore.getItemAsync(KEY)));
  } catch {
    apply(normalizeTheme(null));
  }
}
