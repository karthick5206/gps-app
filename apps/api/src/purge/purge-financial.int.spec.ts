import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { FINANCIAL_TABLES } from './financial-guard';
import { stepSql } from './purge-plan';
import { PurgeService } from './purge.service';

/**
 * R-36 stop-gap on a real PostgreSQL built from the migrations. Runs only when PURGE_TEST_DATABASE_URL points at a
 * scratch database whose name ends in "_test" (e.g. veetrax_purge_test); skipped in the normal suite.
 */
const URL_ = process.env.PURGE_TEST_DATABASE_URL ?? '';
const scratch = /\/[a-z0-9_]+_test(\?|$)/i.test(URL_);
const d = scratch ? describe : describe.skip;

d('R-36 stop-gap on a real database', () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { pipeline: () => ({ del: () => undefined, srem: () => undefined, exec: async () => [] }) }, invalidateCache: async () => undefined };
  const svc = new PurgeService(prisma as never, redis as never, new AuditService(prisma as never));
  const run = randomUUID().slice(0, 8);
  const ids = { partner: randomUUID(), home: randomUUID(), sa: randomUUID(), fin: randomUUID(), plain: randomUUID(), personal: randomUUID(), personalUser: randomUUID() };
  const sa = { userId: ids.sa, homeCompanyId: ids.home, companyId: ids.home, isSuperAdmin: true, ip: '127.0.0.1' } as unknown as AuthContext;

  /** Rows of every financial kind (and some operational ones) for a company. */
  async function seedFinancial(companyId: string, tag: string) {
    const order = await prisma.licenceOrder.create({ data: { companyId, status: 'PAID', mode: 'UPI', items: [], amountPaise: 118000, paidAt: new Date(), paymentReference: `UTR-${tag}` } });
    const inv = await prisma.invoice.create({
      data: {
        number: `T/${run}/${tag}`, fy: `T${run}`, seq: tag.length + (tag === 'fin' ? 100 : 200), issuedAt: new Date(), orderId: order.id, companyId, buyerName: 'Buyer', buyerStateCode: '33',
        supplier: {}, buyer: {}, lines: [], taxKind: 'INTRA', gstRatePct: 18, sacCode: '998315', taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, utgstPaise: 0, igstPaise: 0,
        totalPaise: 118000, paymentMode: 'UPI', paidAt: new Date(),
      },
    });
    return inv;
  }

  const counts = async (companyId: string) => ({
    company: await prisma.company.count({ where: { id: companyId } }),
    users: await prisma.user.count({ where: { companyId } }),
    invoices: await prisma.invoice.count({ where: { companyId } }),
    creditNotes: await prisma.creditNote.count({ where: { companyId } }),
    orders: await prisma.licenceOrder.count({ where: { companyId } }),
    upi: await prisma.upiPaymentClaim.count({ where: { ownerId: companyId } }),
  });
  const blockedAudits = (companyId: string) => prisma.auditLog.findMany({ where: { entity: 'company', entityId: companyId, action: 'DELETE' } });

  beforeAll(async () => {
    await prisma.partner.create({ data: { id: ids.partner, name: `P ${run}`, slug: `p-${run}` } });
    await prisma.company.create({ data: { id: ids.home, partnerId: ids.partner, name: `Home ${run}`, isPlatform: true } });
    // Exactly one Super Admin may exist (unique index): reuse it on re-runs so the test is repeatable.
    const existingSa = await prisma.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    if (existingSa) ids.sa = existingSa.id as typeof ids.sa;
    else await prisma.user.create({ data: { id: ids.sa, companyId: ids.home, name: 'SA', email: `sa-${run}@t.test`, isSuperAdmin: true } });
    (sa as unknown as { userId: string }).userId = ids.sa;
    // A business company with an invoice, a credit note, a paid order, a confirmed UPI claim.
    await prisma.company.create({ data: { id: ids.fin, partnerId: ids.partner, name: `Fin ${run}` } });
    await prisma.branch.create({ data: { companyId: ids.fin, name: 'Head Office' } });
    await prisma.user.create({ data: { companyId: ids.fin, name: 'Admin', email: `fin-${run}@t.test` } });
    await prisma.billingProfile.create({ data: { companyId: ids.fin, billingName: 'Fin', address: 'x', stateCode: '33', email: `b-${run}@t.test` } });
    const inv = await seedFinancial(ids.fin, 'fin');
    await prisma.creditNote.create({
      data: {
        number: `TCN/${run}`, fy: `T${run}`, seq: 1, issuedAt: new Date(), invoiceId: inv.id, companyId: ids.fin, buyerName: 'Buyer', buyerStateCode: '33', snapshot: {}, reason: 'test', taxKind: 'INTRA',
        gstRatePct: 18, taxablePaise: 1000, cgstPaise: 90, sgstPaise: 90, utgstPaise: 0, igstPaise: 0, totalPaise: 1180, refundMode: 'NONE',
      },
    });
    await prisma.upiPaymentClaim.create({ data: { ownerKind: 'COMPANY', ownerId: ids.fin, purchase: {}, amountPaise: 118000, paidOn: '2026-11-01', summary: 's', status: 'CONFIRMED' } });
    // A business company without financial records (an unpaid checkout attempt only).
    await prisma.company.create({ data: { id: ids.plain, partnerId: ids.partner, name: `Plain ${run}` } });
    await prisma.branch.create({ data: { companyId: ids.plain, name: 'Head Office' } });
    await prisma.user.create({ data: { companyId: ids.plain, name: 'Admin', email: `plain-${run}@t.test` } });
    await prisma.licenceOrder.create({ data: { companyId: ids.plain, status: 'CREATED', mode: 'RAZORPAY', items: [], amountPaise: 1000, razorpayOrderId: `order_${run}` } });
    // A personal account (one user) with a tax invoice.
    await prisma.company.create({ data: { id: ids.personal, partnerId: ids.partner, name: `Personal ${run}`, accountType: 'INDIVIDUAL' } });
    await prisma.user.create({ data: { id: ids.personalUser, companyId: ids.personal, name: 'Me', email: `me-${run}@t.test` } });
    await seedFinancial(ids.personal, 'personal');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('(a) purge of a company with financial records is refused with 409, nothing is deleted, the attempt is audited', async () => {
    const before = await counts(ids.fin);
    expect(before).toEqual({ company: 1, users: 1, invoices: 1, creditNotes: 1, orders: 1, upi: 1 });
    await expect(svc.preview(sa, 'company', ids.fin)).rejects.toMatchObject({ status: 409 });
    const err = (await svc.purge(sa, 'company', ids.fin, `Fin ${run}`).catch((e: unknown) => e)) as { status?: number; message?: string };
    expect(err).toMatchObject({ status: 409 });
    expect(err.message).toBe(
      'This company has 1 GST invoice, 1 credit note and 2 payment records, which must be kept for the legal retention period, so it cannot be deleted. Nothing was deleted. Suspend the company instead; archiving with retention is planned.',
    );
    expect(await counts(ids.fin)).toEqual(before);
    expect(await prisma.billingProfile.count({ where: { companyId: ids.fin } })).toBe(1);
    const audits = await blockedAudits(ids.fin);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).toContain('FINANCIAL_RECORDS');
    expect(audits[0]).toMatchObject({ companyId: ids.home, userId: ids.sa });
  });

  it('(a) backstop: even if the plan is run directly, the RESTRICT keys stop it and the transaction rolls back', async () => {
    const before = await counts(ids.fin);
    const steps = await (svc as unknown as { steps: (k: string, id: string) => Promise<{ table: string }[]> }).steps('company', ids.fin);
    await expect(prisma.$transaction(async (tx) => {
      for (const s of steps) await tx.$executeRawUnsafe(stepSql(s as never));
    })).rejects.toThrow(/foreign key|violates/i);
    expect(await counts(ids.fin)).toEqual(before);
  });

  it('(d) the plan built from the real catalogue never deletes a financial table, and only unpaid orders', async () => {
    const steps = await (svc as unknown as { steps: (k: string, id: string) => Promise<{ table: string; where: string; nullCol?: string }[]> }).steps('company', ids.fin);
    const tables = steps.filter((s) => !s.nullCol).map((s) => s.table);
    for (const t of FINANCIAL_TABLES) expect(tables).not.toContain(t);
    expect(steps.filter((s) => s.table === 'LicenceOrder').every((s) => s.where.endsWith(`AND NOT ("status" = 'PAID' OR "paidAt" IS NOT NULL OR "razorpayPaymentId" IS NOT NULL)`))).toBe(true);
    expect(tables[tables.length - 1]).toBe('Company');
    for (const kind of ['device', 'object', 'user'] as const) {
      const other = await (svc as unknown as { steps: (k: string, id: string) => Promise<{ table: string }[]> }).steps(kind, randomUUID());
      for (const t of [...FINANCIAL_TABLES, 'LicenceOrder']) expect(other.map((s) => s.table)).not.toContain(t);
    }
  });

  it('(c) self-service deletion of a personal account with an invoice is refused, nothing is deleted, the attempt is audited', async () => {
    const before = await counts(ids.personal);
    const me = { userId: ids.personalUser, companyId: ids.personal, homeCompanyId: ids.personal, isSuperAdmin: false, ip: null } as unknown as AuthContext;
    const err = (await svc.deleteOwnAccount(me, `me-${run}@t.test`).catch((e: unknown) => e)) as { status?: number; message?: string };
    expect(err).toMatchObject({ status: 409 });
    expect(err.message).toContain("Your account can't be deleted completely yet: it has 1 tax invoice and 1 payment record");
    expect(await counts(ids.personal)).toEqual(before);
    expect(before).toMatchObject({ company: 1, users: 1, invoices: 1, orders: 1 });
    const audits = await blockedAudits(ids.personal);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ companyId: ids.personal, userId: ids.personalUser });
  });

  it('(b) a company without financial records is still purged completely (unpaid checkout attempts included)', async () => {
    expect(await counts(ids.plain)).toMatchObject({ company: 1, users: 1, orders: 1 });
    const preview = await svc.preview(sa, 'company', ids.plain);
    expect(preview.tables.map((t) => t.table)).toEqual(expect.arrayContaining(['Company', 'User', 'Branch', 'LicenceOrder']));
    const r = await svc.purge(sa, 'company', ids.plain, `Plain ${run}`);
    expect(r.deletedRows).toBeGreaterThanOrEqual(4);
    expect(await counts(ids.plain)).toEqual({ company: 0, users: 0, invoices: 0, creditNotes: 0, orders: 0, upi: 0 });
    // The financial company is untouched by the other purge.
    expect(await counts(ids.fin)).toMatchObject({ company: 1, invoices: 1, creditNotes: 1 });
  });
});
