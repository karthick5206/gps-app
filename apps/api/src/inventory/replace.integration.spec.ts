/**
 * Device replacement + inventory dashboard against the scratch database (INVENTORY_IT_DATABASE_URL; never production).
 * Licence-safety proof for the replacement: the vehicle fitting goes through the existing ObjectsService flow, and
 * every LicenceSeat row plus Device.companyId / isActive stay byte-identical; the seat service is never called.
 */
import { MOBILE_TRACKER_PROTOCOL } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { AdminDevicesService } from '../masters/admin-devices/admin-devices.service';
import { ObjectsService } from '../masters/objects/objects.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryCatalogService } from './catalog.service';
import { dayKeys, InventoryDashboardService } from './dashboard.service';
import { InventoryReplaceService } from './replace.service';
import { InventoryStockService } from './stock.service';

const URL = process.env.INVENTORY_IT_DATABASE_URL;
const run = URL && /veetrax_inv|_test|scratch/.test(URL) && !/\/veetracer(\?|$)/.test(URL) ? describe : describe.skip;

describe('dayKeys', () => {
  it('returns one calendar day per day of the window, oldest first, ending today', () => {
    const keys = dayKeys(7, new Date('2026-11-09T20:00:00Z'), 'Asia/Kolkata');
    expect(keys).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
  });
});

run('device replacement and dashboard (scratch database)', () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaService({ datasourceUrl: URL });
  const seatCalls: string[] = [];
  const seats = {
    ensureDevice: jest.fn(async () => void seatCalls.push('ensureDevice')),
    releaseDevice: jest.fn(async () => void seatCalls.push('releaseDevice')),
  };
  const redis = { invalidateCache: jest.fn(async () => undefined), client: { get: jest.fn(async () => null), set: jest.fn() } };
  const audit = new AuditService(prisma);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const devices = new AdminDevicesService(prisma, audit, redis as any, seats as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objects = new ObjectsService(prisma, audit, redis as any);
  const catalog = new InventoryCatalogService(prisma, audit);
  const stock = new InventoryStockService(prisma, audit, catalog, devices);
  const replacer = new InventoryReplaceService(prisma, catalog, objects, stock);
  const dashboards = new InventoryDashboardService(prisma, stock);

  const tag = `RP${Date.now().toString(36).toUpperCase()}`;
  const imei = (n: number) => `${tag}${String(n).padStart(4, '0')}`;
  let ctx: AuthContext;
  let modelId: string;
  let companyId: string;
  let otherCompanyId: string;
  let objectId: string;
  let loc: string;
  let rma: string;
  const ids: Record<string, string> = {};

  /** Seeded rows plus this run's rows (other DB suites running in parallel tag theirs IT… / SM…; see sims spec). */
  const foreign = (ref: string | null | undefined) => !!ref && /^(IT|RP|SM)[0-9A-Z]{6,}/.test(ref) && !ref.startsWith(tag);
  async function licenceSnapshot() {
    const [seatRows, deviceRows] = await Promise.all([
      prisma.licenceSeat.findMany({ orderBy: { id: 'asc' }, select: { id: true, companyId: true, partnerId: true, deviceId: true, userId: true, fuelObjectId: true, assignedAt: true, expiresAt: true, updatedAt: true, note: true } }),
      prisma.device.findMany({ orderBy: { id: 'asc' }, select: { id: true, uniqueId: true, companyId: true, isActive: true } }),
    ]);
    return { seatRows: seatRows.filter((s) => !foreign(s.note)), deviceRows: deviceRows.filter((d) => !foreign(d.uniqueId)) };
  }

  beforeAll(async () => {
    const sa = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
    ctx = { userId: sa.id, homeCompanyId: sa.companyId, companyId: sa.companyId, isSuperAdmin: true, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: '127.0.0.1' };
    modelId = (await prisma.deviceModel.findFirstOrThrow({ where: { protocol: { not: MOBILE_TRACKER_PROTOCOL } } })).id;
    const companies = await prisma.company.findMany({ where: { isPlatform: false }, take: 2, orderBy: { createdAt: 'asc' } });
    companyId = companies[0].id;
    otherCompanyId = companies[1]?.id ?? companies[0].id;
    objectId = (await prisma.trackedObject.create({ data: { companyId, name: `${tag} truck` } })).id;
    loc = (await catalog.createLocation(ctx, { kind: 'WAREHOUSE', code: `${tag}W`, name: 'Replace WH' })).id;
    rma = (await catalog.createLocation(ctx, { kind: 'SUPPLIER_RMA', code: `${tag}R`, name: 'RMA shelf' })).id;
    // Old (fitted) and new (spare) units: received into stock, then the EXISTING admin flow puts them in the customer
    // account with a seat each (simulated directly, as the existing flow would), and fits the old one.
    await stock.createReceipt(ctx, { locationId: loc, items: [{ uniqueId: imei(1), modelId, unitCostPaise: 250000 }, { uniqueId: imei(2), modelId, unitCostPaise: 260000 }, { uniqueId: imei(3), modelId }] });
    for (const n of [1, 2, 3]) ids[n] = (await prisma.device.findUniqueOrThrow({ where: { uniqueId: imei(n) } })).id;
    for (const n of [1, 2]) {
      await prisma.device.update({ where: { id: ids[n] }, data: { companyId } });
      await prisma.licenceSeat.create({ data: { type: 'GPS_DEVICE', companyId, source: 'OVERRIDE', activatedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), deviceId: ids[n], assignedAt: new Date(), note: tag } });
    }
    await prisma.deviceAssignment.create({ data: { deviceId: ids[1], objectId } });
    await stock.sync(ctx, ids[1], {});
    await stock.sync(ctx, ids[2], {});
    seatCalls.length = 0;
  });

  afterAll(async () => {
    const all = Object.values(ids);
    await prisma.stockMovement.deleteMany({ where: { itemRef: { startsWith: tag } } });
    await prisma.deviceStock.deleteMany({ where: { deviceId: { in: all } } });
    await prisma.stockReceipt.deleteMany({ where: { locationId: { in: [loc, rma].filter(Boolean) } } });
    await prisma.licenceSeat.deleteMany({ where: { note: tag } });
    await prisma.deviceAssignment.deleteMany({ where: { deviceId: { in: all } } });
    await prisma.device.deleteMany({ where: { id: { in: all } } });
    await prisma.trackedObject.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.stockLocation.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.$disconnect();
  });

  it('refuses replacements the existing rules would not allow, without changing anything', async () => {
    const before = await licenceSnapshot();
    // Spare still in platform stock: must be assigned to the customer in Device Inventory first.
    await expect(replacer.replace(ctx, { objectId, newDeviceId: ids[3], reason: 'No GPS fix' })).rejects.toThrow(/Device Inventory first/);
    await expect(replacer.replace(ctx, { objectId, newDeviceId: ids[1], reason: 'No GPS fix' })).rejects.toThrow(/already fitted/);
    if (otherCompanyId !== companyId) {
      await prisma.device.update({ where: { id: ids[3] }, data: { companyId: otherCompanyId } });
      await expect(replacer.replace(ctx, { objectId, newDeviceId: ids[3], reason: 'No GPS fix' })).rejects.toThrow(/another customer/);
      await prisma.device.update({ where: { id: ids[3] }, data: { companyId: null } });
    }
    // Other suites may run in parallel on the same company: check only this run's devices.
    const mine = (await replacer.candidates(objectId)).map((c) => c.uniqueId).filter((u) => u.startsWith(tag));
    expect(mine).toEqual([imei(2)]);
    const after = await licenceSnapshot();
    expect(after.seatRows).toEqual(before.seatRows);
    expect(seatCalls).toEqual([]);
  });

  it('fits the new unit through the existing vehicle flow and records both units — seats unchanged', async () => {
    const before = await licenceSnapshot();
    const res = await replacer.replace(ctx, { objectId, newDeviceId: ids[2], oldStatus: 'FAULTY', returnLocationId: rma, reason: 'No GPS fix after power surge', reference: 'TKT-42' });
    expect(res).toMatchObject({ objectId, oldDevice: { id: ids[1], status: 'FAULTY' }, newDevice: { id: ids[2], status: 'ACTIVE' }, seatsChanged: false });

    // Existing assignment flow did the fitting.
    const open = await prisma.deviceAssignment.findMany({ where: { objectId, toTime: null } });
    expect(open.map((a) => a.deviceId)).toEqual([ids[2]]);
    expect(await prisma.deviceAssignment.count({ where: { deviceId: ids[1], objectId, toTime: { not: null } } })).toBe(1);

    // Inventory side.
    expect(await stock.get(ids[1])).toMatchObject({ status: 'FAULTY', location: { id: rma }, mismatch: false });
    expect(await stock.get(ids[2])).toMatchObject({ status: 'ACTIVE', location: null, mismatch: false, object: { id: objectId } });
    const moves = await prisma.stockMovement.findMany({ where: { kind: 'REPLACE', objectId }, orderBy: { itemRef: 'asc' } });
    expect(moves.map((m) => [m.itemRef, m.fromStatus, m.toStatus, m.companyId, m.reference])).toEqual([
      [imei(1), 'ACTIVE', 'FAULTY', companyId, 'TKT-42'],
      [imei(2), 'ASSIGNED', 'ACTIVE', companyId, 'TKT-42'],
    ]);
    expect(await prisma.auditLog.count({ where: { entity: 'stock_replace', entityId: objectId } })).toBe(1);

    // Licence safety: no seat row and no device owner / active flag changed; the seat service was never called.
    const after = await licenceSnapshot();
    expect(after).toEqual(before);
    expect(seatCalls).toEqual([]);
    expect((await prisma.licenceSeat.findUniqueOrThrow({ where: { deviceId: ids[1] } })).companyId).toBe(companyId);
    expect((await prisma.licenceSeat.findUniqueOrThrow({ where: { deviceId: ids[2] } })).companyId).toBe(companyId);
  });

  it('dashboard totals, model breakdown, movement days and valuation come from the inventory tables', async () => {
    const d = await dashboards.dashboard(30);
    expect(d.windowDays).toBe(30);
    expect(d.movements).toHaveLength(30);
    expect(d.movements.reduce((s, m) => s + (m.byKind.REPLACE ?? 0), 0)).toBeGreaterThanOrEqual(2);
    expect(d.totals.tracked).toBe(Object.values(d.byStatus).reduce((a, b) => a + b, 0));
    expect(d.totals.needsAttention).toBeGreaterThanOrEqual(1);
    expect(d.byModel.length).toBeGreaterThan(0);
    const rmaRow = d.byLocation.find((l) => l.locationId === rma);
    expect(rmaRow).toMatchObject({ count: 1, valuePaise: 250000 });
    expect(d.valuation.heldValuePaise).toBeGreaterThanOrEqual(510000);
    expect(d.valuation.costedUnits + d.valuation.uncostedUnits).toBe(d.totals.tracked - d.byStatus.RETIRED);
  });
});
