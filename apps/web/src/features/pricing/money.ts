/**
 * Money display for the Pricing area (doc 19 §5.1). The API sends money as INTEGER STRINGS of minor units of the row's
 * currency ("123450" INR = ₹1,234.50). Everything here works on strings / bigint: no value is ever turned into a float,
 * so a total shown on screen is exactly the total the server stored.
 *
 * Pure module (no React, no DOM): unit-tested with node --test.
 */
import { CURRENCY_EXPONENTS, parseMajorToMinor } from '@veetracer/shared';

const INT = /^-?\d+$/;

/** Exponent of a currency, or null when the engine does not know it (e.g. 'XXX' on a snapshot without a contract). */
export function exponentOf(currency: string): number | null {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : null;
}

/** "123450" INR → { neg: false, int: "1234", frac: "50" }; null for anything that is not an integer string. */
export function splitMinor(minor: string | null | undefined, exp: number): { neg: boolean; int: string; frac: string } | null {
  if (typeof minor !== 'string' || !INT.test(minor.trim())) return null;
  let s = minor.trim();
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  s = s.replace(/^0+(?=\d)/, '').padStart(exp + 1, '0');
  const int = exp === 0 ? s : s.slice(0, s.length - exp);
  const frac = exp === 0 ? '' : s.slice(s.length - exp);
  // "-0" / "-000" is zero: no minus sign.
  return { neg: neg && /[1-9]/.test(s), int, frac };
}

/** Plain decimal in major units, for inputs and CSV ("123450" INR → "1234.50", KWD "1234" → "1.234"). */
export function minorToMajorString(minor: string | null | undefined, currency: string): string {
  const exp = exponentOf(currency) ?? 0;
  const p = splitMinor(minor, exp);
  if (!p) return '';
  return `${p.neg ? '-' : ''}${p.int}${p.frac ? `.${p.frac}` : ''}`;
}

const formatters = new Map<string, Intl.NumberFormat>();
function currencyFormatter(locale: string, currency: string, exp: number): Intl.NumberFormat | null {
  const key = `${locale}|${currency}|${exp}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: exp, maximumFractionDigits: exp });
    } catch {
      return null;
    }
    formatters.set(key, f);
  }
  return f;
}

/**
 * Localised currency text for a minor-unit string: "123450" INR (en-IN) → "₹1,234.50"; JPY "1234" → "¥1,234";
 * KWD "1234" → "KWD 1.234". The integer part goes through Intl as a bigint (exact, any size) and the fraction digits are
 * the original digits, so nothing is rounded. Unknown currency → "1234 XXX"; not a number → "—".
 */
export function formatMoney(minor: string | null | undefined, currency: string, locale = 'en-IN'): string {
  const exp = exponentOf(currency);
  if (exp === null) {
    const p = splitMinor(minor, 0);
    return p ? `${p.neg ? '-' : ''}${p.int} ${currency}` : '—';
  }
  const p = splitMinor(minor, exp);
  if (!p) return '—';
  const f = currencyFormatter(locale, currency, exp);
  if (!f) return `${p.neg ? '-' : ''}${p.int}${p.frac ? `.${p.frac}` : ''} ${currency}`;
  const parts = f.formatToParts(BigInt(p.int));
  const body = parts.map((x) => (x.type === 'fraction' ? p.frac : x.value)).join('');
  return p.neg ? `-${body}` : body;
}

/** Sum of minor-unit strings (exact). Invalid entries count as 0. */
export function sumMinor(values: readonly (string | null | undefined)[]): string {
  let s = 0n;
  for (const v of values) if (typeof v === 'string' && INT.test(v.trim())) s += BigInt(v.trim());
  return s.toString();
}

/**
 * `minor / divisor` rounded half away from zero, for derived per-unit figures (revenue per trip, per km, per day).
 * Returns null when the divisor is not a positive integer (nothing to divide by).
 */
export function divideMinor(minor: string | null | undefined, divisor: number | bigint): string | null {
  if (typeof minor !== 'string' || !INT.test(minor.trim())) return null;
  const d = typeof divisor === 'bigint' ? divisor : Number.isInteger(divisor) ? BigInt(divisor) : 0n;
  if (d <= 0n) return null;
  const n = BigInt(minor.trim());
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  return (neg ? -q : q).toString();
}

/**
 * Validates an amount typed by a person in MAJOR units for `currency` (what the API's `amount` fields take).
 * Returns an English message key, or null when valid.
 */
export function amountError(value: string, currency: string, { allowZero = false, allowNegative = false } = {}): string | null {
  const v = value.trim();
  if (!v) return 'Required';
  const exp = exponentOf(currency);
  if (exp === null) return 'Unknown currency';
  let minor: bigint;
  try {
    minor = parseMajorToMinor(v, currency);
  } catch {
    return exp === 0 ? 'Enter a whole amount (this currency has no decimals)' : 'Enter a valid amount (too many decimals for this currency?)';
  }
  if (!allowNegative && minor < 0n) return 'The amount cannot be negative';
  if (!allowZero && minor === 0n) return 'The amount must be more than zero';
  return null;
}

/** Metres → "25.4 km" style text (display only; distances are not money). */
export function formatKm(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} km`;
}
