import { MOVEMENT_STATUSES, STATUS_META, type MovementStatus } from '@veetracer/shared';

/**
 * Text colour for a status label drawn on a 14 % tint of the status colour (StatusBadge). The marker colours in
 * STATUS_META are tuned for map markers and fail AA as text (2.3-4.4:1 in the light themes). These darker values
 * (07-design-system.md §9.2; OFF / OVERSPEED / OFFLINE as mobile STATUS_TEXT_LIGHT) reach 4.97-6.34:1 light and
 * 5.27-7.94:1 dark. Marker and dot colours are unchanged.
 */
export const STATUS_TEXT: Record<MovementStatus, { light: string; dark: string }> = {
  RUNNING: { light: '#166534', dark: '#22c55e' },
  IDLE: { light: '#9a5400', dark: '#fbbf24' },
  OFF: { light: '#b91c1c', dark: '#f87171' },
  OVERSPEED: { light: '#7e22ce', dark: '#c084fc' },
  OFFLINE: { light: '#4b5563', dark: '#9ca3af' },
  NO_DATA: { light: '#5b6676', dark: '#94a3b8' },
};

/** CSS custom property name for a status, e.g. NO_DATA → --status-nodata. */
export function statusVar(status: MovementStatus): string {
  return `--status-${status.toLowerCase().replace('_', '')}`;
}

/** Tailwind-friendly `var(--status-x)` reference for inline styles. */
export function statusColor(status: MovementStatus): string {
  return `var(${statusVar(status)})`;
}

/**
 * `var(--status-x-text)`: the colour for status text on its tint. Resolves to the AA text colour when the
 * uiRefresh flag is on (html[data-ui-refresh]); otherwise to the marker colour, exactly as before.
 */
export function statusTextColor(status: MovementStatus): string {
  return `var(${statusVar(status)}-text)`;
}

/**
 * Writes the --status-* tokens for :root and .dark from STATUS_META (single source of truth), plus
 * --status-*-fg (AA text colour) and --status-*-text (the one components read; flag-gated).
 */
export function injectStatusTokens(): void {
  const decl = (theme: 'light' | 'dark') =>
    MOVEMENT_STATUSES.map((s) => `${statusVar(s)}:${STATUS_META[s][theme]};${statusVar(s)}-fg:${STATUS_TEXT[s][theme]};`).join('');
  const text = (to: 'fg' | null) => MOVEMENT_STATUSES.map((s) => `${statusVar(s)}-text:var(${statusVar(s)}${to ? `-${to}` : ''});`).join('');
  const style = document.createElement('style');
  style.dataset.tokens = 'status';
  style.textContent = `:root{${decl('light')}${text(null)}}.dark{${decl('dark')}}:root[data-ui-refresh]{${text('fg')}}`;
  document.head.appendChild(style);
}
