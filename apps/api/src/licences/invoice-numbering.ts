import { Prisma } from '@prisma/client';

/** Minimal surface used for numbering (a Prisma transaction client in production, a fake in tests). */
export interface CounterTx {
  $queryRaw: Prisma.TransactionClient['$queryRaw'];
}

/**
 * Next invoice sequence of a financial year. Must run inside the transaction that inserts the invoice: the upsert
 * takes the counter row's lock until commit, so concurrent invoices queue up, and a rolled-back invoice also rolls back
 * its number — the sequence is consecutive and gap-free.
 */
export async function nextInvoiceSeq(tx: CounterTx, fy: string): Promise<number> {
  const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
    INSERT INTO "InvoiceCounter" ("fy", "lastSeq") VALUES (${fy}, 1)
    ON CONFLICT ("fy") DO UPDATE SET "lastSeq" = "InvoiceCounter"."lastSeq" + 1
    RETURNING "lastSeq"`;
  return Number(rows[0].lastSeq);
}

/** Next credit note sequence of a financial year: same gap-free row-lock approach, own counter table and series. */
export async function nextCreditNoteSeq(tx: CounterTx, fy: string): Promise<number> {
  const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
    INSERT INTO "CreditNoteCounter" ("fy", "lastSeq") VALUES (${fy}, 1)
    ON CONFLICT ("fy") DO UPDATE SET "lastSeq" = "CreditNoteCounter"."lastSeq" + 1
    RETURNING "lastSeq"`;
  return Number(rows[0].lastSeq);
}
