import type { ThemePreference } from '@veetracer/shared';
import { storage, STORAGE_KEYS } from '@/lib/storage';

export type ResolvedTheme = 'light' | 'dark';

/** Theme state outside React so non-React code (the map) can subscribe too. */
type Listener = () => void;
const listeners = new Set<Listener>();
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPreference(): ThemePreference {
  const v = storage.get(STORAGE_KEYS.theme);
  return v === 'light' || v === 'dark' ? v : 'system';
}

let preference: ThemePreference = readPreference();
let resolved: ResolvedTheme = resolve(preference);

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

function apply() {
  const next = resolve(preference);
  const changed = next !== resolved;
  resolved = next;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  return changed;
}

media.addEventListener('change', () => {
  if (preference === 'system' && apply()) listeners.forEach((l) => l());
});

export const themeStore = {
  getPreference: () => preference,
  getResolved: () => resolved,
  setPreference(pref: ThemePreference) {
    if (pref === preference) return;
    preference = pref;
    storage.set(STORAGE_KEYS.theme, pref);
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
