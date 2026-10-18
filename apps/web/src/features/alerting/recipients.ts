/** Recipient entry validation (no runtime imports: node --test friendly). */
import type { RecipientEntry, RecipientMode } from '@veetracer/shared';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

/**
 * Normalises an Indian mobile to "+91XXXXXXXXXX". Accepts "98765 43210", "09876543210", "919876543210", "+91-98765-43210".
 * Returns null when it isn't a valid 10-digit mobile starting with 6–9.
 */
export function normalizeMobile(v: string): string | null {
  let digits = v.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

export function entryKey(e: RecipientEntry): string {
  return `${e.kind}:${e.kind === 'EMAIL' ? e.value.trim().toLowerCase() : e.value}`;
}

/** Removes duplicates (emails case-insensitive), keeping the first occurrence. */
export function dedupeEntries(entries: RecipientEntry[]): RecipientEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const k = entryKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Parses free text (comma/semicolon/newline separated) into EMAIL/MOBILE entries plus the tokens that were invalid. */
export function parseContacts(text: string, kind: 'EMAIL' | 'MOBILE'): { entries: RecipientEntry[]; invalid: string[] } {
  const entries: RecipientEntry[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (kind === 'EMAIL') {
      if (isEmail(t)) entries.push({ kind: 'EMAIL', value: t.toLowerCase() });
      else invalid.push(t);
    } else {
      const m = normalizeMobile(t);
      if (m) entries.push({ kind: 'MOBILE', value: m });
      else invalid.push(t);
    }
  }
  return { entries: dedupeEntries(entries), invalid };
}

export const MODE_LABEL: Record<RecipientMode, string> = {
  DEFAULT: 'Use default list',
  ADD: 'Default + additional',
  ONLY: 'Only this list',
  NONE: 'None',
};

/** Whether entries are meaningful for the mode (DEFAULT and NONE ignore entries). */
export function modeUsesEntries(mode: RecipientMode): boolean {
  return mode === 'ADD' || mode === 'ONLY';
}
