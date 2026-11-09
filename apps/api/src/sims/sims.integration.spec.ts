/**
 * SIM management + tenant asset view against the scratch database (INVENTORY_IT_DATABASE_URL; never production).
 * Includes the licence / device safety proof (every LicenceSeat row and the Device columns companyId, isActive,
 * simNumber, simOperator, iccid stay identical around every SIM operation) and tenant-isolation checks.
 */
import { MOBILE_TRACKER_PROTOCOL } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { InventoryCatalogService } from '../inventory/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssetLinksService } from './asset-links.service';
import { SimsService } from './sims.service';

const URL = process.env.INVENTORY_IT_DATABASE_URL;
const run = URL && /veetrax_inv|_test|scratch/.test(URL) && !/\/veetracer(\?|$)/.test(URL) ? describe : describe.skip;

run('SIM management (scratch database)', () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaService({ datasourceUrl: URL });
  const audit = new AuditService(prisma);
  const catalog = new InventoryCatalogService(prisma, audit);
  const sims = new SimsService(prisma, audit, catalog);
  const links = new AssetLinksService(prisma);

  const tag = `SM${Date.now().toString(36).toUpperCase()}`;
  // 19-digit ICCIDs unique to this run.
  const base = BigInt(`89910${String(Date.now()).slice(-10)}0000`);
  const iccid = (n: number) => String(base + BigInt(n));
  const stamp = String(Date.now()).slice(-6);
  const msisdn = (n: number) => `91${stamp}${String(n).padStart(4, "0")}`;
  let ctx: AuthContext;
  let providerId: string;
  let planId: string;
  let otherProviderPlan: string;
  let loc: string;
  let companyA: string;
  let companyB: string;
  let objectA: string;
  let objectB: string;
  const dev: Record<string, string> = {};

  /**
   * Every seeded row plus this run's rows. Rows of other DB suites running in parallel (tagged IT… / RP… / SM… by
   * those suites) are left out because they legitimately change meanwhile; run with --runInBand for a fully global view.
   */
  const foreign = (ref: string | null | undefined) => !!ref && /^(IT|RP|SM)[0-9A-Z]{6,}/.test(ref) && !ref.startsWith(tag);
  async function safetySnapshot() {
    const [seatRows, deviceRows, assignments] = await Promise.all([
      prisma.licenceSeat.findMany({ orderBy: { id: 'asc' }, select: { id: true, companyId: true, deviceId: true, userId: true, fuelObjectId: true, assignedAt: true, expiresAt: true, updatedAt: true, note: true } }),
      prisma.device.findMany({ orderBy: { id: 'asc' }, select: { id: true, uniqueId: true, companyId: true, isActive: true, simNumber: true, simOperator: true, iccid: true, updatedAt: true } }),
      prisma.deviceAssignment.findMany({ orderBy: { id: 'asc' }, select: { id: true, deviceId: true, objectId: true, toTime: true, device: { select: { uniqueId: true } } } }),
    ]);
    return {
      seatRows: seatRows.filter((s) => !foreign(s.note)),
      deviceRows: deviceRows.filter((d) => !foreign(d.uniqueId)),
      assignments: assignments.filter((a) => !foreign(a.device.uniqueId)),
    };
  }

  const tenantCtx = (companyId: string, extra: Partial<AuthContext> = {}): AuthContext => ({
    userId: ctx.userId,
    homeCompanyId: companyId,
    companyId,
    isSuperAdmin: false,
    permissions: { objects: ['view'], devices: ['view'] },
    dataScope: 'COMPANY',
    branchIds: [],
    objectIds: [],
    ip: null,
    ...extra,
  });

  beforeAll(async () => {
    const sa = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
    ctx = { userId: sa.id, homeCompanyId: sa.companyId, companyId: sa.companyId, isSuperAdmin: true, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: '127.0.0.1' };
    const model = await prisma.deviceModel.findFirstOrThrow({ where: { protocol: { not: MOBILE_TRACKER_PROTOCOL } } });
    const a = await prisma.company.findFirstOrThrow({ where: { isPlatform: false } });
    companyA = a.id;
    companyB = (await prisma.company.create({ data: { partnerId: a.partnerId, name: `${tag} Beta Co` } })).id;
    objectA = (await prisma.trackedObject.create({ data: { companyId: companyA, name: `${tag} A-van` } })).id;
    objectB = (await prisma.trackedObject.create({ data: { companyId: companyB, name: `${tag} B-van` } })).id;
    for (const [k, companyId] of [['a', companyA], ['b', companyB], ['stock', null]] as const) {
      dev[k] = (await prisma.device.create({ data: { uniqueId: `${tag}${k}`, ingestToken: `${tag}${k}tok`, modelId: model.id, companyId, simNumber: k === 'a' ? '+91 90000 11111' : null, iccid: k === 'a' ? '8991000000000000001F' : null } })).id;
    }
    await prisma.deviceAssignment.create({ data: { deviceId: dev.a, objectId: objectA } });
    await prisma.deviceAssignment.create({ data: { deviceId: dev.b, objectId: objectB } });
    await prisma.licenceSeat.create({ data: { type: 'GPS_DEVICE', companyId: companyA, source: 'OVERRIDE', activatedAt: new Date(), expiresAt: new Date(Date.now() + 200 * 86_400_000), deviceId: dev.a, assignedAt: new Date(), note: tag } });
    providerId = (await sims.createProvider(ctx, { name: `${tag} Airtel`, kind: 'M2M_AGGREGATOR' })).id;
    planId = (await sims.createPlan(ctx, { providerId, name: 'M2M 1GB', validityDays: 365, costPaise: 30000, dataMbPerMonth: 1024 })).id;
    const other = await sims.createProvider(ctx, { name: `${tag} Jio` });
    otherProviderPlan = (await sims.createPlan(ctx, { providerId: other.id, name: 'Other', validityDays: 30, costPaise: 5000 })).id;
    loc = (await catalog.createLocation(ctx, { kind: 'WAREHOUSE', code: `${tag}S`, name: 'SIM shelf' })).id;
  });

  afterAll(async () => {
    const simIds = (await prisma.simCard.findMany({ where: { provider: { name: { startsWith: tag } } }, select: { id: true } })).map((s) => s.id);
    await prisma.simEvent.deleteMany({ where: { OR: [{ simId: { in: simIds } }, { deviceRef: { startsWith: tag } }, { iccidRef: { in: Array.from({ length: 20 }, (_, i) => iccid(i)) } }] } });
    await prisma.simUsage.deleteMany({ where: { simId: { in: simIds } } });
    await prisma.simAssignment.deleteMany({ where: { simId: { in: simIds } } });
    await prisma.simCard.deleteMany({ where: { id: { in: simIds } } });
    await prisma.simPlan.deleteMany({ where: { provider: { name: { startsWith: tag } } } });
    await prisma.simProvider.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.licenceSeat.deleteMany({ where: { note: tag } });
    await prisma.deviceAssignment.deleteMany({ where: { deviceId: { in: Object.values(dev) } } });
    await prisma.device.deleteMany({ where: { id: { in: Object.values(dev) } } });
    await prisma.trackedObject.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.stockLocation.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.auditLog.deleteMany({ where: { companyId: companyB } });
    await prisma.company.deleteMany({ where: { id: companyB } });
    await prisma.$disconnect();
  });

  it('registers SIMs with ICCID / MSISDN uniqueness and normalisation', async () => {
    const s = await sims.create(ctx, { iccid: `${iccid(1).slice(0, 4)} ${iccid(1).slice(4)}F`, msisdn: `+${msisdn(1)}`, providerId, planId, locationId: loc, renewalDueAt: '2027-01-31' });
    expect(s).toMatchObject({ iccid: iccid(1), msisdn: msisdn(1), status: 'AVAILABLE', plan: { id: planId }, location: { id: loc }, renewalDueAt: '2027-01-31', device: null });
    await expect(sims.create(ctx, { iccid: iccid(1), providerId })).rejects.toThrow(/already registered/);
    await expect(sims.create(ctx, { iccid: iccid(2), msisdn: msisdn(1), providerId })).rejects.toThrow(/already on another SIM/);
    await expect(sims.create(ctx, { iccid: '1234', providerId })).rejects.toThrow(/18-22 digits/);
    await expect(sims.create(ctx, { iccid: iccid(2), providerId, planId: otherProviderPlan })).rejects.toThrow(/another provider/);
    const ev = await prisma.simEvent.findMany({ where: { simId: s.id } });
    expect(ev.map((e) => [e.kind, e.toStatus])).toEqual([['REGISTER', 'AVAILABLE']]);
  });

  it('follows the status machine with reasons; assign / transfer / unassign never write Device rows or seats', async () => {
    const before = await safetySnapshot();
    const s1 = (await prisma.simCard.findUniqueOrThrow({ where: { iccid: iccid(1) } })).id;
    const s2 = (await sims.create(ctx, { iccid: iccid(2), msisdn: msisdn(2), providerId })).id;

    await sims.changeStatus(ctx, s1, { status: 'ACTIVE' });
    expect((await sims.get(s1)).activatedAt).not.toBeNull();
    await expect(sims.changeStatus(ctx, s1, { status: 'SUSPENDED' })).rejects.toThrow(/reason is required/);
    await expect(sims.changeStatus(ctx, s1, { status: 'RESERVED' })).rejects.toThrow(/Cannot change/);

    // Assign to device A (fitted to company A's vehicle); then transfer to the stock device; then displace with SIM 2.
    const a1 = await sims.assign(ctx, s1, { deviceId: dev.a, reason: 'Installed' });
    expect(a1.device).toMatchObject({ id: dev.a, uniqueId: `${tag}a`, simNumber: '+91 90000 11111' });
    expect(a1.reconcile.sort()).toEqual(['ICCID_DIFFERS', 'MSISDN_DIFFERS']);
    await expect(sims.assign(ctx, s1, { deviceId: dev.a })).rejects.toThrow(/already in this device/);
    await expect(sims.changeStatus(ctx, s1, { status: 'DEACTIVATED', reason: 'Lost' })).rejects.toThrow(/out of its device/);
    await sims.assign(ctx, s1, { deviceId: dev.stock, reason: 'Moved for test' });
    await sims.assign(ctx, s2, { deviceId: dev.stock });
    expect((await sims.get(s1)).device).toBeNull();
    expect((await sims.get(s2)).device?.id).toBe(dev.stock);
    expect(await prisma.simAssignment.count({ where: { deviceId: dev.stock, toTime: null } })).toBe(1);
    await sims.unassign(ctx, s2, { reason: 'Back to shelf' });
    await expect(sims.unassign(ctx, s2, {})).rejects.toThrow(/not in a device/);

    await sims.changeStatus(ctx, s1, { status: 'SUSPENDED', reason: 'Non-payment notice' });
    await sims.changeStatus(ctx, s1, { status: 'EXPIRED' });
    const renewed = await sims.renew(ctx, s1, { renewalDueAt: '2028-01-31', note: 'Paid 1y' });
    expect(renewed).toMatchObject({ status: 'ACTIVE', renewalDueAt: '2028-01-31' });
    await sims.changeStatus(ctx, s2, { status: 'DAMAGED', reason: 'Broken chip' });
    await expect(sims.assign(ctx, s2, { deviceId: dev.stock })).rejects.toThrow(/cannot be fitted/);
    await sims.changeStatus(ctx, s2, { status: 'DEACTIVATED', reason: 'Written off' });
    await expect(sims.changeStatus(ctx, s2, { status: 'ACTIVE' })).rejects.toThrow(/Cannot change/);
    await expect(sims.renew(ctx, s2, { renewalDueAt: '2028-01-31' })).rejects.toThrow(/cannot be renewed/);

    // Events written in one transaction can share a millisecond, so compare as a multiset.
    const kinds = (await prisma.simEvent.findMany({ where: { simId: s1 } })).map((e) => e.kind).sort();
    expect(kinds).toEqual(['ASSIGN', 'ASSIGN', 'REGISTER', 'RENEW', 'STATUS', 'STATUS', 'STATUS', 'UNASSIGN', 'UNASSIGN']);
    const displaced = await prisma.simEvent.findFirstOrThrow({ where: { simId: s1, kind: 'UNASSIGN', reason: { startsWith: 'Replaced by SIM' } } });
    expect(displaced.deviceRef).toBe(`${tag}stock`);
    const history = await sims.assignments(s1);
    expect(history.map((h) => [h.deviceRef, h.toTime === null])).toEqual([
      [`${tag}stock`, false],
      [`${tag}a`, false],
    ]);

    // Licence / device safety.
    const after = await safetySnapshot();
    expect(after).toEqual(before);
    expect((await prisma.licenceSeat.findUniqueOrThrow({ where: { deviceId: dev.a } })).companyId).toBe(companyA);
  });

  it('manual usage entries, edit, renewals report, summary and reconciliation filter', async () => {
    const s1 = (await prisma.simCard.findUniqueOrThrow({ where: { iccid: iccid(1) } })).id;
    const usage = await sims.addUsage(ctx, s1, { periodStart: '2026-10-01', periodEnd: '2026-10-31', dataMb: 512, costPaise: 2500, note: 'Oct bill' });
    expect(usage[0]).toMatchObject({ periodStart: '2026-10-01', dataMb: 512, costPaise: 2500 });
    await expect(sims.addUsage(ctx, s1, { periodStart: '2026-10-31', periodEnd: '2026-10-01' })).rejects.toThrow(/ends before/);
    await expect(sims.update(ctx, s1, {})).rejects.toThrow(/Nothing to change/);
    const edited = await sims.update(ctx, s1, { imsi: '404451234567890', note: 'edited' });
    expect(edited.imsi).toBe('404451234567890');
    const editEvent = await prisma.simEvent.findFirstOrThrow({ where: { simId: s1, kind: 'EDIT' } });
    expect(editEvent.changes).toMatchObject({ imsi: { from: null, to: '404451234567890' } });

    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const s3 = (await sims.create(ctx, { iccid: iccid(3), providerId, planId, renewalDueAt: soon })).id;
    const s4 = (await sims.create(ctx, { iccid: iccid(4), providerId, renewalDueAt: '2020-01-01' })).id;
    const report = await sims.renewals({ withinDays: 30 });
    const mine = report.items.filter((i) => [s3, s4].includes(i.id));
    expect(mine.map((i) => [i.id, i.renewalState])).toEqual([
      [s4, 'OVERDUE'],
      [s3, 'DUE_SOON'],
    ]);
    await sims.assign(ctx, s3, { deviceId: dev.a });
    const recon = (await sims.list({ reconcile: 'true', q: iccid(3) })) as { items: { id: string }[] };
    expect(recon.items.map((i) => i.id)).toEqual([s3]);
    const summary = await sims.summary();
    expect(summary.renewalsOverdue).toBeGreaterThanOrEqual(1);
    expect(summary.renewalsDue).toBeGreaterThanOrEqual(1);
    expect(summary.reconcileIssues).toBeGreaterThanOrEqual(1);
    expect(summary.assigned).toBeGreaterThanOrEqual(1);
    const csv = await sims.list({ q: tag, format: 'csv' });
    expect(csv.constructor.name).toBe('StreamableFile');
    await expect(sims.remove(ctx, s1)).rejects.toThrow(/history/);
    await sims.remove(ctx, s4);
    expect(await prisma.simEvent.count({ where: { iccidRef: iccid(4), simId: null } })).toBeGreaterThan(0);
  });

  it('CSV import: dry run first, refused with errors, applied cleanly', async () => {
    const csv = ['iccid,msisdn,provider,plan,renewal_due', `${iccid(10)},${msisdn(10)},${tag} Airtel,M2M 1GB,2027-06-30`, `${iccid(11)},,,,`, `${iccid(1)},,${tag} Airtel,,`, `${iccid(12)},,Nope,,`].join('\n');
    const before = await safetySnapshot();
    const dry = await sims.importCsv(ctx, { csv, providerId });
    expect(dry).toMatchObject({ dryRun: true, applied: false, summary: { rows: 4, create: 2, errors: 2 } });
    expect(dry.rows[2].errors).toContain('ICCID already registered');
    expect(dry.rows[3].errors).toContain('Unknown provider "Nope"');
    expect(await sims.importCsv(ctx, { csv, providerId, dryRun: false })).toMatchObject({ applied: false });
    const ok = await sims.importCsv(ctx, { csv: csv.split('\n').slice(0, 3).join('\n'), providerId, locationId: loc, dryRun: false });
    expect(ok).toMatchObject({ applied: true, summary: { create: 2 } });
    const imported = await prisma.simCard.findUniqueOrThrow({ where: { iccid: iccid(10) }, include: { events: true } });
    expect(imported).toMatchObject({ planId, locationId: loc, status: 'AVAILABLE' });
    expect(imported.events.map((e) => e.note)).toEqual(['CSV import']);
    expect(await safetySnapshot()).toEqual(before);
  });

  it('tenant asset view is scoped to the own company and hides SIM data unless enabled (QI-21)', async () => {
    const s3 = (await prisma.simCard.findUniqueOrThrow({ where: { iccid: iccid(3) } })).id;
    const a = tenantCtx(companyA);
    const own = await links.forObject(a, objectA);
    expect(own).toMatchObject({ objectId: objectA, simVisible: false });
    expect(own.devices.map((d) => [d.deviceId, d.licence.status, d.sim])).toEqual([[dev.a, 'ACTIVE', null]]);

    // Cross-tenant: company A cannot read company B's vehicle or device (404, not 403: no existence leak).
    await expect(links.forObject(a, objectB)).rejects.toThrow(/Object not found/);
    await expect(links.forDevice(a, dev.b)).rejects.toThrow(/Device not found/);
    await expect(links.forDevice(tenantCtx(companyB), dev.a)).rejects.toThrow(/Device not found/);
    // Platform stock devices are nobody's.
    await expect(links.forDevice(a, dev.stock)).rejects.toThrow(/Device not found/);
    // ASSIGNED scope without the object: hidden.
    await expect(links.forObject(tenantCtx(companyA, { dataScope: 'ASSIGNED', branchIds: [], objectIds: [] }), objectA)).rejects.toThrow(/Object not found/);
    expect((await links.forObject(tenantCtx(companyA, { dataScope: 'ASSIGNED', objectIds: [objectA] }), objectA)).devices).toHaveLength(1);

    process.env.INVENTORY_TENANT_SIM_VIEW = 'true';
    try {
      const shown = await links.forDevice(a, dev.a);
      expect(shown.sim).toEqual({ msisdn: null, status: 'AVAILABLE', renewalDueAt: expect.any(String) });
      expect(Object.keys(shown.sim!)).toEqual(['msisdn', 'status', 'renewalDueAt']);
      expect(JSON.stringify(shown)).not.toMatch(/cost|price|iccid|provider|plan/i);
    } finally {
      delete process.env.INVENTORY_TENANT_SIM_VIEW;
    }
    expect(s3).toBeTruthy();
  });
});
