/**
 * Exact integer money helpers (doc 19 §5.1, §5.3). Rates are micro major units (bigint), amounts minor units (bigint).
 */
import { currencyExponent } from './currency';
import type { RoundingMode } from './types';

/** Inputs are bounded: |value| ≤ 10^15 major units (overflow guard for user-entered decimals). */
const MAX_INT_DIGITS = 15;

/** "12.375" (scale 6) → 12375000n. Exact; at most `scale` decimals; optional leading '-'; throws on junk / overflow. */
export function parseDecimalScaled(s: string, scale: number): bigint {
  const str = typeof s === 'number' ? String(s) : s;
  if (typeof str !== 'string') throw new Error(`INVALID_DECIMAL: ${String(s)}`);
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(str.trim());
  if (!m) throw new Error(`INVALID_DECIMAL: "${str}"`);
  const int = m[2].replace(/^0+(?=\d)/, '');
  if (int.length > MAX_INT_DIGITS) throw new Error(`DECIMAL_OUT_OF_RANGE: "${str}"`);
  const frac = m[3] ?? '';
  if (frac.length > scale) throw new Error(`INVALID_DECIMAL: "${str}" has more than ${scale} decimals`);
  const v = BigInt(int + frac.padEnd(scale, '0'));
  return m[1] ? -v : v;
}

export const parseDecimalMicro = (s: string): bigint => parseDecimalScaled(s, 6);

/** 12375000n → "12.375000" (places = 6). */
export function formatMicro(m: bigint, places = 6): string {
  const neg = m < 0n;
  let abs = neg ? -m : m;
  // Drop precision beyond `places` (micro has 6).
  if (places < 6) abs = abs / 10n ** BigInt(6 - places);
  const s = abs.toString().padStart(places + 1, '0');
  const body = places === 0 ? s : `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}`;
  return `${neg ? '-' : ''}${body}`;
}

/** n / d rounded: HALF_UP = half away from zero; HALF_EVEN = banker's. d must be positive. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d <= 0n) throw new Error('divRound: divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a % d;
  const twice = r * 2n;
  if (twice > d || (twice === d && (mode === 'HALF_UP' || q % 2n === 1n))) q += 1n;
  return neg ? -q : q;
}

/** Ceiling division for non-negative n. */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divCeil: divisor must be positive');
  if (n <= 0n) return -((-n) / d);
  return (n + d - 1n) / d;
}

/** Micro major units → minor units of the currency, rounded once. */
export function microToMinor(micro: bigint, currency: string, mode: RoundingMode): bigint {
  const exp = currencyExponent(currency);
  return divRound(micro, 10n ** BigInt(6 - exp), mode);
}

export function minorToMicro(minor: bigint, currency: string): bigint {
  return minor * 10n ** BigInt(6 - currencyExponent(currency));
}

/** "25.5" km → 25500 m (exact, up to 3 decimals). */
export function kmToMetres(s: string): number {
  const v = parseDecimalScaled(String(s), 3);
  if (v < 0n) throw new Error(`INVALID_DECIMAL: negative km "${s}"`);
  return Number(v);
}

/** "1.5" h → 5400 s (up to 4 decimals, rounded to whole seconds half up). */
export function hoursToSeconds(s: string): number {
  const v = parseDecimalScaled(String(s), 4);
  if (v < 0n) throw new Error(`INVALID_DECIMAL: negative hours "${s}"`);
  return Number(divRound(v * 3600n, 10_000n, 'HALF_UP'));
}

/** "18" % → 180000 ppm; "2.5" → 25000 (up to 4 decimals). */
export function percentToPpm(s: string): number {
  const v = parseDecimalScaled(String(s), 4);
  if (v < 0n) throw new Error(`INVALID_DECIMAL: negative percent "${s}"`);
  return Number(v);
}

export function sumBig(values: readonly bigint[]): bigint {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

/**
 * Split `total` (≥ 0) by non-negative integer weights, largest remainder, so the parts sum exactly to `total`.
 * Ties go to the earlier index. All-zero weights → everything on index 0 (or nothing when empty).
 */
export function allocateLargestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  if (!weights.length) return [];
  const sumW = sumBig(weights);
  if (sumW <= 0n) return weights.map((_, i) => (i === 0 ? total : 0n));
  const parts = weights.map((w) => (total * w) / sumW);
  const rems = weights.map((w, i) => ({ i, r: (total * w) % sumW }));
  let left = total - sumBig(parts);
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0n; k = (k + 1) % rems.length, left -= 1n) parts[rems[k].i] += 1n;
  return parts;
}
