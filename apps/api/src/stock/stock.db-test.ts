/**
 * End-to-end stock flow against a real, empty PostgreSQL (all migrations applied). Not part of the normal test run:
 *   DATABASE_URL=postgresql://postgres@localhost:5499/veetrax_test npx jest --testRegex 'stock\.db-test\.ts$' --runInBand
 * Covers: PO → receipt (damaged unit, duplicate IMEI refused) → return to supplier; order → sale (stock check),
 * editing a sale, invoice + payment, customer return + credit note, reseller order → dispatch to reseller store →
 * reseller sale, adjustment, reorder level for all trackers, dashboard, and the tracker (Device) follow-up.
 */
import type { StockDocInput } from '@veetracer/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../access/auth-context';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { StockDashboardService } from './stock-dashboard.service';
import { StockInvoicesService } from './stock-invoices.service';
import { InventoryLinkService } from './inventory-link.service';
import { StockService } from './stock.service';

jest.setTimeout(60_000);

const prisma = new PrismaService();
const deviceCalls: { op: string; uniqueId?: string; companyId?: string | null }[] = [];
const devices = {
  create: async (_ctx: unknown, dto: { modelId: string; uniqueId: string; companyId: string | null }) => {
    deviceCalls.push({ op: 'create', uniqueId: dto.uniqueId, companyId: dto.companyId });
    return prisma.device.create({ data: { modelId: dto.modelId, uniqueId: dto.uniqueId, companyId: dto.companyId, ingestToken: `t-${dto.uniqueId}` } });
  },
  update: async (_ctx: unknown, id: string, dto: { companyId: string | null }) => {
    const d = await prisma.device.update({ where: { id }, data: { companyId: dto.companyId } });
    deviceCalls.push({ op: 'update', uniqueId: d.uniqueId, companyId: dto.companyId });
    return d;
  },
};
const audit = new AuditService(prisma);
const link = new InventoryLinkService(prisma);
const stock = new StockService(prisma, audit, devices as never, link);
const invoices = new StockInvoicesService(prisma, audit, new LicenceSettingsService(prisma), stock);
const board = new StockDashboardService(prisma, stock);

let platform: AuthContext;
let resellerCtx: AuthContext;
let customerId: string;
let partnerId: string;
const ctxFor = (userId: string, companyId: string, isSuperAdmin: boolean): AuthContext => ({ userId, homeCompanyId: companyId, companyId, isSuperAdmin, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null }) as unknown as AuthContext;
const doc = (p: Partial<StockDocInput> & Pick<StockDocInput, 'kind' | 'lines'>): StockDocInput => ({ status: 'DONE', docDate: '2026-11-09', ...p });
const line = (itemId: string, qty: number, serials: string[] = [], ratePaise = 0, condition: 'OK' | 'DAMAGED' = 'OK') => ({ itemId, qty, ratePaise, gstRatePct: 18, serials, condition, note: '' });

let gt06: string;
let relay: string;
let supplierId: string;

beforeAll(async () => {
  const defaultPartner = await prisma.partner.create({ data: { name: 'VeeTrax', slug: 'default' } });
  const platformCo = await prisma.company.create({ data: { name: 'VeeTrax Platform', partnerId: defaultPartner.id, isPlatform: true } });
  const admin = await prisma.user.create({ data: { companyId: platformCo.id, name: 'Super Admin', email: 'sa@test', isSuperAdmin: true } as never });
  platform = ctxFor(admin.id, platformCo.id, true);
  const customer = await prisma.company.create({ data: { name: 'AGP City Gas', partnerId: defaultPartner.id } });
  customerId = customer.id;
  const resellerCo = await prisma.company.create({ data: { name: 'Chennai Reseller', partnerId: defaultPartner.id } });
  const partner = await prisma.partner.create({ data: { name: 'Chennai Reseller', slug: 'chennai', homeCompanyId: resellerCo.id } });
  partnerId = partner.id;
  const rUser = await prisma.user.create({ data: { companyId: resellerCo.id, name: 'Reseller admin', email: 'r@test' } as never });
  resellerCtx = ctxFor(rUser.id, resellerCo.id, false);
  const model = await prisma.deviceModel.create({ data: { brand: 'Concox', model: 'GT06N', protocol: 'gt06', capabilities: [] } });
  await prisma.platformBillingSettings.upsert({ where: { id: 'default' }, create: { id: 'default', legalName: 'Vibhav Enterprise Solutions', gstin: '33ABCDE1234F1Z5', stateCode: '33', city: 'Chennai' } as never, update: {} });

  gt06 = (await stock.saveItem(platform, null, { name: 'Concox GT06N', kind: 'DEVICE', deviceModelId: model.id, sku: null, hsnCode: '8526', gstRatePct: 18, unit: 'pcs', serialTracked: true, salePricePaise: 250000, purchasePricePaise: 150000, lowStockAt: null, reorderQty: null, isActive: true })).id;
  relay = (await stock.saveItem(platform, null, { name: 'Relay', kind: 'ACCESSORY', deviceModelId: null, sku: null, hsnCode: '8536', gstRatePct: 18, unit: 'pcs', serialTracked: false, salePricePaise: 30000, purchasePricePaise: 15000, lowStockAt: 3, reorderQty: 10, isActive: true })).id;
  supplierId = (await stock.saveSupplier(platform, null, { name: 'Concox India', gstin: null, stateCode: '29', address: '', city: 'Bengaluru', pin: '', contactName: '', phone: '', email: '', notes: '', leadTimeDays: 5, isActive: true })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('stock flow on a real database', () => {
  let poId: string;
  let saleId: string;

  it('PO → receipt with a damaged unit → PO part received; trackers created in Device Inventory', async () => {
    const po = await stock.saveDoc(platform, null, doc({ kind: 'PO', status: 'OPEN', supplierId, lines: [line(gt06, 3, [], 150000), line(relay, 10, [], 15000)] }));
    poId = po.id;
    expect(po.number).toBe('PO/26-27/0001');
    expect(po.status).toBe('OPEN');
    const grn = await stock.saveDoc(platform, null, doc({ kind: 'RECEIPT', supplierId, sourceId: po.id, supplierInvoiceNo: 'CX-778', lines: [line(gt06, 0, ['8661 01', '866102'], 150000), line(gt06, 0, ['866103'], 150000, 'DAMAGED'), line(relay, 6, [], 15000)] }));
    expect(grn.number).toBe('GRN/26-27/0001');
    expect((await stock.getDoc(platform, po.id)).status).toBe('PARTIAL');
    const onHand = await stock.onHand(platform);
    expect(onHand.map((r) => [r.itemName, r.locationName, r.qty])).toEqual([
      ['Concox GT06N', 'Damaged shelf', 1],
      ['Concox GT06N', 'Main store', 2],
      ['Relay', 'Main store', 6],
    ]);
    expect(deviceCalls.filter((c) => c.op === 'create').map((c) => c.uniqueId)).toEqual(['866101', '866102', '866103']);
    // The damaged unit still counts as received against the PO; 4 relays are still to come.
    expect((await stock.getDoc(platform, po.id)).pending).toEqual([{ itemId: relay, itemName: 'Relay', qty: 4 }]);
  });

  it('refuses receiving an IMEI that is already in stock', async () => {
    await expect(stock.saveDoc(platform, null, doc({ kind: 'RECEIPT', supplierId, lines: [line(gt06, 0, ['866101'])] }))).rejects.toThrow(/already in stock/);
  });

  it('damaged unit goes back to the supplier from the damaged shelf', async () => {
    await stock.saveDoc(platform, null, doc({ kind: 'PURCHASE_RETURN', supplierId, reason: 'Not powering on', lines: [line(gt06, 0, ['866103'])] }));
    const s = await stock.serial(platform, '866103');
    expect(s[0].status).toBe('WITH_SUPPLIER');
    expect(s[0].history.map((h) => h.effect)).toEqual(['DAMAGED', 'WITH_SUPPLIER']);
  });

  it('sale to a customer company: stock checked, tracker assigned to the customer; can not oversell', async () => {
    await expect(stock.saveDoc(platform, null, doc({ kind: 'SALE', saleTo: 'CUSTOMER', customerCompanyId: customerId, lines: [line(relay, 7)] }))).rejects.toThrow(/Only 6 of Relay/);
    const sale = await stock.saveDoc(platform, null, doc({ kind: 'SALE', saleTo: 'CUSTOMER', customerCompanyId: customerId, customerName: 'AGP City Gas', customerStateCode: '33', lines: [line(gt06, 0, ['866101'], 250000), line(relay, 4, [], 30000)] }));
    saleId = sale.id;
    expect((await stock.serial(platform, '866101'))[0]).toMatchObject({ status: 'SOLD', customerName: 'AGP City Gas' });
    expect((await prisma.device.findFirst({ where: { uniqueId: '866101' } }))?.companyId).toBe(customerId);
  });

  it('editing a done sale corrects stock: swapped IMEI goes back, the new one is sold', async () => {
    await stock.saveDoc(platform, saleId, doc({ kind: 'SALE', saleTo: 'CUSTOMER', customerCompanyId: customerId, customerName: 'AGP City Gas', customerStateCode: '33', lines: [line(gt06, 0, ['866102'], 250000), line(relay, 4, [], 30000)] }));
    expect((await stock.serial(platform, '866101'))[0].status).toBe('IN_STOCK');
    expect((await stock.serial(platform, '866102'))[0].status).toBe('SOLD');
    expect((await prisma.device.findFirst({ where: { uniqueId: '866101' } }))?.companyId).toBeNull();
    expect((await prisma.device.findFirst({ where: { uniqueId: '866102' } }))?.companyId).toBe(customerId);
  });

  it('invoice from the platform details: intra-state CGST + SGST, numbered; payment recorded', async () => {
    const withInv = await invoices.issue(platform, saleId);
    expect(withInv.invoice).toMatchObject({ kind: 'INVOICE', number: 'VTX/S/26-27/0001', totalPaise: 250000 + 4 * 30000, paymentStatus: 'UNPAID' });
    const row = await prisma.stockInvoice.findFirstOrThrow();
    expect(row.taxKind).toBe('CGST_SGST');
    expect(row.taxablePaise + row.cgstPaise + row.sgstPaise).toBe(row.totalPaise);
    const paid = await invoices.payment(platform, row.id, { paidPaise: row.totalPaise, paymentMode: 'UPI' });
    expect(paid.invoice?.paymentStatus).toBe('PAID');
    const pdf = await invoices.pdf(platform, row.id);
    const chunks: Buffer[] = [];
    for await (const c of pdf.getStream()) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    require('fs').writeFileSync(process.env.PDF_OUT ?? 'stock-invoice-test.pdf', buf);
    await expect(stock.deleteDoc(platform, saleId)).rejects.toThrow();
  });

  it('customer return of a damaged unit: to the damaged shelf, tracker back to stock, credit note against the invoice', async () => {
    const ret = await stock.saveDoc(platform, null, doc({ kind: 'SALES_RETURN', sourceId: saleId, customerName: 'AGP City Gas', customerStateCode: '33', reason: 'Not working', lines: [line(gt06, 0, ['866102'], 250000, 'DAMAGED')] }));
    expect((await stock.serial(platform, '866102'))[0]).toMatchObject({ status: 'DAMAGED', locationName: 'Damaged shelf' });
    expect((await prisma.device.findFirst({ where: { uniqueId: '866102' } }))?.companyId).toBeNull();
    const cn = await invoices.issue(platform, ret.id);
    expect(cn.invoice).toMatchObject({ kind: 'CREDIT_NOTE', number: 'VTX/SCN/26-27/0001', totalPaise: 250000 });
    await expect(stock.saveDoc(platform, null, doc({ kind: 'SALES_RETURN', lines: [line(gt06, 0, ['866101'])] }))).rejects.toThrow(/was not sold/);
  });

  it('reseller orders from VeeTrax → platform dispatches into the reseller store → reseller sells it', async () => {
    const po = await stock.saveDoc(resellerCtx, null, doc({ kind: 'PO', status: 'OPEN', lines: [line(gt06, 1)] }));
    expect(po).toMatchObject({ toPlatform: true, supplierName: 'VeeTrax', partnerName: 'Chennai Reseller' });
    expect((await stock.listDocs(platform, { inbox: true })).map((d) => d.id)).toContain(po.id);
    await stock.saveDoc(platform, null, doc({ kind: 'SALE', saleTo: 'PARTNER', customerPartnerId: partnerId, sourceId: po.id, lines: [line(gt06, 0, ['866101'], 200000)] }));
    expect((await stock.getDoc(resellerCtx, po.id)).status).toBe('DONE');
    const s = await stock.serial(resellerCtx, '866101');
    expect(s[0]).toMatchObject({ status: 'IN_STOCK', locationName: 'Chennai Reseller store' });
    // The reseller sells from its own store; it can not use the platform's.
    await stock.saveDoc(resellerCtx, null, doc({ kind: 'SALE', saleTo: 'CUSTOMER', customerName: 'Ravi Transport', lines: [line(gt06, 0, ['866101'], 300000)] }));
    expect((await stock.serial(platform, '866101'))[0].status).toBe('SOLD');
    const main = (await stock.locations(platform)).find((l) => l.name === 'Main store')!;
    await expect(stock.saveDoc(resellerCtx, null, doc({ kind: 'SALE', locationId: main.id, lines: [line(relay, 1)] }))).rejects.toThrow(/own store/);
    // A reseller only sees its own documents and those made for it.
    const mine = await stock.listDocs(resellerCtx, {});
    expect(mine.every((d) => d.partnerId === partnerId || d.customerPartnerId === partnerId)).toBe(true);
  });

  it('ordinary companies are refused', async () => {
    await expect(stock.items(ctxFor(platform.userId, customerId, false))).rejects.toThrow(/platform and its resellers/);
  });

  it('adjustment writes off relays; reorder level for all trackers; dashboard shows what to reorder', async () => {
    await stock.saveDoc(platform, null, doc({ kind: 'ADJUSTMENT', reason: 'Count correction', lines: [line(relay, -1)] }));
    await stock.setReorderLevel(platform, { kind: 'DEVICE', lowStockAt: 5, reorderQty: 20 });
    const d = await board.dashboard(platform);
    expect(d.unitsInStock).toBe(1); // 1 relay
    expect(d.damagedUnits).toBe(1); // 866102
    const low = Object.fromEntries(d.lowStock.map((x) => [x.itemName, x]));
    expect(low['Concox GT06N']).toMatchObject({ onHand: 0, reorderLevel: 5, onOrder: 0, suggestedQty: 20, supplierName: 'Concox India', leadTimeDays: 5, orderNow: true });
    expect(low['Relay']).toMatchObject({ onHand: 1, onOrder: 4, orderNow: false });
    expect(d.openPurchaseOrders[0]).toMatchObject({ id: poId, expectedBy: '2026-11-14', pendingQty: 4 });
    expect(d.unpaidInvoices.count).toBe(0);
  });

  it('cancelling a receipt puts stock back and reopens the PO', async () => {
    const grn = (await stock.listDocs(platform, { kind: 'RECEIPT' }))[0];
    await expect(stock.saveDoc(platform, grn.id, { ...grn, status: 'CANCELLED', lines: grn.lines })).rejects.toThrow(); // its units were sold / returned since
    const g2 = await stock.saveDoc(platform, null, doc({ kind: 'RECEIPT', supplierId, sourceId: poId, lines: [line(relay, 4)] }));
    expect((await stock.getDoc(platform, poId))).toMatchObject({ status: 'DONE', pending: [] });
    await stock.saveDoc(platform, g2.id, { ...g2, status: 'CANCELLED', lines: g2.lines });
    expect((await stock.getDoc(platform, poId)).status).toBe('PARTIAL');
  });
});

describe('one stock register: Purchases & sales keeps Stock & movements in step', () => {
  const register = async (imei: string) => {
    const d = await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei }, include: { stock: { include: { location: true } } } });
    const moves = await prisma.stockMovement.findMany({ where: { deviceId: d.id }, orderBy: { at: 'asc' } });
    return { status: d.stock?.status, location: d.stock?.location?.name ?? null, holder: d.stock?.holderPartnerId ?? null, kinds: moves.map((m) => m.kind), moves };
  };

  it('every tracker document is mirrored with movements that name the document', async () => {
    const a = await register('866101');
    // received → sold to AGP → sale edited (back) → dispatched to the reseller → reseller sold it to a walk-in buyer
    expect(a.kinds).toEqual(['RECEIVE', 'SYNC', 'SYNC', 'TRANSFER', 'STATUS']);
    expect(a.status).toBe('RETIRED');
    expect(a.moves[3]).toMatchObject({ toHolderPartnerId: partnerId });
    expect(a.moves[0].reference).toMatch(/^StockDoc:GRN\//);
    expect(a.moves[1]).toMatchObject({ toStatus: 'ASSIGNED', companyId: customerId });
    expect(await register('866102')).toMatchObject({ status: 'FAULTY', location: 'Damaged shelf' });
    expect(await register('866103')).toMatchObject({ status: 'RETURNED', location: 'Returned to supplier' });
  });

  it('the receipt, its supplier and the stores appear in Stock & movements', async () => {
    const r = await prisma.stockReceipt.findFirstOrThrow({ where: { note: { startsWith: 'From Stock & sales GRN/' } }, include: { supplier: true, location: true } });
    expect(r).toMatchObject({ supplierInvoiceNo: 'CX-778', itemCount: 3, supplier: { name: 'Concox India' }, location: { name: 'Main store', kind: 'WAREHOUSE' } });
    expect(await prisma.stockLocation.findFirst({ where: { ownerPartnerId: partnerId, kind: 'PARTNER' } })).not.toBeNull();
    expect(await prisma.deviceStock.count({ where: { receiptId: r.id } })).toBe(3);
  });

  it('a sale can use a tracker received only in Stock & movements (brought into the store first)', async () => {
    const model = await prisma.deviceModel.findFirstOrThrow();
    const main = (await stock.locations(platform)).find((l) => l.name === 'Main store')!;
    const mainLoc = (await prisma.stockStore.findUniqueOrThrow({ where: { id: main.id } })).inventoryLocationId!;
    const dev = await prisma.device.create({ data: { modelId: model.id, uniqueId: '866200', ingestToken: 't-866200' } });
    await prisma.deviceStock.create({ data: { deviceId: dev.id, status: 'IN_STOCK', locationId: mainLoc } });
    expect(await stock.availableSerials(platform, gt06, main.id, 'IN_STOCK')).toContain('866200');
    await stock.saveDoc(platform, null, doc({ kind: 'SALE', saleTo: 'CUSTOMER', customerCompanyId: customerId, customerName: 'AGP City Gas', customerStateCode: '33', lines: [line(gt06, 0, ['866200'], 250000)] }));
    const adj = (await stock.listDocs(platform, { kind: 'ADJUSTMENT' })).find((d) => d.reason.startsWith('Brought in from Stock & movements'));
    expect(adj?.lines[0].serials).toEqual(['866200']);
    expect(await register('866200')).toMatchObject({ status: 'ASSIGNED', kinds: ['SYNC'] });
  });

  it('a check finds nothing left to fix', async () => {
    expect((await stock.syncRegister(platform, true)).changes).toEqual([]);
  });
});
