import { DEFAULT_THEME, normalizeTheme, STATUS_META, themeScheme, type MovementStatus, type ThemePreference } from '@veetracer/shared';
import { useSyncExternalStore } from 'react';

/**
 * Colour themes, the same as the web app (apps/web/src/index.css; ids and labels: THEMES in @veetracer/shared):
 * Teal & Saffron (default), Plum & Pink, Sky & Cobalt, Light and Dark.
 */
const status = { destructive: '#dc2626', warning: '#d97706', success: '#16a34a', info: '#2563eb' };
/**
 * Soft status pairs (tinted background + readable text) for chips, badges and icon tiles on light themes.
 * `neutral` is for "nothing to report" chips (Off, closed, inactive).
 */
const soft = {
  successSoft: '#e3f4ea',
  successText: '#17683a',
  warningSoft: '#fdf3dc',
  warningText: '#8a5300',
  destructiveSoft: '#fdecea',
  destructiveText: '#a8261a',
  infoSoft: '#e6eefc',
  infoText: '#1d4ed8',
  neutralSoft: '#eef1f4',
  neutralText: '#4a5763',
};

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
  ...soft,
  border: '#dce6e3',
  /** Header band ("Enterprise" look): background, text, secondary text, inset fields / pills on the band. */
  brand: '#0b3b36',
  brandForeground: '#ffffff',
  brandMuted: '#cfe3df',
  brandSubtle: 'rgba(255,255,255,0.12)',
  brandAccent: '#ffb443',
  /** Active tab icon / label in the white tab bar. */
  navActive: '#0b3b36',
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
  ...soft,
  border: '#e7ddec',
  brand: '#3e1052',
  brandForeground: '#ffffff',
  brandMuted: '#e6d2ef',
  brandSubtle: 'rgba(255,255,255,0.12)',
  brandAccent: '#ff9ecf',
  navActive: '#3e1052',
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
  ...soft,
  border: '#dce4f5',
  brand: '#eaf1ff',
  brandForeground: '#10183a',
  brandMuted: '#55607f',
  brandSubtle: 'rgba(16,24,58,0.07)',
  brandAccent: '#ff6b4a',
  navActive: '#1f4fff',
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
  ...soft,
  border: '#e3e5e8',
  brand: '#ffffff',
  brandForeground: '#17181c',
  brandMuted: '#5e6370',
  brandSubtle: '#f2f3f5',
  brandAccent: '#ffb443',
  navActive: '#0e5e57',
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
  successSoft: 'rgba(34,197,94,0.16)',
  successText: '#4ade80',
  warningSoft: 'rgba(251,191,36,0.16)',
  warningText: '#fcd34d',
  destructiveSoft: 'rgba(239,68,68,0.18)',
  destructiveText: '#fca5a5',
  infoSoft: 'rgba(96,165,250,0.16)',
  infoText: '#93c5fd',
  neutralSoft: '#16283b',
  neutralText: '#b6c4d2',
  border: '#1c2e42',
  brand: '#06101a',
  brandForeground: '#ffffff',
  brandMuted: '#8b9fb3',
  brandSubtle: 'rgba(255,255,255,0.08)',
  brandAccent: '#ffb443',
  navActive: '#2bb3a3',
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

/** Darker status text for tinted chips on light themes (the STATUS_META colours are too light for small text). */
const STATUS_TEXT_LIGHT: Record<MovementStatus, string> = {
  RUNNING: '#15803d',
  IDLE: '#a35a00',
  OFF: '#b91c1c',
  OVERSPEED: '#7e22ce',
  OFFLINE: '#4b5563',
  NO_DATA: '#64748b',
};

/** Status colour (dot / marker), soft tint (chip background) and readable text colour for a status chip. */
export function statusTone(status: MovementStatus, scheme: Scheme): { color: string; soft: string; text: string } {
  const color = STATUS_META[status][scheme];
  return { color, soft: `${color}${scheme === 'dark' ? '2e' : '1f'}`, text: scheme === 'dark' ? color : STATUS_TEXT_LIGHT[status] };
}

export type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'brand';

/** Soft background + text pair for a tone (chips, badges, icon tiles). */
export function toneColors(c: Colors, tone: Tone): { soft: string; text: string; solid: string } {
  switch (tone) {
    case 'success':
      return { soft: c.successSoft, text: c.successText, solid: c.success };
    case 'warning':
      return { soft: c.warningSoft, text: c.warningText, solid: c.warning };
    case 'destructive':
      return { soft: c.destructiveSoft, text: c.destructiveText, solid: c.destructive };
    case 'info':
      return { soft: c.infoSoft, text: c.infoText, solid: c.info };
    case 'brand':
      return { soft: c.accent, text: c.accentForeground, solid: c.primary };
    default:
      return { soft: c.neutralSoft, text: c.neutralText, solid: c.mutedForeground };
  }
}

/** Status bar icons over the header band: dark on the light bands of Sky and Light, light everywhere else. */
export function useBrandBarStyle(): 'light' | 'dark' {
  const theme = useTheme();
  return theme === 'sky' || theme === 'light' ? 'dark' : 'light';
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const RADIUS = { sm: 8, md: 12, lg: 16, full: 999 } as const;
