/** Pure formatting helpers (no imports so they can be unit-tested with node --test). */

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

type Translate = (key: string, vars?: Record<string, string | number>) => string;
/** English by default; lib/i18n plugs in i18next so the units follow the UI language. */
let t: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));
let locale: string | undefined;

export function setFormatTranslator(fn: Translate): void {
  t = fn;
}

/** Locale for dates and numbers (e.g. 'hi-IN'); undefined = browser default. */
export function setFormatLocale(value: string | undefined): void {
  locale = value;
}

/** Compact duration: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < MINUTE) return t('{{n}} s', { n: s });
  if (s < HOUR) return t('{{n}} min', { n: Math.floor(s / MINUTE) });
  if (s < DAY) {
    const h = Math.floor(s / HOUR);
    const m = Math.floor((s % HOUR) / MINUTE);
    return m ? t('{{h}} h {{m}} min', { h, m }) : t('{{h}} h', { h });
  }
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  return h ? t('{{d}} d {{h}} h', { d, h }) : t('{{d}} d', { d });
}

/** "Idle 12 min" style label; null when the status start is unknown. */
export function timeInStatus(label: string, since: string | null, now: number = Date.now()): string | null {
  if (!since) return null;
  const start = Date.parse(since);
  if (Number.isNaN(start)) return null;
  return `${label} ${formatDuration((now - start) / 1000)}`;
}

/** Relative time: "just now", "5 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const diff = Math.round((now - at) / 1000);
  // Small negative values come from clock skew between server and browser.
  if (diff < 5) return t('just now');
  // Coarse: only the largest unit ("3 h ago", not "3 h 5 min ago").
  const coarse = diff < HOUR || diff >= DAY ? formatDuration(diff - (diff >= DAY ? diff % DAY : 0)) : formatDuration(diff - (diff % HOUR));
  return t('{{time}} ago', { time: coarse });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatNumber(n: number): string {
  return n.toLocaleString(locale);
}

/** ENUM_VALUE → "Enum value". */
export function humanize(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch) => ch.toUpperCase());
}
