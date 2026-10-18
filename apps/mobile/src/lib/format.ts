/** Formatting helpers. Words go through i18n; units (s, min, h, d) stay as they are. */
import { i18n } from '@/lib/i18n';

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** Compact duration: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < MINUTE) return `${s} s`;
  if (s < HOUR) return `${Math.floor(s / MINUTE)} min`;
  if (s < DAY) {
    const h = Math.floor(s / HOUR);
    const m = Math.floor((s % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "Idle 12 min" style label; null when the status start is unknown. */
export function timeInStatus(label: string, since: string | null, now: number = Date.now()): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return null;
  return `${label} ${formatDuration((now - t) / 1000)}`;
}

/** Relative time: "just now", "5 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((now - t) / 1000);
  // Small negative values come from clock skew between server and browser.
  if (diff < 5) return i18n.t('just now');
  return i18n.t('{{d}} ago', { d: formatDuration(diff).replace(/ \d+ (min|h)$/, '') });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** ENUM_VALUE → "Enum value". */
export function humanize(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch) => ch.toUpperCase());
}
