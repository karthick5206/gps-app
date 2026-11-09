/**
 * Inventory service tests against a real PostgreSQL scratch database (never production).
 * Runs only when INVENTORY_IT_DATABASE_URL is set, e.g. the seeded `veetrax_inv` database:
 *   INVENTORY_IT_DATABASE_URL=postgresql://…/veetrax_inv npx jest src/inventory/inventory.integration
 * Includes the licence-safety proof: inventory operations leave LicenceSeat rows and Device.companyId / isActive
 * unchanged, and never call the seat service.
 */
import { MOBILE_TRACKER_PROTOCOL } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { AdminDevicesService } from '../masters/admin-devices/admin-devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryCatalogService } from './catalog.service';
import { InventoryStockService } from './stock.service';

const URL = process.env.INVENTORY_IT_DATABASE_URL;
const run = URL && /veetrax_inv|_test|scratch/.test(URL) && !/\/veetracer(\?|$)/.test(URL) ? describe : describe.skip;

run('inventory service (scratch database)', () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaService({ datasourceUrl: URL });
  const seatCalls: string[] = [];
  // Any seat call from an inventory path fails the test.
  const seats = {
    ensureDevice: jest.fn(async () => void seatCalls.push('ensureDevice')),
    releaseDevice: jest.fn(async () => void seatCalls.push('releaseDevice')),
  };
  const redis = { invalidateCache: jest.fn(async () => undefined) };
  const audit = new AuditService(prisma);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const devices = new AdminDevicesService(prisma, audit, redis as any, seats as any);
  const catalog = new InventoryCatalogService(prisma, audit);
  const stock = new InventoryStockService(prisma, audit, catalog, devices);

  const tag = `IT${Date.now().toString(36).toUpperCase()}`;
  let ctx: AuthContext;
  let modelId: string;
  let modelName: string;
  let companyId: string;
  let objectId: string;
  let locA: string;
  let locB: string;
  let supplierId: string;
  let existingStockDeviceId: string;

  const imei = (n: number) => `${tag}${String(n).padStart(4, '0')}`;

  /** Seeded rows plus this run's rows (other DB suites running in parallel tag theirs RP… / SM…). */
  const foreign = (ref: string | null | undefined) => !!ref && /^(IT|RP|SM)[0-9A-Z]{6,}/.test(ref) && !ref.startsWith(tag);
  async function licenceSnapshot() {
    const [seatRows, deviceRows] = await Promise.all([
      prisma.licenceSeat.findMany({ orderBy: { id: 'asc' }, select: { id: true, companyId: true, partnerId: true, deviceId: true, userId: true, fuelObjectId: true, assignedAt: true, expiresAt: true, updatedAt: true, note: true } }),
      prisma.device.findMany({ orderBy: { id: 'asc' }, select: { id: true, uniqueId: true, companyId: true, isActive: true, updatedAt: true } }),
    ]);
    return { seatRows: seatRows.filter((s) => !foreign(s.note)), deviceRows: deviceRows.filter((d) => !foreign(d.uniqueId)) };
  }

  beforeAll(async () => {
    const sa = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
    ctx = { userId: sa.id, homeCompanyId: sa.companyId, companyId: sa.companyId, isSuperAdmin: true, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: '127.0.0.1' };
    const model = await prisma.deviceModel.findFirstOrThrow({ where: { protocol: { not: MOBILE_TRACKER_PROTOCOL } } });
    modelId = model.id;
    modelName = `${model.brand} ${model.model}`;
    const company = await prisma.company.findFirstOrThrow({ where: { isPlatform: false } });
    companyId = company.id;
    objectId = (await prisma.trackedObject.create({ data: { companyId, name: `${tag} van` } })).id;
    locA = (await catalog.createLocation(ctx, { kind: 'WAREHOUSE', code: `${tag}A`, name: 'Main warehouse' })).id;
    locB = (await catalog.createLocation(ctx, { kind: 'TECHNICIAN', code: `${tag}B`, name: 'Technician van' })).id;
    supplierId = (await catalog.createSupplier(ctx, { name: `${tag} Supplier`, gstin: '29ABCDE1234F1Z5', contact: { phone: '9800000000' } })).id;
    // A pre-existing stock device registered the normal way (no company).
    existingStockDeviceId = (await devices.create(ctx, { uniqueId: imei(1), modelId })).id;
    seatCalls.length = 0;
  });

  afterAll(async () => {
    // Scratch cleanup of this run's rows only (application code never deletes movements).
    const ids = (await prisma.device.findMany({ where: { uniqueId: { startsWith: tag } }, select: { id: true } })).map((d) => d.id);
    await prisma.stockMovement.deleteMany({ where: { itemRef: { startsWith: tag } } });
    await prisma.deviceStock.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.stockReceipt.deleteMany({ where: { locationId: { in: [locA, locB].filter(Boolean) } } });
    await prisma.licenceSeat.deleteMany({ where: { note: tag } });
    await prisma.deviceAssignment.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.device.deleteMany({ where: { id: { in: ids } } });
    await prisma.trackedObject.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.stockLocation.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.supplier.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.$disconnect();
  });

  it('receives new and existing devices in one receipt, each with a RECEIVE movement', async () => {
    const before = await licenceSnapshot();
    const res = await stock.createReceipt(ctx, {
      locationId: locA,
      supplierId,
      supplierInvoiceNo: `${tag}-INV1`,
      supplierInvoiceAt: '2026-11-01',
      items: [
        { uniqueId: imei(2), modelId, serialNumber: `${tag}-S2`, unitCostPaise: 149900, warrantyUntil: '2027-11-30', condition: 'NEW' },
        { uniqueId: imei(3), modelId },
        { deviceId: existingStockDeviceId, serialNumber: `${tag}-S1` },
      ],
    });
    expect(res).toMatchObject({ created: 2, received: 3, receipt: { itemCount: 3, source: 'MANUAL', supplier: { id: supplierId } } });
    const created = await prisma.device.findMany({ where: { uniqueId: { in: [imei(2), imei(3)] } } });
    expect(created).toHaveLength(2);
    for (const d of created) expect({ companyId: d.companyId, isActive: d.isActive }).toEqual({ companyId: null, isActive: true });
    const rows = await prisma.deviceStock.findMany({ where: { receiptId: res.receipt.id } });
    expect(rows.map((r) => r.status)).toEqual(['IN_STOCK', 'IN_STOCK', 'IN_STOCK']);
    const moves = await prisma.stockMovement.findMany({ where: { receiptId: res.receipt.id } });
    expect(moves).toHaveLength(3);
    expect(moves.every((m) => m.kind === 'RECEIVE' && m.toLocationId === locA && m.createdById === ctx.userId && m.reference === `${tag}-INV1`)).toBe(true);
    expect(seatCalls).toEqual([]);
    const after = await licenceSnapshot();
    expect(after.seatRows).toEqual(before.seatRows);
    // Only the two new devices were added; no existing device row changed.
    expect(after.deviceRows.filter((d) => before.deviceRows.some((b) => b.id === d.id))).toEqual(before.deviceRows);
  });

  it('prevents duplicate IMEIs and double receipts, all-or-nothing', async () => {
    await expect(stock.createReceipt(ctx, { locationId: locA, items: [{ uniqueId: imei(2), modelId }] })).rejects.toThrow(/Already has a stock record/);
    await expect(stock.createReceipt(ctx, { locationId: locA, items: [{ uniqueId: imei(9), modelId }, { uniqueId: imei(9), modelId }] })).rejects.toThrow(/Same device as item 1/);
    await expect(stock.createReceipt(ctx, { locationId: locA, items: [{ uniqueId: imei(10) }] })).rejects.toThrow(/model is required/);
    await expect(stock.createReceipt(ctx, { locationId: locA, items: [{ uniqueId: imei(11), modelId, serialNumber: `${tag}-S2` }] })).rejects.toThrow(/Serial number already recorded/);
    expect(await prisma.device.count({ where: { uniqueId: { in: [imei(9), imei(10), imei(11)] } } })).toBe(0);
  });

  it('refuses to receive a device that is in a customer account', async () => {
    const d = await prisma.device.create({ data: { uniqueId: imei(20), modelId, companyId, ingestToken: `${tag}tok20` } });
    await expect(stock.createReceipt(ctx, { locationId: locA, items: [{ deviceId: d.id }] })).rejects.toThrow(/customer account/);
  });

  it('changes status through the state machine with reasons and ledger rows', async () => {
    const id = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(2) } })).id;
    await expect(stock.changeStatus(ctx, id, { status: 'ACTIVE' })).rejects.toThrow(/Cannot change status/);
    await expect(stock.changeStatus(ctx, id, { status: 'ASSIGNED' })).rejects.toThrow(/Assign the device to a customer/);
    await expect(stock.changeStatus(ctx, id, { status: 'FAULTY' })).rejects.toThrow(/reason is required/);
    const faulty = await stock.changeStatus(ctx, id, { status: 'FAULTY', reason: 'No GNSS fix on bench test', reference: 'QC-7' });
    expect(faulty).toMatchObject({ status: 'FAULTY', location: { id: locA }, mismatch: false });
    const repair = await stock.changeStatus(ctx, id, { status: 'UNDER_REPAIR', toLocationId: locB });
    expect(repair).toMatchObject({ status: 'UNDER_REPAIR', location: { id: locB } });
    await stock.changeStatus(ctx, id, { status: 'IN_STOCK', toLocationId: locA });
    const retired = await stock.changeStatus(ctx, id, { status: 'RETIRED', reason: 'Water damage' });
    expect(retired.status).toBe('RETIRED');
    await expect(stock.changeStatus(ctx, id, { status: 'IN_STOCK' })).rejects.toThrow(/Cannot change status/);
    const history = (await stock.movements({ deviceId: id, pageSize: 50 })) as { items: { kind: string; fromStatus: string | null; toStatus: string; reason: string | null; createdByName: string | null }[] };
    expect(history.items.map((m) => `${m.kind}:${m.fromStatus ?? '-'}>${m.toStatus}`)).toEqual([
      'STATUS:IN_STOCK>RETIRED',
      'STATUS:UNDER_REPAIR>IN_STOCK',
      'STATUS:FAULTY>UNDER_REPAIR',
      'STATUS:IN_STOCK>FAULTY',
      'RECEIVE:->IN_STOCK',
    ]);
    expect(history.items[3].reason).toBe('No GNSS fix on bench test');
    expect(history.items[0].createdByName).toBeTruthy();
  });

  it('adjusts with a mandatory reason, may correct a retired unit, records field changes', async () => {
    const id = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(2) } })).id;
    await expect(stock.adjust(ctx, id, { reason: 'Retired by mistake', status: 'ACTIVE' })).rejects.toThrow(/Assign the device/);
    const fixed = await stock.adjust(ctx, id, { reason: 'Retired by mistake', status: 'IN_STOCK', unitCostPaise: 139900, condition: 'REFURBISHED' });
    expect(fixed).toMatchObject({ status: 'IN_STOCK', unitCostPaise: 139900, condition: 'REFURBISHED' });
    await expect(stock.adjust(ctx, id, { reason: 'Nothing really' })).rejects.toThrow(/Nothing to adjust/);
    const last = await prisma.stockMovement.findFirstOrThrow({ where: { deviceId: id }, orderBy: { at: 'desc' } });
    expect(last).toMatchObject({ kind: 'ADJUST', reason: 'Retired by mistake', fromStatus: 'RETIRED', toStatus: 'IN_STOCK' });
    expect(last.changes).toMatchObject({ status: { from: 'RETIRED', to: 'IN_STOCK' }, unitCostPaise: { from: 149900, to: 139900 }, condition: { from: 'NEW', to: 'REFURBISHED' } });
  });

  it('transfers between locations and to a partner holder without touching the owner', async () => {
    const id = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(3) } })).id;
    const partner = await prisma.partner.findFirstOrThrow();
    const moved = await stock.transfer(ctx, id, { toLocationId: locB, holderPartnerId: partner.id, reference: 'AWB123' });
    expect(moved).toMatchObject({ location: { id: locB }, holderPartner: { id: partner.id }, status: 'IN_STOCK', company: null });
    await expect(stock.transfer(ctx, id, { toLocationId: locB })).rejects.toThrow(/Nothing changes/);
    const back = await stock.transfer(ctx, id, { toLocationId: locA, holderPartnerId: null });
    expect(back).toMatchObject({ location: { id: locA }, holderPartner: null });
    const m = await prisma.stockMovement.findMany({ where: { deviceId: id, kind: 'TRANSFER' }, orderBy: { at: 'asc' } });
    expect(m.map((x) => [x.fromLocationId, x.toLocationId, x.toHolderPartnerId, x.reference])).toEqual([
      [locA, locB, partner.id, 'AWB123'],
      [locB, locA, null, null],
    ]);
  });

  it('records the existing assignment (sync) and keeps ACTIVE consistent with it — licence safety', async () => {
    const id = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(3) } })).id;
    // The EXISTING admin flow (not inventory) assigns the device to a customer, fits it and gives it a seat.
    await prisma.device.update({ where: { id }, data: { companyId } });
    await prisma.deviceAssignment.create({ data: { deviceId: id, objectId } });
    await prisma.licenceSeat.create({ data: { type: 'GPS_DEVICE', companyId, source: 'OVERRIDE', activatedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), deviceId: id, assignedAt: new Date(), note: tag } });

    const before = await licenceSnapshot();
    const listed = (await stock.list({ q: imei(3) })) as { items: { mismatch: boolean; derivedStatus: string; licence: { status: string } }[] };
    expect(listed.items[0]).toMatchObject({ mismatch: true, derivedStatus: 'ACTIVE', licence: { status: 'ACTIVE' } });
    expect(((await stock.list({ mismatch: 'true', q: tag })) as { total: number }).total).toBeGreaterThanOrEqual(1);

    await expect(stock.changeStatus(ctx, id, { status: 'RESERVED' })).rejects.toThrow(/customer account/);
    const synced = await stock.sync(ctx, id, {});
    expect(synced).toMatchObject({ status: 'ACTIVE', location: null, mismatch: false, company: { id: companyId }, object: { id: objectId } });
    const sm = await prisma.stockMovement.findFirstOrThrow({ where: { deviceId: id, kind: 'SYNC' } });
    expect(sm).toMatchObject({ companyId, objectId, fromStatus: 'IN_STOCK', toStatus: 'ACTIVE', fromLocationId: locA, toLocationId: null });
    expect(sm.reference).toMatch(/^DeviceAssignment:/);
    await expect(stock.sync(ctx, id, {})).rejects.toThrow(/already matches/);
    await expect(stock.transfer(ctx, id, { toLocationId: locB })).rejects.toThrow(/at the customer/);
    // Faulty / returned are facts only: no seat release, no deactivation, owner unchanged.
    await stock.changeStatus(ctx, id, { status: 'FAULTY', reason: 'Customer reports no data', toLocationId: locB });
    await stock.changeStatus(ctx, id, { status: 'RETURNED', reason: 'Swapped by technician' });
    await stock.adjust(ctx, id, { reason: 'Serial found on label', serialNumber: `${tag}-S3` });
    await expect(stock.changeStatus(ctx, id, { status: 'IN_STOCK' })).rejects.toThrow(/customer account/);

    const after = await licenceSnapshot();
    expect(after).toEqual(before);
    expect(seatCalls).toEqual([]);
    const seat = await prisma.licenceSeat.findUniqueOrThrow({ where: { deviceId: id } });
    expect(seat.companyId).toBe(companyId);
  });

  it('CSV import: dry-run report first, refuses to apply with errors, applies cleanly as one receipt', async () => {
    const csv = [
      'imei,model,serial,unit_cost,warranty_until,condition',
      `${imei(30)},${modelName},${tag}-S30,999,2028-01-31,NEW`,
      `${imei(31)},${modelName},,,,`,
      `${imei(1)},${modelName},,,,`,
      `${imei(32)},No Such Model,,,,`,
    ].join('\n');
    const dry = await stock.importCsv(ctx, { csv, locationId: locA, supplierId });
    expect(dry).toMatchObject({ dryRun: true, applied: false, summary: { rows: 4, createDevice: 2, addStock: 0, errors: 2 } });
    expect(dry.rows.find((r) => r.line === 4)?.errors.join()).toMatch(/Already has a stock record/);
    expect(dry.rows.find((r) => r.line === 5)?.errors.join()).toMatch(/Unknown device model/);
    const refused = await stock.importCsv(ctx, { csv, locationId: locA, dryRun: false });
    expect(refused).toMatchObject({ applied: false, receiptId: null });
    expect(await prisma.device.count({ where: { uniqueId: { in: [imei(30), imei(31)] } } })).toBe(0);

    const before = await licenceSnapshot();
    const clean = csv.split('\n').slice(0, 3).join('\n');
    const applied = await stock.importCsv(ctx, { csv: clean, locationId: locA, supplierId, supplierInvoiceNo: `${tag}-CSV`, dryRun: false });
    expect(applied).toMatchObject({ applied: true, summary: { createDevice: 2, errors: 0 } });
    const receipt = await stock.getReceipt(applied.receiptId!);
    expect(receipt).toMatchObject({ source: 'CSV_IMPORT', itemCount: 2 });
    const s30 = await stock.get((await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(30) } })).id);
    expect(s30).toMatchObject({ status: 'IN_STOCK', unitCostPaise: 99900, warrantyUntil: '2028-01-31', serialNumber: `${tag}-S30`, supplierName: `${tag} Supplier` });
    const after = await licenceSnapshot();
    expect(after.seatRows).toEqual(before.seatRows);
    expect(after.deviceRows.filter((d) => before.deviceRows.some((b) => b.id === d.id))).toEqual(before.deviceRows);
    expect(seatCalls).toEqual([]);
  });

  it('lists, filters, summarises and exports', async () => {
    const page = (await stock.list({ q: tag, stockStatus: 'IN_STOCK', locationId: locA, pageSize: 50 })) as { items: { uniqueId: string }[]; total: number };
    expect(page.items.map((i) => i.uniqueId).sort()).toEqual([imei(1), imei(2), imei(30), imei(31)].sort());
    const summary = await stock.summary();
    expect(summary.byStatus.IN_STOCK).toBeGreaterThanOrEqual(4);
    expect(summary.untracked).toBeGreaterThan(0);
    const csv = await stock.list({ q: tag, format: 'csv' });
    expect(csv.constructor.name).toBe('StreamableFile');
    const moves = await stock.movements({ q: tag, format: 'csv' });
    expect(moves.constructor.name).toBe('StreamableFile');
  });

  it('keeps locations and suppliers that the ledger references', async () => {
    await expect(catalog.removeLocation(ctx, locB)).rejects.toThrow(/In use/);
    await expect(catalog.removeSupplier(ctx, supplierId)).rejects.toThrow(/In use/);
    await expect(catalog.createLocation(ctx, { kind: 'WAREHOUSE', code: `${tag}A`, name: 'dup' })).rejects.toThrow(/already exists/);
    const spare = await catalog.createLocation(ctx, { kind: 'SCRAP', code: `${tag}X`, name: 'Spare' });
    await catalog.removeLocation(ctx, spare.id);
    await catalog.updateLocation(ctx, locB, { isActive: false });
    const id = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(31) } })).id;
    await expect(stock.transfer(ctx, id, { toLocationId: locB })).rejects.toThrow(/inactive/);
  });

  it('movement ledger survives a device purge (link nulled, IMEI kept)', async () => {
    const id = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(31) } })).id;
    const n = await prisma.stockMovement.count({ where: { deviceId: id } });
    expect(n).toBeGreaterThan(0);
    await devices.remove(ctx, id);
    expect(await prisma.deviceStock.count({ where: { deviceId: id } })).toBe(0);
    expect(await prisma.stockMovement.count({ where: { itemRef: imei(31), deviceId: null } })).toBe(n);
  });
});
