/**
 * SMS length accounting (no imports: node --test friendly).
 * GSM 03.38 7-bit: 160 chars single / 153 per part; extension-table chars (^{}\[~]|€ and form feed) cost 2 septets.
 * Anything outside GSM forces UCS-2: 70 single / 67 per part, counted in UTF-16 code units (emoji = 2).
 */

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '\f^{}\\[~]|€';

const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENDED = new Set(Array.from(GSM_EXTENDED));

export type SmsEncoding = 'GSM-7' | 'UNICODE';

export interface SmsCount {
  encoding: SmsEncoding;
  /** Units used: septets for GSM-7, UTF-16 code units for Unicode. */
  units: number;
  /** Visible characters (code points). */
  chars: number;
  parts: number;
  /** Capacity of one part for this message (160/153 or 70/67). */
  perPart: number;
  /** Units left before another part is needed. */
  remaining: number;
  /** Characters that forced Unicode (first few, deduplicated). */
  unicodeChars: string[];
}

export function isGsmChar(ch: string): boolean {
  return BASIC.has(ch) || EXTENDED.has(ch);
}

export function countSms(text: string): SmsCount {
  const chars = Array.from(text);
  const nonGsm: string[] = [];
  let septets = 0;
  for (const ch of chars) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXTENDED.has(ch)) septets += 2;
    else if (!nonGsm.includes(ch) && nonGsm.length < 8) nonGsm.push(ch);
  }
  // Any non-GSM character switches the whole message to UCS-2.
  const unicode = chars.some((ch) => !isGsmChar(ch));
  if (unicode) {
    const units = text.length; // UTF-16 code units
    const single = 70;
    const multi = 67;
    const parts = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
    const perPart = parts <= 1 ? single : multi;
    const capacity = parts <= 1 ? single : parts * multi;
    return { encoding: 'UNICODE', units, chars: chars.length, parts, perPart, remaining: capacity - units, unicodeChars: nonGsm };
  }
  const single = 160;
  const multi = 153;
  const parts = septets === 0 ? 0 : septets <= single ? 1 : partsWithEscapes(chars, multi);
  const perPart = parts <= 1 ? single : multi;
  const capacity = parts <= 1 ? single : parts * multi;
  return { encoding: 'GSM-7', units: septets, chars: chars.length, parts, perPart, remaining: Math.max(0, capacity - septets), unicodeChars: [] };
}

/** Concatenated GSM parts: an escape pair (ESC + char) must not be split across parts, so pack greedily. */
function partsWithEscapes(chars: string[], perPart: number): number {
  let parts = 1;
  let used = 0;
  for (const ch of chars) {
    const cost = EXTENDED.has(ch) ? 2 : 1;
    if (used + cost > perPart) {
      parts++;
      used = 0;
    }
    used += cost;
  }
  return parts;
}

/** DLT text: every `{{name}}` placeholder becomes a positional `{#var#}` slot; returns the slot order too. */
export function toDltText(body: string): { text: string; variables: string[] } {
  const variables: string[] = [];
  const text = body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    variables.push(name);
    return '{#var#}';
  });
  return { text, variables };
}

/** Placeholder names used in a template body/subject. */
export function extractPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) out.add(m[1]);
  return Array.from(out);
}

/** Inserts `{{name}}` at the selection of a textarea value; returns the new value and caret position. */
export function insertAt(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  return { value: value.slice(0, s) + insert + value.slice(e), caret: s + insert.length };
}
