/**
 * Doc 19 customer pricing & billing on a real, freshly migrated PostgreSQL (synthetic data only, tag prc-…). Covers the
 * DB-level acceptance scenarios: migrations apply (constraints, triggers), tenant + branch isolation and unauthorised
 * access to financial data (route discovery: every /api/pricing route is behind a pricing_* menu, so 404 with the add-on
 * off, 403 without the grant; service-level 404 for other tenants / branches; cost hidden), duplicate billing-run
 * prevention (two concurrent generates, replay, unique source key), issued-invoice immutability + credit note audit,
 * historical trip price preserved after a rate change, maker-checker (contract versions, adjustments), vehicle-rate
 * override permission (scenario 8) and trip override permission + reason (scenario 9).
 * Not part of the normal run (testRegex is *.spec.ts):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_pricing_test DATABASE_URL=… npx jest --testRegex 'pricing\.db-test\.ts$' --runInBand
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { ForbiddenException, HttpException, NotFoundException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { MENUS, PRICING_ROLE_TEMPLATES, type PermissionMap } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import type { AuthContext } from '../access/auth-context';
import { REQUIRED_PERMISSIONS, type Grant } from '../access/decorators';
import { PermissionGuard } from '../access/permission.guard';
import { AuditService } from '../audit/audit.service';
import { FINANCIAL_TABLES } from '../purge/financial-guard';
import { dbDescribe } from '../test/scratch-db';
import { BillingAdjustmentsService } from './adjustments.service';
import { AvailabilityService } from './availability.service';
import { BillingRunsService } from './billing-runs.service';
import { PricingContractsService } from './contracts.service';
import { CustomerInvoicesService } from './invoices.service';
import { PRICING_CONTROLLERS } from './pricing.controller';
import { PricingModule } from './pricing.module';
import { PricingReportsService } from './reports.service';
import { PricingSettingsService } from './settings.service';
import { TripPricingService } from './trip-pricing.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `prc-${Date.now().toString(36)}`;

const errOf = (p: Promise<unknown> | (() => unknown)) =>
  Promise.resolve()
    .then(() => (typeof p === 'function' ? p() : p))
    .then(
      () => ({ status: 200, code: 'OK' }),
      (e: unknown) => {
        if (!(e instanceof HttpException)) return { status: 0, code: `unexpected: ${String(e)}` };
        const r = e.getResponse() as { code?: string };
        return { status: e.getStatus(), code: r.code ?? `HTTP_${e.getStatus()}` };
      },
    );
/** A raw statement must be refused by the database (trigger / constraint); returns the error message. */
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'ACCEPTED';
};

const ALL_PRICING: PermissionMap = Object.fromEntries(MENUS.filter((m) => m.requires?.companyFeature === 'pricing').map((m) => [m.key, [...m.actions]]));
const CLERK = PRICING_ROLE_TEMPLATES.find((t) => t.name === 'Billing clerk')!.permissions;

d(`doc 19 pricing & billing on ${dbName}`, () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const db = prisma as never;
  const audit = new AuditService(db);
  const settings = new PricingSettingsService(db, audit);
  const contracts = new PricingContractsService(db, audit, settings);
  const trips = new TripPricingService(db, audit, contracts, settings);
  const runs = new BillingRunsService(db);
  const availability = new AvailabilityService(db, audit, contracts, settings, runs);
  const invoices = new CustomerInvoicesService(db, audit, settings, runs);
  const adjustments = new BillingAdjustmentsService(db, audit, trips, invoices);
  const reports = new PricingReportsService(db, audit);

  const id = () => randomUUID();
  const w = { partner: id(), a: id(), b: id(), b1: id(), b2: id(), bB: id(), veh: id(), adminA: id(), approverA: id(), clerkB1: id(), clerkB2: id(), adminB: id(), approver2: id(), pt1: id(), t1: id(), pt2: id(), t2: id(), pt3: id(), t3: id(), pt4: id(), t4: id() };
  const ctx = (userId: string, companyId: string, permissions: PermissionMap, extra: Partial<AuthContext> = {}): AuthContext => ({ userId, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null, features: ['pricing'], ...extra });
  const adminA = ctx(w.adminA, w.a, ALL_PRICING);
  const approverA = ctx(w.approverA, w.a, ALL_PRICING);
  const clerkB1 = ctx(w.clerkB1, w.a, CLERK, { dataScope: 'ASSIGNED', branchIds: [w.b1] });
  const clerkB2 = ctx(w.clerkB2, w.a, CLERK, { dataScope: 'ASSIGNED', branchIds: [w.b2] });
  const adminB = ctx(w.adminB, w.b, ALL_PRICING);
  const approver2 = ctx(w.approver2, w.a, ALL_PRICING);
  /** Today in the company's time zone (Asia/Kolkata default) and its neighbours. */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const shift = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  let contractId = '';
  let v1Id = '';
  let invoiceId = '';

  const trip = async (pt: string, t: string, day: string, km: number) => {
    await sql(`INSERT INTO "PlannedTrip" (id, "companyId", "branchId", origin, "objectId", "routeName", "corridorM", "plannedStart", "plannedEnd", status, "actualStart", "actualEnd", "distanceKm", "updatedAt") VALUES ('${pt}', '${w.a}', '${w.b1}', 'ETMS', '${w.veh}', '${TAG} route', 100, '${day}T03:00:00Z', '${day}T04:00:00Z', 'COMPLETED', '${day}T03:00:00Z', '${day}T04:00:00Z', ${km}, now())`);
    await sql(`INSERT INTO "TransportTrip" (id, "plannedTripId", "providerCompanyId", "customerCompanyId", "serviceDate", direction, "seatCapacity", "updatedAt") VALUES ('${t}', '${pt}', '${w.a}', '${w.a}', '${day}', 'IN', 4, now())`);
  };

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${w.a}', '${w.partner}', '${TAG} cabs A', '{"features":["etms","pricing"]}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${w.b}', '${w.partner}', '${TAG} cabs B', '{"features":["etms","pricing"]}', now())`);
    for (const [b, c, n] of [[w.b1, w.a, 'North'], [w.b2, w.a, 'South'], [w.bB, w.b, 'Main']]) await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${b}', '${c}', '${TAG} ${n}', now())`);
    for (const [u, c, n] of [[w.adminA, w.a, 'Admin A'], [w.approverA, w.a, 'Approver A'], [w.clerkB1, w.a, 'Clerk North'], [w.clerkB2, w.a, 'Clerk South'], [w.adminB, w.b, 'Admin B'], [w.approver2, w.a, 'Approver Two']]) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${c}', '${n}', now())`);
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "updatedAt") VALUES ('${w.veh}', '${w.a}', '${w.b1}', '${TAG} cab 1', now())`);
    await trip(w.pt1, w.t1, '2026-10-10', 25);
    await trip(w.pt2, w.t2, '2026-11-05', 25);
    await trip(w.pt4, w.t4, '2026-11-10', 10);
  });
  afterAll(() => prisma.$disconnect());

  it('the migration applied: tables, exclusion constraints, partial unique indexes and immutability triggers exist', async () => {
    const [m] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261128090000_etms_pricing_core' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(Number(m.n)).toBe(1);
    const excl = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE contype = 'x' AND conname IN ('PricingContractVersion_no_overlap_excl', 'PricingVehicleRate_no_overlap_excl')`;
    expect(excl.map((r) => r.conname).sort()).toEqual(['PricingContractVersion_no_overlap_excl', 'PricingVehicleRate_no_overlap_excl']);
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname IN ('TripPriceSnapshot_current_key', 'CustomerInvoiceLine_source_key', 'BillingRun_companyId_contractId_kind_periodStart_key', 'PricingContract_one_default_key')`;
    expect(idx).toHaveLength(4);
    const trg = await prisma.$queryRaw<{ tgname: string }[]>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%_immutable'`;
    expect(trg.map((t) => t.tgname)).toEqual(expect.arrayContaining(['PricingContractVersion_immutable', 'PricingComponent_immutable', 'TripPriceSnapshot_immutable', 'AvailabilityBillingPeriod_immutable', 'CustomerInvoice_immutable', 'CustomerInvoiceLine_immutable', 'CustomerCreditNote_immutable', 'BillingPayment_immutable']));
    const cols = await prisma.$queryRaw<{ data_type: string }[]>`SELECT data_type FROM information_schema.columns WHERE table_name = 'CustomerInvoice' AND column_name = 'totalMinor'`;
    expect(cols[0].data_type).toBe('bigint');
    // Purge guard: every pricing table is a financial table.
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE 'Pricing%' OR table_name LIKE 'Billing%' OR table_name LIKE 'Customer%' OR table_name IN ('TripPriceSnapshot', 'AvailabilityBillingPeriod', 'OperatingCostRecord')) AND table_name <> 'BillingProfile'`;
    for (const t of tables) expect(FINANCIAL_TABLES as readonly string[]).toContain(t.table_name);
  });

  it('every /api/pricing route is behind a pricing_* menu: 404 with the add-on off, 403 without the grant, allowed with it', () => {
    const guard = new PermissionGuard(new Reflector());
    const roots = (Reflect.getMetadata('controllers', PricingModule) ?? []) as object[];
    expect(new Set(roots)).toEqual(new Set(PRICING_CONTROLLERS));
    let routes = 0;
    for (const ctrl of PRICING_CONTROLLERS) {
      const base = Reflect.getMetadata(PATH_METADATA, ctrl) as string;
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = (ctrl.prototype as unknown as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
        routes++;
        const key = `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number]} ${base}/${Reflect.getMetadata(PATH_METADATA, fn) as string}`;
        const grants = Reflect.getMetadata(REQUIRED_PERMISSIONS, fn) as Grant[] | undefined;
        expect({ key, declared: !!grants?.length }).toEqual({ key, declared: true });
        for (const [menu] of grants!) expect({ key, menu, feature: MENUS.find((m) => m.key === menu)?.requires?.companyFeature }).toEqual({ key, menu, feature: 'pricing' });
        const run = (auth: AuthContext) => {
          const req = { auth, method: 'POST', query: {}, url: key, originalUrl: key };
          const ec = { getType: () => 'http', getHandler: () => fn, getClass: () => ctrl, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
          try {
            return guard.canActivate(ec) ? 200 : 0;
          } catch (e) {
            return e instanceof NotFoundException ? 404 : e instanceof ForbiddenException ? 403 : -1;
          }
        };
        const holder = ctx(w.adminA, w.a, Object.fromEntries(grants!.map(([m, a]) => [m, [a]])));
        expect({ key, off: run({ ...holder, features: [] }) }).toEqual({ key, off: 404 }); // add-on off: route cannot be detected
        expect({ key, fleet: run(ctx(w.adminA, w.a, { objects: ['view', 'edit'], reports: ['view'] })) }).toEqual({ key, fleet: 403 }); // no pricing grant
        expect({ key, granted: run(holder) }).toEqual({ key, granted: 200 });
      }
    }
    expect(routes).toBeGreaterThanOrEqual(45);
    // Cost / margin is its own menu: ordinary pricing roles (the clerk template) never hold it.
    expect(CLERK.pricing_costs).toBeUndefined();
  });

  it('settings + contract with maker-checker: the submitter cannot approve, a second approver can', async () => {
    const tp = await settings.createTaxProfile(adminA, { name: `${TAG} GST`, regime: 'IN_GST', defaultTaxCode: 'GST_18', rates: [{ taxCode: 'GST_18', label: 'GST 18%', ratePercent: '18', validFrom: '2026-04-01' }] });
    await settings.putSupplier(adminA, { legalName: `${TAG} Cabs A Pvt Ltd`, address: '1 Road', city: 'Chennai', stateCode: '33', taxRegime: 'IN_GST', taxRegistration: '33ABCDE1234F1Z5', invoicePrefix: 'CABA' });
    const c = await contracts.create(adminA, {
      name: `${TAG} internal`,
      customerName: 'Head office charge-back',
      currency: 'INR',
      billingFrequency: 'MONTHLY',
      taxProfileId: tp.id,
      validFrom: '2026-10-01',
      components: [
        { kind: 'BASE_FARE', params: { amount: '50' } },
        { kind: 'PER_KM', params: { rate: '10' } },
      ],
    });
    contractId = c.id;
    v1Id = c.versions[0].id;
    // Vehicle rates are refused while the contract does not permit overrides (scenario 8).
    expect(await errOf(contracts.createVehicleRate(adminA, contractId, { objectId: w.veh, validFrom: '2026-10-01', componentOverrides: [{ kind: 'PER_KM', params: { rate: '8' } }] }))).toEqual({ status: 409, code: 'VEHICLE_OVERRIDE_NOT_PERMITTED' });
    await contracts.submit(adminA, contractId, v1Id);
    expect(await errOf(contracts.approve(adminA, contractId, v1Id))).toEqual({ status: 403, code: 'MAKER_CHECKER_SAME_USER' });
    const approved = await contracts.approve(approverA, contractId, v1Id, 'ok');
    expect(approved.status).toBe('ACTIVE');
    expect(approved.versions[0]).toMatchObject({ status: 'ACTIVE', submittedById: w.adminA, approvedById: w.approverA });
    // An approved version is frozen in the database too.
    expect(await refused(sql(`UPDATE "PricingContractVersion" SET policies = '{"alsoChargeTrips":true}' WHERE id = '${v1Id}'`))).toMatch(/CONTRACT_VERSION_IMMUTABLE/);
    expect(await refused(sql(`UPDATE "PricingComponent" SET params = '{"rate":"1"}' WHERE "versionId" = '${v1Id}'`))).toMatch(/CONTRACT_VERSION_IMMUTABLE/);
    // Non-overlap: a second ACTIVE version over the same dates is rejected by the exclusion constraint.
    expect(await refused(sql(`INSERT INTO "PricingContractVersion" (id, "companyId", "contractId", "versionNo", "validFrom", status, "updatedAt") VALUES (gen_random_uuid(), '${w.a}', '${contractId}', 99, '2026-10-15', 'ACTIVE', now())`))).toMatch(/no_overlap_excl|exclusion/);
    const hist = await prisma.auditLog.findMany({ where: { entity: 'pricing_contract_version', entityId: v1Id } });
    expect(hist.map((h) => (h.changes as { event?: string } | null)?.event)).toEqual(expect.arrayContaining(['SUBMITTED', 'APPROVED']));
  });

  it('historical trip price is preserved after a rate change (scenario 10); snapshots are append-only', async () => {
    const s1 = await trips.recalculate(adminA, w.t1);
    expect(s1).toMatchObject({ status: 'PRICED', subtotalMinor: '30000', taxMinor: '5400', totalMinor: '35400', currency: 'INR', distanceSource: 'GPS', gpsQuality: 'OK' });
    expect(s1.taxLines[0]).toMatchObject({ cgstMinor: '2700', sgstMinor: '2700' });
    // Re-price: v2 from 1 Nov doubles the per-km rate.
    const withV2 = await contracts.createVersion(adminA, contractId, { validFrom: '2026-11-01', components: [{ kind: 'BASE_FARE', params: { amount: '50' } }, { kind: 'PER_KM', params: { rate: '20' } }] });
    const v2 = withV2.versions.find((v) => v.versionNo === 2)!;
    await contracts.submit(adminA, contractId, v2.id);
    const after = await contracts.approve(approverA, contractId, v2.id);
    expect(after.versions.find((v) => v.id === v1Id)).toMatchObject({ status: 'SUPERSEDED', validTo: '2026-11-01' });
    const kept = await prisma.tripPriceSnapshot.findUniqueOrThrow({ where: { id: s1.id } });
    expect(kept.totalMinor).toBe(35400n);
    expect(kept.contractVersionId).toBe(v1Id);
    // Re-pricing the October trip still uses the version valid on its service date; November uses v2.
    expect((await trips.recalculate(adminA, w.t1, 'check')).totalMinor).toBe('35400');
    const s2 = await trips.recalculate(adminA, w.t2);
    expect(s2).toMatchObject({ subtotalMinor: '55000', totalMinor: '64900', contractVersionId: v2.id });
    expect(await refused(sql(`UPDATE "TripPriceSnapshot" SET "totalMinor" = 1, "subtotalMinor" = 1, "taxMinor" = 0 WHERE id = '${s1.id}'`))).toMatch(/TRIP_PRICE_IMMUTABLE/);
    expect(await refused(sql(`DELETE FROM "TripPriceSnapshot" WHERE id = '${s1.id}'`))).toMatch(/TRIP_PRICE_IMMUTABLE/);
    const detail = await trips.detail(adminA, w.t1);
    expect(detail.history.length).toBeGreaterThanOrEqual(1);
    expect(detail.audit.length).toBeGreaterThanOrEqual(2);
  });

  it('trip override needs the contract permission and a reason, and is audited (scenario 9)', async () => {
    expect(await errOf(trips.override(adminA, w.t2, '400', 'negotiated'))).toEqual({ status: 409, code: 'TRIP_OVERRIDE_NOT_PERMITTED' });
    // QA 10: a manual distance always wins the resolution, so it is refused like an override on a contract without them.
    expect(await errOf(trips.setBillableDistance(adminA, w.t2, '5', 'driver says shorter'))).toEqual({ status: 409, code: 'TRIP_OVERRIDE_NOT_PERMITTED' });
    const c = await contracts.get(adminA, contractId);
    await prisma.pricingContract.update({ where: { id: contractId }, data: { allowTripOverrides: true, version: c.version + 1 } });
    expect(await errOf(trips.override(adminA, w.t2, '400', ''))).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    const r = await trips.override(adminA, w.t2, '400', 'negotiated with customer');
    expect(r.snapshot).toMatchObject({ subtotalMinor: '40000', taxMinor: '7200', totalMinor: '47200', override: { byId: w.adminA, reason: 'negotiated with customer' } });
    const rows = await prisma.auditLog.findMany({ where: { entity: 'trip_price_snapshot', entityId: w.t2, userId: w.adminA } });
    expect(rows.some((x) => (x.changes as { override?: { reason?: string } }).override?.reason === 'negotiated with customer')).toBe(true);
  });

  it('duplicate billing runs never charge twice: concurrent generates, replay, unique source key', async () => {
    const body = { contractId, periodStart: '2026-10-01', periodEnd: '2026-10-31', branchId: null };
    const results = await Promise.allSettled([invoices.generate(adminA, body, `${TAG}-gen-1`), invoices.generate(adminA, body, `${TAG}-gen-2`)]);
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof invoices.generate>>>[];
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect([409]).toContain((bad[0].reason as HttpException).getStatus());
    expect(['BILLING_RUN_IN_PROGRESS', 'BILLING_RUN_DONE']).toContain(((bad[0].reason as HttpException).getResponse() as { code: string }).code);
    invoiceId = ok[0].value.invoice.id;
    expect(ok[0].value.invoice).toMatchObject({ status: 'DRAFT', totalMinor: '35400', currency: 'INR' });
    const winnerKey = ok[0].value.invoice.id && (await prisma.customerInvoice.findUniqueOrThrow({ where: { id: invoiceId } })).idempotencyKey!;
    const replay = await invoices.generate(adminA, body, winnerKey);
    expect(replay).toMatchObject({ replayed: true, invoice: { id: invoiceId } });
    expect(await errOf(invoices.generate(adminA, { ...body, periodEnd: '2026-10-30' }, winnerKey))).toEqual({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await prisma.customerInvoice.count({ where: { contractId } })).toBe(1);
    // The last guard: the same trip can never be on a second invoice line.
    const line = await prisma.customerInvoiceLine.findFirstOrThrow({ where: { invoiceId } });
    const other = await prisma.customerInvoice.create({ data: { companyId: w.a, contractId, periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), currency: 'INR' } });
    expect(await refused(prisma.customerInvoiceLine.create({ data: { companyId: w.a, invoiceId: other.id, sourceType: 'TRIP_SNAPSHOT', sourceKey: line.sourceKey, description: 'dup', quantity: 1, unit: 'trip', amountMinor: 1n, totalMinor: 1n } }))).toMatch(/Unique|unique|CustomerInvoiceLine_source_key/);
    await prisma.customerInvoice.delete({ where: { id: other.id } });
    // An invoiced trip is frozen.
    expect(await errOf(trips.recalculate(adminA, w.t1))).toEqual({ status: 409, code: 'ALREADY_INVOICED' });
  });

  it('issued invoices are immutable; credit notes and payments are audited and append-only', async () => {
    expect(await errOf(invoices.issue(adminA, invoiceId, shift(today, 1)))).toEqual({ status: 409, code: 'INVOICE_DATE_INVALID' });
    expect(await errOf(invoices.issue(adminA, invoiceId, shift(today, -400)))).toEqual({ status: 409, code: 'INVOICE_DATE_INVALID' });
    const issued = await invoices.issue(adminA, invoiceId);
    expect(issued).toMatchObject({ status: 'ISSUED', number: 'CABA/2026-27/0001', fy: '2026-27', invoiceDate: today, dueDate: shift(today, 30), paymentStatus: 'UNPAID', balanceMinor: '35400' });
    expect(issued.supplier).toMatchObject({ taxRegistration: '33ABCDE1234F1Z5' });
    expect(await refused(sql(`UPDATE "CustomerInvoice" SET "totalMinor" = 1, "subtotalMinor" = 1, "taxMinor" = 0 WHERE id = '${invoiceId}'`))).toMatch(/INVOICE_ISSUED_IMMUTABLE/);
    expect(await refused(sql(`DELETE FROM "CustomerInvoice" WHERE id = '${invoiceId}'`))).toMatch(/INVOICE_ISSUED_IMMUTABLE/);
    expect(await refused(sql(`UPDATE "CustomerInvoiceLine" SET description = 'x' WHERE "invoiceId" = '${invoiceId}'`))).toMatch(/INVOICE_ISSUED_IMMUTABLE/);
    expect(await refused(sql(`UPDATE "CustomerInvoice" SET "pdfFile" = 'x.pdf' WHERE id = '${invoiceId}'`))).toBe('ACCEPTED');
    expect(await errOf(invoices.remove(adminA, invoiceId))).toEqual({ status: 409, code: 'INVOICE_ISSUED_IMMUTABLE' });
    expect(await errOf(invoices.issue(adminA, invoiceId))).toEqual({ status: 409, code: 'INVOICE_NOT_DRAFT' });
    // QA 10: credit notes need two users: a request, then a different approver issues it.
    const req = await invoices.requestCreditNote(approverA, invoiceId, { reason: 'Late pickup goodwill', amount: '118' });
    expect(req).toMatchObject({ kind: 'CREDIT', status: 'PENDING_APPROVAL', invoiceId, amountMinor: '-11800' });
    expect(await errOf(adjustments.decide(approverA, req.id, true))).toEqual({ status: 403, code: 'MAKER_CHECKER_SAME_USER' });
    const decided = await adjustments.decide(adminA, req.id, true, 'ok');
    expect(decided).toMatchObject({ status: 'APPLIED', decidedById: w.adminA });
    const cn = (await invoices.get(adminA, invoiceId)).creditNotes[0];
    expect(cn).toMatchObject({ number: 'CN/2026-27/0001', totalMinor: '11800', taxMinor: '1800', subtotalMinor: '10000', issuedById: w.adminA });
    expect(cn.taxLines[0]).toMatchObject({ cgstMinor: '900', sgstMinor: '900' });
    expect(await errOf(invoices.requestCreditNote(approverA, invoiceId, { reason: 'too much', amount: '300' }))).toEqual({ status: 409, code: 'CREDIT_EXCEEDS_INVOICE' });
    const cnAudit = await prisma.auditLog.findMany({ where: { companyId: w.a, entity: 'customer_credit_note', entityId: cn.id, userId: w.adminA } });
    expect(cnAudit).toHaveLength(1);
    expect(await refused(sql(`UPDATE "CustomerCreditNote" SET reason = 'x' WHERE id = '${cn.id}'`))).toMatch(/CREDIT_NOTE_IMMUTABLE/);
    const pay = await invoices.recordPayment(adminA, invoiceId, { amount: '100', receivedAt: '2026-11-16T10:00:00Z', method: 'UPI', reference: 'UTR1' });
    expect(await refused(sql(`UPDATE "BillingPayment" SET "amountMinor" = 1 WHERE id = '${pay.id}'`))).toMatch(/PAYMENT_LEDGER_IMMUTABLE/);
    await invoices.reversePayment(adminA, pay.id, 'bounced');
    expect(await errOf(invoices.reversePayment(adminA, pay.id, 'again'))).toEqual({ status: 409, code: 'VALIDATION_FAILED' });
    const now = await invoices.get(adminA, invoiceId);
    expect(now).toMatchObject({ creditedMinor: '11800', paidMinor: '0', balanceMinor: '23600', paymentStatus: 'UNPAID' });
    // The PDF renders from the frozen snapshot.
    const file = await invoices.pdf(adminA, invoiceId);
    expect(file).toBeDefined();
  });

  it('tenant + branch isolation of financial data; cost and margin hidden from ordinary pricing roles', async () => {
    // Another tenant: every id of company A is a 404, lists never contain A's rows.
    expect(await errOf(contracts.get(adminB, contractId))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await errOf(invoices.get(adminB, invoiceId))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await errOf(trips.detail(adminB, w.t1))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await errOf(trips.recalculate(adminB, w.t2))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await errOf(invoices.requestCreditNote(adminB, invoiceId, { reason: 'steal' }))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await errOf(contracts.preview(adminB, contractId, { kind: 'TRIP', trip: { serviceDate: '2026-10-10', billableDistanceM: 1000 } }))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect((await contracts.list(adminB, {})).items.map((c) => c.id)).not.toContain(contractId);
    expect((await invoices.list(adminB, {})).items).toHaveLength(0);
    expect(((await trips.list(adminB, {})) as { items: unknown[] }).items).toHaveLength(0);
    expect(await errOf(adjustments.create(adminB, { contractId, kind: 'CREDIT', amount: '1', reason: 'cross tenant' }))).toEqual({ status: 404, code: 'NOT_FOUND' });
    // Branch scope: the North clerk sees the North trips, the South clerk does not; consolidated invoices need COMPANY scope.
    expect(((await trips.list(clerkB1, {})) as { items: { transportTripId: string }[] }).items.map((i) => i.transportTripId)).toEqual(expect.arrayContaining([w.t1, w.t2]));
    expect(((await trips.list(clerkB2, {})) as { items: unknown[] }).items).toHaveLength(0);
    expect(await errOf(trips.detail(clerkB2, w.t1))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await errOf(invoices.get(clerkB1, invoiceId))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect((await invoices.list(clerkB1, {})).items).toHaveLength(0);
    expect(await errOf(invoices.generate(clerkB1, { contractId, periodStart: '2026-11-01', periodEnd: '2026-11-30' }, `${TAG}-clerk`))).toEqual({ status: 403, code: 'CONSOLIDATED_NEEDS_COMPANY_SCOPE' });
    expect(await errOf(invoices.generate(clerkB2, { contractId, periodStart: '2026-11-01', periodEnd: '2026-11-30', branchId: w.b1 }, `${TAG}-clerk2`))).toEqual({ status: 403, code: 'BRANCH_SCOPE' });
    expect(await errOf(contracts.update(clerkB1, contractId, { expectedVersion: 1, name: 'x' }))).toEqual({ status: 403, code: 'BRANCH_SCOPE' });
    // Cost / margin: projected out for the clerk, refused as a report; visible to the billing admin.
    await reports.createCost(adminA, { date: '2026-11-05', category: 'FUEL', amount: '120', currency: 'INR', objectId: w.veh, branchId: w.b1 });
    const clerkRev = (await reports.report(clerkB1, 'revenue', { from: '2026-11-01', to: '2026-11-30', groupBy: 'vehicle' })) as { costVisible: boolean; columns: { key: string }[]; rows: Record<string, unknown>[] };
    expect(clerkRev.costVisible).toBe(false);
    expect(clerkRev.columns.map((c) => c.key)).not.toContain('costMinor');
    expect(clerkRev.rows.every((r) => !('costMinor' in r) && !('marginMinor' in r))).toBe(true);
    expect(await errOf(reports.report(clerkB1, 'margin', { from: '2026-11-01', to: '2026-11-30', groupBy: 'vehicle' }))).toEqual({ status: 403, code: 'COST_HIDDEN' });
    expect((await reports.dashboard(clerkB1)).margin).toBeNull();
    const adminMargin = (await reports.report(adminA, 'margin', { from: '2026-11-01', to: '2026-11-30', groupBy: 'vehicle' })) as { rows: Record<string, unknown>[] };
    expect(adminMargin.rows.find((r) => r.key === w.veh)).toMatchObject({ revenueMinor: '40000', costMinor: '12000', marginMinor: '28000' });
  });

  it('maker-checker on adjustments: the requester cannot decide; a second approver applies it to the next invoice', async () => {
    const adj = await adjustments.create(adminA, { contractId, kind: 'CREDIT', amount: '50', reason: 'Service credit for November' });
    expect(adj).toMatchObject({ status: 'PENDING_APPROVAL', amountMinor: '-5000' });
    expect(await errOf(adjustments.decide(adminA, adj.id, true))).toEqual({ status: 403, code: 'MAKER_CHECKER_SAME_USER' });
    expect(await refused(sql(`UPDATE "BillingAdjustment" SET "decidedById" = "requestedById", status = 'APPROVED' WHERE id = '${adj.id}'`))).toMatch(/maker_checker/);
    const ok = await adjustments.decide(approverA, adj.id, true, 'agreed');
    expect(ok).toMatchObject({ status: 'APPROVED', decidedById: w.approverA });
    const nov = await invoices.generate(adminA, { contractId, periodStart: '2026-11-01', periodEnd: '2026-11-30' }, `${TAG}-nov`);
    expect(nov.invoice.lines.map((l) => l.sourceType).sort()).toEqual(['ADJUSTMENT', 'TRIP_SNAPSHOT']);
    // 400.00 override − 50.00 credit = 350.00 + 18 % GST.
    expect(nov.invoice).toMatchObject({ subtotalMinor: '35000', taxMinor: '6300', totalMinor: '41300' });
  });

  it('QA 10: the author or last editor of a version cannot approve it (only a third user)', async () => {
    const tp = (await settings.listTaxProfiles(adminA))[0].id;
    const c = await contracts.create(adminA, { name: `${TAG} for B`, customerCompanyId: w.b, currency: 'INR', billingFrequency: 'MONTHLY', taxProfileId: tp, validFrom: '2026-10-01', components: [{ kind: 'PER_KM', params: { rate: '9' } }] });
    const v = c.versions[0].id;
    await contracts.replaceComponents(approverA, c.id, v, { components: [{ kind: 'PER_KM', params: { rate: '7' } }] });
    await contracts.submit(adminA, c.id, v);
    expect(await errOf(contracts.approve(approverA, c.id, v))).toEqual({ status: 403, code: 'MAKER_CHECKER_SAME_USER' }); // last editor
    expect(await errOf(contracts.approve(adminA, c.id, v))).toEqual({ status: 403, code: 'MAKER_CHECKER_SAME_USER' }); // author + submitter
    expect((await contracts.approve(approver2, c.id, v)).status).toBe('ACTIVE');
  });

  it('QA 4: a suspended customer contract is never replaced by the company default', async () => {
    const tp = (await settings.listTaxProfiles(adminA))[0].id;
    const def = await contracts.create(adminA, { name: `${TAG} default`, customerName: 'Default', isDefault: true, defaultCovers: ['INTERNAL'], currency: 'INR', billingFrequency: 'MONTHLY', taxProfileId: tp, validFrom: '2026-01-01', components: [{ kind: 'PER_KM', params: { rate: '99' } }] });
    await contracts.submit(adminA, def.id, def.versions[0].id);
    await contracts.approve(approverA, def.id, def.versions[0].id);
    const own = await contracts.get(adminA, contractId);
    await contracts.lifecycle(approverA, contractId, 'suspend', { reason: 'customer dispute', expectedVersion: own.version });
    const s = await trips.recalculate(adminA, w.t4);
    expect(s).toMatchObject({ status: 'NO_APPLICABLE_PRICING', contractId: null });
    expect(s.issues[0].message).toMatch(/suspended/);
    const susp = await contracts.get(adminA, contractId);
    await contracts.lifecycle(approverA, contractId, 'resume', { reason: 'resolved', expectedVersion: susp.version });
    expect(await trips.recalculate(adminA, w.t4)).toMatchObject({ status: 'PRICED', contractId, subtotalMinor: '25000' }); // 50 + 10 km × 20
  });

  it('QA 6 + 12: a draft holding a superseded snapshot cannot be issued; no back-dated issue', async () => {
    const gen = await invoices.generate(adminA, { contractId, periodStart: '2026-11-10', periodEnd: '2026-11-10' }, `${TAG}-t4`);
    const snapId = gen.invoice.lines[0].sourceId!;
    expect(await errOf(trips.recalculate(adminA, w.t4))).toEqual({ status: 409, code: 'ALREADY_INVOICED' });
    // Simulate a re-price that slipped past the guards: the draft's snapshot is no longer current.
    await sql(`UPDATE "TripPriceSnapshot" SET "isCurrent" = false WHERE id = '${snapId}'`);
    await sql(`INSERT INTO "TripPriceSnapshot" (id, "companyId", "transportTripId", "contractId", "serviceDate", currency, status, "isCurrent", "engineVersion", "supersedesId") SELECT gen_random_uuid(), "companyId", "transportTripId", "contractId", "serviceDate", currency, 'NEEDS_REVIEW', true, "engineVersion", id FROM "TripPriceSnapshot" WHERE id = '${snapId}'`);
    expect(await errOf(invoices.issue(adminA, gen.invoice.id))).toEqual({ status: 409, code: 'SNAPSHOT_SUPERSEDED' });
    await invoices.remove(adminA, gen.invoice.id);
    // The November draft cannot be dated before the latest issued invoice (issued today).
    const nov = (await invoices.list(adminA, { status: 'DRAFT', contractId })).items[0];
    expect(await errOf(invoices.issue(adminA, nov.id, shift(today, -1)))).toEqual({ status: 409, code: 'INVOICE_DATE_INVALID' });
    expect((await invoices.issue(adminA, nov.id)).number).toBe('CABA/2026-27/0002');
  });

  it('QA 11: the cancellation time comes from the cancellation event; unknown → review', async () => {
    await trip(w.pt3, w.t3, '2026-10-20', 0);
    await sql(`UPDATE "PlannedTrip" SET status = 'CANCELLED', "actualStart" = NULL, "actualEnd" = NULL, "distanceKm" = NULL WHERE id = '${w.pt3}'`);
    const unknown = await trips.recalculate(adminA, w.t3);
    expect(unknown.status).toBe('NEEDS_REVIEW');
    expect(unknown.issues.map((i) => i.code)).toContain('MISSING_FACT');
    await sql(`UPDATE "TransportTrip" SET "cancelledAt" = '2026-10-19T10:00:00Z' WHERE id = '${w.t3}'`);
    expect((await trips.recalculate(adminA, w.t3)).status).toBe('PRICED');
  });

  it('QA 5: fee and billing frequency must match; no close before the period ends', async () => {
    const tp = (await settings.listTaxProfiles(adminA))[0].id;
    const bad = await contracts.create(adminA, { name: `${TAG} weekly bill`, customerName: 'Mismatch', currency: 'INR', billingFrequency: 'WEEKLY', taxProfileId: tp, validFrom: '2026-09-01', components: [{ kind: 'AVAILABILITY_FEE', params: { amount: '30000', frequency: 'MONTHLY' } }] });
    expect(await errOf(contracts.submit(adminA, bad.id, bad.versions[0].id))).toEqual({ status: 400, code: 'INVALID_COMPONENTS' });
    await contracts.update(adminA, bad.id, { expectedVersion: bad.version, billingFrequency: 'MONTHLY' });
    const fixed = await contracts.submit(adminA, bad.id, bad.versions[0].id);
    await contracts.approve(approverA, bad.id, fixed.versions[0].id);
    await contracts.createAssignment(adminA, bad.id, { objectId: w.veh, validFrom: '2026-09-01' });
    expect(await errOf(availability.close(adminA, bad.id, today, `${TAG}-early`))).toEqual({ status: 409, code: 'PERIOD_NOT_ENDED' });
  });

  it('QA 3: monthly excess with GPS days missing goes to review instead of 0 km', async () => {
    const tp = (await settings.listTaxProfiles(adminA))[0].id;
    const c = await contracts.create(adminA, { name: `${TAG} excess`, customerName: 'Excess km', currency: 'INR', billingFrequency: 'MONTHLY', taxProfileId: tp, validFrom: '2026-08-01', components: [{ kind: 'AVAILABILITY_FEE', params: { amount: '60000', frequency: 'MONTHLY' }, covers: ['VEHICLE_TIME', 'KM_INCLUDED'] }, { kind: 'INCLUDED_KM', params: { km: '100' } }, { kind: 'EXCESS_KM', params: { rate: '15' } }] });
    await contracts.submit(adminA, c.id, c.versions[0].id);
    await contracts.approve(approverA, c.id, c.versions[0].id);
    await contracts.createAssignment(adminA, c.id, { objectId: w.veh, validFrom: '2026-08-01', validTo: '2026-09-01' });
    for (let d = 1; d <= 10; d++) await sql(`INSERT INTO "DailySummary" ("objectId", day, "companyId", "distanceKm", "updatedAt") VALUES ('${w.veh}', '2026-08-${String(d).padStart(2, '0')}', '${w.a}', 20, now()) ON CONFLICT DO NOTHING`);
    const [p] = await availability.compute(adminA, c.id, '2026-08-15');
    expect(p).toMatchObject({ status: 'NEEDS_REVIEW', usedDistanceM: 200_000 });
    expect(p.issues.map((i) => i.code)).toContain('GPS_DISTANCE_REVIEW');
    expect(p.issues[0].message).toMatch(/^21 /);
  });

  it('availability close is idempotent per contract + period (one BillingRun claim)', async () => {
    const fee = await contracts.create(adminA, { name: `${TAG} dedicated`, customerName: 'Plant shuttle', currency: 'INR', billingFrequency: 'MONTHLY', taxProfileId: (await settings.listTaxProfiles(adminA))[0].id, validFrom: '2026-09-01', components: [{ kind: 'AVAILABILITY_FEE', params: { amount: '30000', frequency: 'MONTHLY' }, covers: ['VEHICLE_TIME', 'TRIPS'] }] });
    await contracts.submit(adminA, fee.id, fee.versions[0].id);
    await contracts.approve(approverA, fee.id, fee.versions[0].id);
    await contracts.createAssignment(adminA, fee.id, { objectId: w.veh, validFrom: '2026-09-16' });
    const first = await availability.close(adminA, fee.id, '2026-09-20', `${TAG}-close-1`);
    // Zero trips in September: still charged, prorated 15/30 days (scenario 4 / 5 at DB level).
    expect(first.periods).toHaveLength(1);
    expect(first.periods[0]).toMatchObject({ status: 'CLOSED', attachedDays: 15, billableDays: 15, subtotalMinor: '1500000' });
    expect(await errOf(availability.close(adminA, fee.id, '2026-09-25', `${TAG}-close-2`))).toEqual({ status: 409, code: 'BILLING_RUN_DONE' });
    // QA 5: a vehicle added to an already closed period can still be closed (the run is re-claimed), the first stays as it was.
    const second = await contracts.createAssignment(adminA, fee.id, { objectId: w.veh, validFrom: '2026-09-01', validTo: '2026-09-16' });
    // QA 8: overlapping downtimes (1–12 and 7–12) count 12 days, not 18.
    await contracts.addDowntime(adminA, fee.id, second.id, { fromDate: '2026-09-01', toDate: '2026-09-12', kind: 'BREAKDOWN', reason: 'engine' });
    await contracts.addDowntime(adminA, fee.id, second.id, { fromDate: '2026-09-07', toDate: '2026-09-12', kind: 'MAINTENANCE', reason: 'service' });
    const again = await availability.close(adminA, fee.id, '2026-09-25', `${TAG}-close-3`);
    expect(again.periods).toHaveLength(2);
    expect(again.periods.find((p) => p.assignmentId === second.id)).toMatchObject({ status: 'CLOSED', attachedDays: 15, downtimeDays: 12, billableDays: 3 });
    expect(again.periods.find((p) => p.id === first.periods[0].id)).toMatchObject({ subtotalMinor: '1500000' });
    expect(await errOf(availability.close(adminA, fee.id, '2026-09-25', `${TAG}-close-4`))).toEqual({ status: 409, code: 'BILLING_RUN_DONE' });
    expect(await refused(sql(`UPDATE "AvailabilityBillingPeriod" SET "totalMinor" = 0, "subtotalMinor" = 0, "taxMinor" = 0 WHERE id = '${first.periods[0].id}'`))).toMatch(/PERIOD_CLOSED_IMMUTABLE/);
    expect(await prisma.billingRun.count({ where: { contractId: fee.id, kind: 'AVAILABILITY_CLOSE' } })).toBe(1);
  });
});
