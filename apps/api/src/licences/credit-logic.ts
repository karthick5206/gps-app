import { BadRequestException } from '@nestjs/common';
import { addYears, ApiPlan, CreditableLineDto, CreditNoteLineRequest, gstLine, isApiPlan, TaxKind } from '@veetracer/shared';
import { InvoiceLineSnapshot } from './invoice-pdf';

/** A line of an earlier credit note (what it took from the invoice line). */
export interface PriorCreditLine {
  lineIndex: number;
  quantity: number;
  amountPaise: number;
}

/** A credited invoice line as printed on the credit note (amounts positive; the note itself reads as a credit). */
export interface CreditNoteLineSnapshot {
  lineIndex: number;
  type: InvoiceLineSnapshot['type'];
  plan: ApiPlan | null;
  kind: InvoiceLineSnapshot['kind'];
  quantity: number;
  periodFrom: string;
  periodTo: string;
  unitPaise: number;
  amountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  /** SGST, or UTGST for a union territory without legislature (see taxKind). */
  sgstPaise: number;
  igstPaise: number;
}

export interface PlannedCredit {
  lines: CreditNoteLineSnapshot[];
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

/** Invoice lines with what earlier credit notes already took (quantity and amount). */
export function creditableLines(lines: InvoiceLineSnapshot[], prior: PriorCreditLine[]): CreditableLineDto[] {
  return lines.map((l, lineIndex) => {
    const mine = prior.filter((p) => p.lineIndex === lineIndex);
    const creditedQuantity = mine.reduce((a, p) => a + p.quantity, 0);
    const creditedPaise = mine.reduce((a, p) => a + p.amountPaise, 0);
    return {
      lineIndex,
      type: l.type,
      plan: isApiPlan(l.plan) ? l.plan : null,
      kind: l.kind,
      quantity: l.quantity,
      unitPaise: l.unitPaise,
      amountPaise: l.amountPaise,
      periodFrom: l.periodFrom,
      periodTo: l.periodTo,
      creditedQuantity,
      creditedPaise,
      remainingQuantity: Math.max(0, l.quantity - creditedQuantity),
      remainingPaise: Math.max(0, l.amountPaise - creditedPaise),
    };
  });
}

/**
 * Validates a credit request against what is left on the invoice and splits each credited amount into taxable value
 * and GST with the original invoice's tax type and rate. A line's amount defaults to unit price × quantity; quantity 0
 * with an amount is a pure price correction. Nothing can exceed what is still creditable (per line and in total).
 */
export function planCredit(lines: InvoiceLineSnapshot[], prior: PriorCreditLine[], req: CreditNoteLineRequest[], taxKind: TaxKind, ratePct: number, invoiceTotalPaise: number): PlannedCredit {
  if (!req.length) throw new BadRequestException('Choose at least one invoice line to credit');
  const available = creditableLines(lines, prior);
  const seen = new Set<number>();
  const out: CreditNoteLineSnapshot[] = [];
  for (const r of req) {
    const line = available[r.lineIndex];
    if (!line) throw new BadRequestException(`Invoice line ${r.lineIndex + 1} does not exist`);
    if (seen.has(r.lineIndex)) throw new BadRequestException(`Invoice line ${r.lineIndex + 1} is listed twice`);
    seen.add(r.lineIndex);
    if (!Number.isInteger(r.quantity) || r.quantity < 0) throw new BadRequestException('Quantity must be a whole number');
    if (r.quantity > line.remainingQuantity) throw new BadRequestException(`Line ${r.lineIndex + 1}: only ${line.remainingQuantity} licence(s) left to credit`);
    const amount = r.amountPaise ?? line.unitPaise * r.quantity;
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException(`Line ${r.lineIndex + 1}: enter the amount to credit`);
    if (amount > line.remainingPaise) throw new BadRequestException(`Line ${r.lineIndex + 1}: at most ₹${(line.remainingPaise / 100).toFixed(2)} is left to credit`);
    const g = gstLine(amount, ratePct, taxKind);
    out.push({
      lineIndex: r.lineIndex,
      type: line.type,
      plan: line.plan,
      kind: line.kind,
      quantity: r.quantity,
      periodFrom: line.periodFrom,
      periodTo: line.periodTo,
      unitPaise: line.unitPaise,
      amountPaise: amount,
      taxablePaise: g.taxablePaise,
      cgstPaise: g.cgstPaise,
      sgstPaise: g.sgstPaise,
      igstPaise: g.igstPaise,
    });
  }
  const sum = (k: 'taxablePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'amountPaise') => out.reduce((a, l) => a + l[k], 0);
  const totalPaise = sum('amountPaise');
  const already = prior.reduce((a, p) => a + p.amountPaise, 0);
  if (totalPaise > invoiceTotalPaise - already) throw new BadRequestException('The credit exceeds what is left to credit on this invoice');
  const ut = taxKind === 'CGST_UTGST';
  return {
    lines: out.sort((a, b) => a.lineIndex - b.lineIndex),
    taxablePaise: sum('taxablePaise'),
    cgstPaise: sum('cgstPaise'),
    sgstPaise: ut ? 0 : sum('sgstPaise'),
    utgstPaise: ut ? sum('sgstPaise') : 0,
    igstPaise: sum('igstPaise'),
    totalPaise,
  };
}

/**
 * Expiry of a credited seat: the credited 12 months are taken off its current expiry, never
 * earlier than now and never later than it already is. A new seat therefore expires now; a renewal falls back to its
 * previous expiry (or now, if that has passed); a seat renewed again later keeps the later year.
 */
export function revokedExpiry(current: Date, periodFrom: string, periodTo: string, now: number): Date {
  // Still on the credited period: back to where it started. Renewed again since: one (12-month) year less.
  const back = current.getTime() <= Date.parse(periodTo) ? Date.parse(periodFrom) : addYears(current, -1).getTime();
  return new Date(Math.min(current.getTime(), Math.max(now, back)));
}

/** Seats of a line to revoke: not revoked before, unassigned ones first (no user / vehicle loses access needlessly). */
export function pickSeatsToRevoke<T extends { id: string; assigned: boolean }>(seats: T[], count: number, alreadyRevoked: Set<string>): T[] {
  return seats
    .filter((s) => !alreadyRevoked.has(s.id))
    .sort((a, b) => Number(a.assigned) - Number(b.assigned) || a.id.localeCompare(b.id))
    .slice(0, count);
}
