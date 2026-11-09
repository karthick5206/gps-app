import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * R-36 stop-gap (D-107): a company (or a personal / family account) that has legal financial records is never deleted
 * permanently. GST invoices, credit notes and payment records must be kept for the legal retention period; until
 * archiving with retention exists, every permanent-delete path refuses such a company.
 *
 * What counts as a financial record (schema.prisma, licences billing):
 * - Invoice           — GST tax invoice (companyId).
 * - CreditNote        — GST credit note (companyId).
 * - LicenceOrder      — a payment record once paid: status PAID, or a paidAt date, or a Razorpay payment id. Unpaid
 *                       orders (CREATED / FAILED, no payment id) are only checkout attempts and are not counted.
 * - UpiPaymentClaim   — the customer's UPI / cash payment evidence (ownerKind COMPANY, ownerId = company). CONFIRMED
 *                       claims became payments; PENDING claims say money was sent and still need a decision, so they
 *                       are counted too. REJECTED claims are not.
 * - The same four for the reseller Partner whose home company this is (Partner.homeCompanyId): deleting the partner's
 *   own account would strand its invoices and payments.
 * Not counted: InvoiceCounter / CreditNoteCounter (global, never touched by a purge), BillingProfile (invoices keep
 * buyer snapshots), LicenceSeat (licences, not payments), AuditLog, and Expense (a fleet's own running costs, not
 * VeeTrax billing).
 */

/** Tables a purge plan must never delete from (planner defence in depth, see purge-plan.ts). */
export const FINANCIAL_TABLES = ['Invoice', 'CreditNote', 'InvoiceCounter', 'CreditNoteCounter', 'UpiPaymentClaim', 'PlatformBillingSettings'] as const;

/** LicenceOrder rows that are payment records; the planner may delete only the others (unpaid checkout attempts). */
export const PAID_ORDER_SQL = `("status" = 'PAID' OR "paidAt" IS NOT NULL OR "razorpayPaymentId" IS NOT NULL)`;

export interface FinancialCounts {
  invoices: number;
  creditNotes: number;
  payments: number;
  upiClaims: number;
  /** Set when the company is a reseller partner's home company (its partner rows are included in the counts). */
  partnerId: string | null;
}

export const financialTotal = (c: FinancialCounts) => c.invoices + c.creditNotes + c.payments + c.upiClaims;

type Db = Pick<Prisma.TransactionClient, 'invoice' | 'creditNote' | 'licenceOrder' | 'upiPaymentClaim' | 'partner'>;

const PAID_ORDER: Prisma.LicenceOrderWhereInput = { OR: [{ status: 'PAID' }, { paidAt: { not: null } }, { razorpayPaymentId: { not: null } }] };
const KEPT_CLAIMS = ['CONFIRMED', 'PENDING'];

/** Financial records that belong to the company (and to the partner whose home company it is). */
export async function countFinancialRecords(db: Db, companyId: string): Promise<FinancialCounts> {
  const partner = await db.partner.findUnique({ where: { homeCompanyId: companyId }, select: { id: true } });
  const owner: Prisma.InvoiceWhereInput = partner ? { OR: [{ companyId }, { partnerId: partner.id }] } : { companyId };
  const claimOwners: Prisma.UpiPaymentClaimWhereInput[] = [{ ownerKind: 'COMPANY', ownerId: companyId }];
  if (partner) claimOwners.push({ ownerKind: 'PARTNER', ownerId: partner.id });
  const [invoices, creditNotes, payments, upiClaims] = await Promise.all([
    db.invoice.count({ where: owner }),
    db.creditNote.count({ where: owner as Prisma.CreditNoteWhereInput }),
    db.licenceOrder.count({ where: { AND: [owner as Prisma.LicenceOrderWhereInput, PAID_ORDER] } }),
    db.upiPaymentClaim.count({ where: { OR: claimOwners, status: { in: KEPT_CLAIMS } } }),
  ]);
  return { invoices, creditNotes, payments, upiClaims, partnerId: partner?.id ?? null };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 GST invoices, 1 credit note and 2 payment records" (only the non-zero kinds). */
export function describeFinancial(c: FinancialCounts, invoiceWord = 'GST invoice'): string {
  const parts: string[] = [];
  if (c.invoices) parts.push(plural(c.invoices, invoiceWord, `${invoiceWord}s`));
  if (c.creditNotes) parts.push(plural(c.creditNotes, 'credit note', 'credit notes'));
  const payments = c.payments + c.upiClaims;
  if (payments) parts.push(plural(payments, 'payment record', 'payment records'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? 'no financial records');
}

/** For the Super Admin (company purge, plain company delete). */
export function adminBlockMessage(c: FinancialCounts): string {
  const partner = c.partnerId ? ' (including the records of the reseller partner whose own account this is)' : '';
  return (
    `This company has ${describeFinancial(c)}${partner}, which must be kept for the legal retention period, so it cannot be deleted. ` +
    'Nothing was deleted. Suspend the company instead; archiving with retention is planned.'
  );
}

/** For the account holder on "Delete my account". */
export function selfBlockMessage(c: FinancialCounts): string {
  return (
    `Your account can't be deleted completely yet: it has ${describeFinancial(c, 'tax invoice')}, which tax law requires us to keep. ` +
    'Nothing was deleted. You can stop using VeeTrax by signing out and removing the app, or contact VeeTrax support, ' +
    'who can close your account for you while keeping only what the law requires.'
  );
}

/** 409 carrying the message and the counts (no personal data). */
export class FinancialRecordsException extends ConflictException {
  constructor(
    message: string,
    readonly counts: FinancialCounts,
  ) {
    super({ statusCode: 409, error: 'Conflict', code: 'FINANCIAL_RECORDS', message, counts: { invoices: counts.invoices, creditNotes: counts.creditNotes, payments: counts.payments + counts.upiClaims } });
  }
}

/** Audit details for a refused deletion (counts and reason only, never secrets). */
export function blockedAuditDetails(c: FinancialCounts, extra: Record<string, string | number | boolean | null>): Prisma.InputJsonObject {
  return {
    permanent: true,
    blocked: true,
    reason: 'FINANCIAL_RECORDS',
    invoices: c.invoices,
    creditNotes: c.creditNotes,
    payments: c.payments,
    upiClaims: c.upiClaims,
    partnerId: c.partnerId,
    ...extra,
  };
}
