import { STATUS_META, type MovementStatus } from '@veetracer/shared';
import { useColorScheme } from 'react-native';

/** Same design tokens as the web app (apps/web/src/index.css). */
const light = {
  background: '#f6f8fa',
  foreground: '#0f1d2b',
  card: '#ffffff',
  primary: '#0f766e',
  primaryForeground: '#ffffff',
  muted: '#f1f5f9',
  mutedForeground: '#5a6b7d',
  accent: '#e7f5f3',
  accentForeground: '#0b3b5a',
  destructive: '#dc2626',
  warning: '#d97706',
  success: '#16a34a',
  info: '#2563eb',
  border: '#e2e8f0',
  brand: '#0b2e46',
  brandForeground: '#ffffff',
  brandAccent: '#2dd4bf',
};

const dark: typeof light = {
  background: '#08121d',
  foreground: '#e3ebf2',
  card: '#0d1a28',
  primary: '#14b8a6',
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
  brandAccent: '#2dd4bf',
};

export type Colors = typeof light;
export type Scheme = 'light' | 'dark';

export const COLORS: Record<Scheme, Colors> = { light, dark };

export function useScheme(): Scheme {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

export function useColors(): Colors {
  return COLORS[useScheme()];
}

export function statusColor(status: MovementStatus, scheme: Scheme): string {
  return STATUS_META[status][scheme];
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const RADIUS = { sm: 8, md: 12, lg: 16, full: 999 } as const;
