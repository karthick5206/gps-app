/** ISO 4217 minor-unit exponents (doc 19 §5.1). No currency is assumed: a contract must name one of these. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SAR: 2, QAR: 2, SGD: 2, AUD: 2, CAD: 2, NZD: 2, CHF: 2, CNY: 2, HKD: 2,
  MYR: 2, THB: 2, IDR: 2, PHP: 2, LKR: 2, NPR: 2, BDT: 2, PKR: 2, ZAR: 2, KES: 2, NGN: 2, EGP: 2, SEK: 2, NOK: 2,
  DKK: 2, PLN: 2, BRL: 2, MXN: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, UGX: 0,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
};

export function isCurrency(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code);
}

/** Minor-unit exponent of a currency; throws CURRENCY_UNKNOWN for an unknown code. */
export function currencyExponent(code: string): number {
  if (!isCurrency(code)) throw new Error(`CURRENCY_UNKNOWN: ${String(code)}`);
  return CURRENCY_EXPONENTS[code];
}

/** 123450n INR → "1234.50"; -5n → "-0.05"; JPY 1234n → "1234"; KWD 1234n → "1.234". */
export function formatMinor(minor: bigint, currency: string): string {
  const exp = currencyExponent(currency);
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(exp + 1, '0');
  const body = exp === 0 ? s : `${s.slice(0, s.length - exp)}.${s.slice(s.length - exp)}`;
  return `${neg ? '-' : ''}${body}`;
}

/** "1234.5" INR → 123450n (exact). Refuses more decimals than the currency has, and anything non-numeric. */
export function parseMajorToMinor(s: string, currency: string): bigint {
  const exp = currencyExponent(currency);
  const m = /^(-)?(\d{1,15})(?:\.(\d+))?$/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) throw new Error(`INVALID_AMOUNT: "${String(s)}"`);
  const frac = m[3] ?? '';
  if (frac.length > exp) throw new Error(`INVALID_AMOUNT: "${s}" has more than ${exp} decimals for ${currency}`);
  const v = BigInt(m[2] + frac.padEnd(exp, '0'));
  return m[1] ? -v : v;
}
