/** Pure helpers for the inventory and SIM pages (no imports so node --test can run them). */

/** 149900 → "₹1,499.00"; null / undefined → "—". */
export function formatRupees(paise: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return '—';
  const rupees = paise / 100;
  if (opts.compact && Math.abs(rupees) >= 100_000) {
    const lakh = rupees / 100_000;
    return `₹${lakh >= 100 ? `${(lakh / 100).toFixed(2)} Cr` : `${lakh.toFixed(2)} L`}`;
  }
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Rupees text ("1499", "1,499.50", "₹1499") → paise; null when blank; NaN when invalid. */
export function rupeesToPaise(text: string | null | undefined): number | null {
  const t = (text ?? '').replace(/[₹,\s]/g, '');
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/**
 * IMEIs pasted into the receive dialog: split on new lines, commas, semicolons, tabs or spaces; keeps the first
 * occurrence of each and reports repeats and values that are not 4–32 letters / digits / "-" / "_".
 */
export function parseImeiList(text: string): { imeis: string[]; duplicates: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const imeis: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim();
    if (!v) continue;
    if (!/^[0-9A-Za-z_-]{4,32}$/.test(v)) {
      invalid.push(v);
      continue;
    }
    const key = v.toLowerCase();
    if (seen.has(key)) duplicates.push(v);
    else {
      seen.add(key);
      imeis.push(v);
    }
  }
  return { imeis, duplicates, invalid };
}

/** Upper bound for a bar chart axis: 1, 2, 5 × 10^n at or above the max (min 1). */
export function chartMax(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-09" → "9 Nov". */
export function shortDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}`.trim();
}

/** Share of a total as a whole percentage ("0%" for an empty total). */
export function percent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
}

/** Days left until a YYYY-MM-DD date (negative = overdue), from `now` (UTC calendar days). */
export function daysLeft(date: string | null | undefined, now: Date = new Date()): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const d = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((d - today) / 86_400_000);
}

/** "in 5 days" / "today" / "3 days overdue". */
export function renewalText(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'today';
  if (days > 0) return days === 1 ? 'in 1 day' : `in ${days} days`;
  return days === -1 ? '1 day overdue' : `${-days} days overdue`;
}
