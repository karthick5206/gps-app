import { DEFAULT_THEME, normalizeTheme, STATUS_META, themeScheme, type MovementStatus, type ThemePreference } from '@veetracer/shared';
import { useSyncExternalStore } from 'react';

/**
 * Colour themes, the same as the web app (apps/web/src/index.css; ids and labels: THEMES in @veetracer/shared):
 * Teal & Saffron (default), Plum & Pink, Sky & Cobalt, Light and Dark.
 */
const status = { destructive: '#dc2626', warning: '#d97706', success: '#16a34a', info: '#2563eb' };

const teal = {
  background: '#f5f8f7',
  foreground: '#0f1d1b',
  card: '#ffffff',
  primary: '#0e5e57',
  primaryForeground: '#ffffff',
  muted: '#eff4f3',
  mutedForeground: '#566966',
  accent: '#e3f1ee',
  accentForeground: '#0b3b36',
  ...status,
  border: '#dce6e3',
  brand: '#0b3b36',
  brandForeground: '#ffffff',
  brandAccent: '#ffb443',
};

type ColorsShape = typeof teal;

const plum: ColorsShape = {
  background: '#f8f5fa',
  foreground: '#1e1225',
  card: '#ffffff',
  primary: '#5b1e78',
  primaryForeground: '#ffffff',
  muted: '#f3eef6',
  mutedForeground: '#6a5a73',
  accent: '#f1e4f7',
  accentForeground: '#3e1052',
  ...status,
  border: '#e7ddec',
  brand: '#3e1052',
  brandForeground: '#ffffff',
  brandAccent: '#ff9ecf',
};

const sky: ColorsShape = {
  background: '#f3f7ff',
  foreground: '#10183a',
  card: '#ffffff',
  primary: '#1f4fff',
  primaryForeground: '#ffffff',
  muted: '#edf2fd',
  mutedForeground: '#55607f',
  accent: '#e3ecff',
  accentForeground: '#10183a',
  ...status,
  border: '#dce4f5',
  brand: '#eaf1ff',
  brandForeground: '#10183a',
  brandAccent: '#ff6b4a',
};

const light: ColorsShape = {
  background: '#f7f7f8',
  foreground: '#17181c',
  card: '#ffffff',
  primary: '#0e5e57',
  primaryForeground: '#ffffff',
  muted: '#f2f3f5',
  mutedForeground: '#5e6370',
  accent: '#eef0f2',
  accentForeground: '#17181c',
  ...status,
  border: '#e3e5e8',
  brand: '#ffffff',
  brandForeground: '#17181c',
  brandAccent: '#ffb443',
};

const dark: ColorsShape = {
  background: '#08121d',
  foreground: '#e3ebf2',
  card: '#0d1a28',
  primary: '#2bb3a3',
  primaryForeground: '#04201e',
  muted: '#122133',
  mutedForeground: '#8b9fb3',
  accent: '#10303a',
  accentForeground: '#e3ebf2',
  destructive: '#ef4444',
  warning: '#fbbf24',
  success: '#22c55e',
  info: '#60a5fa',
  border: '#1c2e42',
  brand: '#06101a',
  brandForeground: '#ffffff',
  brandAccent: '#ffb443',
};

export type Colors = ColorsShape;
export type Scheme = 'light' | 'dark';

export const COLORS: Record<ThemePreference, Colors> = { teal, plum, sky, light, dark };

// Current theme (outside React so startup code can set it before the first render).
type Listener = () => void;
const listeners = new Set<Listener>();
let current: ThemePreference = DEFAULT_THEME;

export const themeState = {
  get: () => current,
  set(next: unknown) {
    const theme = normalizeTheme(next);
    if (theme === current) return;
    current = theme;
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useTheme(): ThemePreference {
  return useSyncExternalStore(themeState.subscribe, themeState.get);
}

export function useScheme(): Scheme {
  return themeScheme(useTheme());
}

export function useColors(): Colors {
  return COLORS[useTheme()];
}

export function statusColor(status: MovementStatus, scheme: Scheme): string {
  return STATUS_META[status][scheme];
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const RADIUS = { sm: 8, md: 12, lg: 16, full: 999 } as const;
