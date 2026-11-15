/** Credit note split (doc 19 §5.8; QA 7): partial credits never drift from the invoice's tax. */
import { allocateLargestRemainder, divRound } from './money';

export interface CreditTaxLineIn {
  taxCode: string;
  label: string;
  ratePpm: number;
  taxableMinor: bigint;
  taxMinor: bigint;
  cgstMinor?: bigint;
  sgstMinor?: bigint;
  utgstMinor?: bigint;
  igstMinor?: bigint;
}

export interface CreditSplit {
  subtotalMinor: bigint;
  taxMinor: bigint;
  taxLines: CreditTaxLineIn[];
}

/**
 * Split a credit of `amountMinor` (including tax) against an invoice. Pro rata over the invoice tax, except that the
 * credit which brings the credited total to the invoice total takes exactly the tax still left, so the sum of all credit
 * notes always reverses the invoice tax to the minor unit. Each tax line is split again into CGST / SGST (UTGST) / IGST
 * the way the invoice line was (odd minor unit to CGST, as gstLine does).
 */
export function splitCredit(
  invoice: { totalMinor: bigint; taxMinor: bigint; taxLines: CreditTaxLineIn[] },
  credited: { totalMinor: bigint; taxMinor: bigint },
  amountMinor: bigint,
): CreditSplit {
  const remaining = invoice.totalMinor - credited.totalMinor;
  const remainingTax = invoice.taxMinor - credited.taxMinor;
  if (amountMinor <= 0n || amountMinor > remaining) throw new Error('CREDIT_EXCEEDS_INVOICE');
  const den = invoice.totalMinor === 0n ? 1n : invoice.totalMinor;
  let tax = amountMinor === remaining ? remainingTax : divRound(invoice.taxMinor * amountMinor, den, 'HALF_UP');
  if (tax > remainingTax) tax = remainingTax;
  if (tax < 0n) tax = 0n;
  const shares = invoice.taxLines.length ? allocateLargestRemainder(tax, invoice.taxLines.map((t) => (t.taxMinor > 0n ? t.taxMinor : 0n))) : [];
  const taxLines = invoice.taxLines.map((t, i) => {
    const share = shares[i] ?? 0n;
    const out: CreditTaxLineIn = { taxCode: t.taxCode, label: t.label, ratePpm: t.ratePpm, taxableMinor: divRound(t.taxableMinor * amountMinor, den, 'HALF_UP'), taxMinor: share };
    if ((t.igstMinor ?? 0n) > 0n) out.igstMinor = share;
    else if ((t.cgstMinor ?? 0n) > 0n || (t.sgstMinor ?? 0n) > 0n || (t.utgstMinor ?? 0n) > 0n) {
      const c = (share + 1n) / 2n;
      out.cgstMinor = c;
      if ((t.utgstMinor ?? 0n) > 0n) out.utgstMinor = share - c;
      else out.sgstMinor = share - c;
    }
    return out;
  });
  return { subtotalMinor: amountMinor - tax, taxMinor: tax, taxLines };
}
