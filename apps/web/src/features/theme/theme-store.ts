import { normalizeTheme, themeScheme, type ThemePreference } from '@veetracer/shared';
import { storage, STORAGE_KEYS } from '@/lib/storage';

export type ResolvedTheme = 'light' | 'dark';

/**
 * Colour theme outside React so non-React code (the map) can subscribe too. The theme id goes on <html data-theme>
 * (palette tokens in index.css); `resolved` is its light / dark scheme (map styles, the `dark` class).
 */
type Listener = () => void;
const listeners = new Set<Listener>();

let preference: ThemePreference = normalizeTheme(storage.get(STORAGE_KEYS.theme));
let resolved: ResolvedTheme = themeScheme(preference);

function apply() {
  resolved = themeScheme(preference);
  const root = document.documentElement;
  root.dataset.theme = preference;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

export const themeStore = {
  getPreference: () => preference,
  getResolved: () => resolved,
  setPreference(pref: ThemePreference) {
    const next = normalizeTheme(pref);
    if (next === preference) return;
    preference = next;
    storage.set(STORAGE_KEYS.theme, next);
    apply();
    listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

apply();
