import { BRAND_COLORS, brandTileSvg, normalizeTheme, themeScheme, type ThemePreference } from '@veetracer/shared';
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
  applyBrandIcon();
}

/** Browser-tab icon and browser UI colour in the theme's logo colours. */
function applyBrandIcon() {
  const colors = BRAND_COLORS[preference];
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!icon) {
    icon = document.createElement('link');
    icon.rel = 'icon';
    icon.type = 'image/svg+xml';
    document.head.appendChild(icon);
  }
  icon.href = `data:image/svg+xml,${encodeURIComponent(brandTileSvg(colors))}`;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', colors.tile);
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
