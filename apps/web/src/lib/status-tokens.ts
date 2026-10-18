import { MOVEMENT_STATUSES, STATUS_META, type MovementStatus } from '@veetracer/shared';

/** CSS custom property name for a status, e.g. NO_DATA → --status-nodata. */
export function statusVar(status: MovementStatus): string {
  return `--status-${status.toLowerCase().replace('_', '')}`;
}

/** Tailwind-friendly `var(--status-x)` reference for inline styles. */
export function statusColor(status: MovementStatus): string {
  return `var(${statusVar(status)})`;
}

/** Writes the --status-* tokens for :root and .dark from STATUS_META (single source of truth). */
export function injectStatusTokens(): void {
  const decl = (theme: 'light' | 'dark') =>
    MOVEMENT_STATUSES.map((s) => `${statusVar(s)}:${STATUS_META[s][theme]};`).join('');
  const style = document.createElement('style');
  style.dataset.tokens = 'status';
  style.textContent = `:root{${decl('light')}}.dark{${decl('dark')}}`;
  document.head.appendChild(style);
}
