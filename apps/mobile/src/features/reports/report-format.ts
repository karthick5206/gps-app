/** Pure formatting helpers for reports (no imports so they can be unit-tested with node --test). */

/** Seconds → "hh:mm" (hours may exceed 24, e.g. "49:05"); null/negative → "—" / "00:00". */
export function formatHm(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
  const mins = Math.max(0, Math.round(totalSeconds / 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday (UTC date) of ISO week `week` in ISO year `year`. */
export function isoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  return monday;
}

function dm(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * Human label for a report period key:
 * "2026-10-18" → "18 Oct 2026", "2026-W42" → "Week 42 · 12–18 Oct 2026", "2026-10" → "Oct 2026".
 * Unknown shapes are returned unchanged.
 */
export function periodLabel(period: string): string {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  m = /^(\d{4})-W(\d{1,2})$/.exec(period);
  if (m) {
    const year = Number(m[1]);
    const week = Number(m[2]);
    const mon = isoWeekMonday(year, week);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const range = mon.getUTCMonth() === sun.getUTCMonth() ? `${mon.getUTCDate()}–${dm(sun)}` : `${dm(mon)} – ${dm(sun)}`;
    return `Week ${week} · ${range} ${sun.getUTCFullYear()}`;
  }
  m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return period;
}

/** Short axis label: "18 Oct", "W42", "Oct 26". */
export function periodShortLabel(period: string): string {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  m = /^(\d{4})-W(\d{1,2})$/.exec(period);
  if (m) return `W${Number(m[2])}`;
  m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  return period;
}

/** YYYY-MM-DD of a local date. */
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inclusive day count between two YYYY-MM-DD strings (NaN on invalid input). */
export function daySpan(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Splits pasted text on commas, semicolons and whitespace into trimmed, lower-cased, de-duplicated tokens. */
export function splitRecipients(text: string, existing: readonly string[] = []): { added: string[]; invalid: string[] } {
  const seen = new Set(existing.map((e) => e.toLowerCase()));
  const added: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (!isEmail(token)) invalid.push(token);
    else if (!seen.has(token)) {
      seen.add(token);
      added.push(token);
    }
  }
  return { added, invalid };
}
