/**
 * Tax on tax-exclusive lines (doc 19 §5.6). Per line, then rounded; IN_GST split reuses `taxKind` from licences and
 * gives the odd minor unit to CGST, as `gstLine` does. No rate is ever assumed: a missing rate = TAX_PROFILE_MISSING.
 */
import { taxKind } from '../licences';
import { divRound } from './money';
import type { PriceLine, PricingIssue, RoundingMode, TaxConfig, TaxLine } from './types';

export const TAX_EXEMPT = 'EXEMPT';

export function applyTax(lines: PriceLine[], tax: TaxConfig, mode: RoundingMode): { lines: PriceLine[]; taxLines: TaxLine[]; issues: PricingIssue[] } {
  const issues: PricingIssue[] = [];
  const out: PriceLine[] = [];
  const agg = new Map<string, TaxLine>();
  const missing = new Set<string>();
  let gstKind: ReturnType<typeof taxKind> | null = null;
  if (tax.regime === 'IN_GST') {
    if (!tax.supplierStateCode || !tax.buyerStateCode) {
      issues.push({ code: 'TAX_PROFILE_MISSING', message: 'GST needs the supplier and the buyer state codes' });
    } else gstKind = taxKind(tax.supplierStateCode, tax.buyerStateCode);
  }
  for (const line of lines) {
    const code = line.taxCode ?? tax.defaultTaxCode ?? null;
    if (tax.regime === 'NONE' || code === TAX_EXEMPT) {
      out.push({ ...line, taxCode: tax.regime === 'NONE' ? null : code, taxMinor: 0n });
      continue;
    }
    if (!code) {
      missing.add('(default)');
      out.push({ ...line, taxCode: null, taxMinor: 0n });
      continue;
    }
    const rate = tax.rates.find((r) => r.taxCode === code);
    if (!rate) {
      missing.add(code);
      out.push({ ...line, taxCode: code, taxMinor: 0n });
      continue;
    }
    const taxable = line.amountMinor - line.discountMinor;
    const t = divRound(taxable * BigInt(rate.ratePpm), 1_000_000n, mode);
    out.push({ ...line, taxCode: code, taxMinor: t });
    let a = agg.get(code);
    if (!a) {
      a = { taxCode: code, label: rate.label, ratePpm: rate.ratePpm, taxableMinor: 0n, taxMinor: 0n };
      if (tax.regime === 'IN_GST') Object.assign(a, { cgstMinor: 0n, sgstMinor: 0n, utgstMinor: 0n, igstMinor: 0n });
      agg.set(code, a);
    }
    a.taxableMinor += taxable;
    a.taxMinor += t;
    if (tax.regime === 'IN_GST' && gstKind) {
      if (gstKind === 'IGST') a.igstMinor = (a.igstMinor ?? 0n) + t;
      else {
        // Ceil half (sign-aware) to CGST, the rest to SGST / UTGST.
        const c = t >= 0n ? (t + 1n) / 2n : -((-t) / 2n);
        a.cgstMinor = (a.cgstMinor ?? 0n) + c;
        if (gstKind === 'CGST_UTGST') a.utgstMinor = (a.utgstMinor ?? 0n) + (t - c);
        else a.sgstMinor = (a.sgstMinor ?? 0n) + (t - c);
      }
    }
  }
  for (const code of missing) issues.push({ code: 'TAX_PROFILE_MISSING', message: `No tax rate configured for tax code ${code}` });
  return { lines: out, taxLines: [...agg.values()], issues };
}
