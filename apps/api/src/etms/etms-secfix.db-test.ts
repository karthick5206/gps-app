/**
 * v1.14.0 security / QA fix round on a real, freshly migrated PostgreSQL (synthetic data only, tag sfx-…):
 *  - M1: VeeTrax support (Super Admin) is view only on incidents, needs X-Access-Reason for the detail, and the detail
 *    read lands in the incident's customer company log (like the E1b passenger reads); provider reads too.
 *  - QA B1: the customer picker (X-Transport-Customer) never narrows the SOS lane.
 * Not part of the normal run (testRegex is *.spec.ts):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_<name>_test TEST_REDIS_URL=redis://localhost:6379/14 \
 *     npx jest --testRegex 'etms-secfix\.db-test\.ts$' --runInBand
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { dbDescribe } from '../test/scratch-db';
import { IncidentsService } from './safety/incidents.service';
import { IncidentsController } from './safety/safety.controller';
import { SosService } from './safety/sos.service';
import type { AuthContext } from '../access/auth-context';
import { customerContextOf } from '../access/transport-scope';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `sfx-${Date.now().toString(36)}`;

/** Status / code of a call; a function argument catches a synchronous throw (controller guards) too. */
export const errOf = (p: Promise<unknown> | (() => unknown)) =>
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

d(`v1.14.0 security fix round on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const audit = new AuditService(prisma as never);
  const sos = new SosService(prisma as never);
  const incidents = new IncidentsService(prisma as never, audit);
  const incidentsCtl = new IncidentsController(incidents);

  const id = () => randomUUID();
  const w = {
    partner: id(),
    platform: id(),
    cust: id(),
    prov: id(),
    agreement: id(),
    support: id(),
    custDesk: id(),
    provDesk: id(),
    custRole: id(),
    provRole: id(),
    paxUser: id(),
    profile: id(),
  };
  const base = { isCompanyAdmin: false, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null };
  const ctx = (userId: string, companyId: string, perms: Record<string, string[]>, extra: Record<string, unknown> = {}) =>
    ({ ...base, userId, companyId, homeCompanyId: companyId, isSuperAdmin: false, permissions: perms, features: ['etms'], agreements: [], ...extra }) as never;
  const INC = { etms_incidents: ['view', 'edit'] };
  const custDesk = ctx(w.custDesk, w.cust, INC);
  const agreementScope = () => ({ id: w.agreement, customerCompanyId: w.cust, grants: ['MANAGE_INCIDENTS'], siteIds: [], dataProfile: 'MINIMAL', validFrom: Date.now() - 86_400_000, validTo: null });
  const provDesk = () => ctx(w.provDesk, w.prov, INC, { features: ['etms', 'etmsProvider'], agreements: [agreementScope()] });
  const support = ctx(w.support, w.platform, INC, { isSuperAdmin: true, isCompanyAdmin: true });
  const supportSwitched = ctx(w.support, w.cust, INC, { isSuperAdmin: true, isCompanyAdmin: true, homeCompanyId: w.platform });
  const pax = () => ctx(w.paxUser, w.cust, { etms_self: ['view'] });
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const REASON = 'Ticket 4521: customer asked us to check this SOS';

  /** A fresh OPEN passenger SOS of the customer, linked to the provider (as if it had a trip of the provider). */
  const providerLinkedSos = async () => {
    const r = await sos.raisePassenger(pax(), { note: 'help', fix: { lat: 13.05, lng: 80.25, at: new Date().toISOString() } }, id());
    await prisma.transportIncident.update({ where: { id: r.receipt.incidentId }, data: { providerCompanyId: w.prov } });
    return r.receipt.incidentId;
  };
  const closeOpen = () => prisma.transportIncident.updateMany({ where: { raiserUserId: w.paxUser, status: 'OPEN' }, data: { status: 'RESOLVED', acknowledgedAt: new Date(), resolvedAt: new Date(), resolution: 'TEST' } });

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "isPlatform", "updatedAt") VALUES ('${w.platform}', '${w.partner}', '${TAG} platform', '{}', true, now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${w.cust}', '${w.partner}', '${TAG} corp', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${w.prov}', '${w.partner}', '${TAG} cabs', '{"features":["etms","etmsProvider"]}', now())`);
    await sql(`INSERT INTO "TransportServiceAgreement" (id, "providerCompanyId", "customerCompanyId", status, "validFrom", grants, "approvedByCustomerAt", "approvedByProviderAt", "updatedAt") VALUES ('${w.agreement}', '${w.prov}', '${w.cust}', 'ACTIVE', now() - interval '1 day', ARRAY['MANAGE_INCIDENTS']::"TransportGrant"[], now(), now(), now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.support}', '${w.platform}', 'Support Agent', now())`);
    for (const [u, c, r, n] of [[w.custDesk, w.cust, w.custRole, 'Corp Desk'], [w.provDesk, w.prov, w.provRole, 'Cabs Desk']]) {
      await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${c}', '${n}', now())`);
      await sql(`INSERT INTO "Role" (id, "companyId", name, description, "isSystem", "dataScope", "updatedAt") VALUES ('${r}', '${c}', 'Transport dispatcher', 'synthetic', false, 'COMPANY', now())`);
      await sql(`INSERT INTO "RolePermission" ("roleId", menu, actions) VALUES ('${r}', 'etms_incidents', ARRAY['view','edit'])`);
      await sql(`INSERT INTO "UserRole" ("userId", "roleId") VALUES ('${u}', '${r}')`);
      await sql(`INSERT INTO "PushToken" (id, "userId", token, platform, "updatedAt") VALUES (gen_random_uuid(), '${u}', 'ExponentPushToken[${TAG}-${n.replace(' ', '')}]', 'android', now())`);
    }
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.paxUser}', '${w.cust}', 'Synthetic Rider', now())`);
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "userId", "employeeCode", "displayName", "updatedAt") VALUES ('${w.profile}', '${w.cust}', '${w.paxUser}', 'SFX1', 'Synthetic Rider', now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await closeOpen();
  });

  it('M1: VeeTrax support is view only, gives a reason for the detail, and the read is in the customer company log', async () => {
    const incidentId = await providerLinkedSos();
    // The lane: support sees the SOS, redacted (short name, no location), without a reason.
    const lane = await incidentsCtl.list(support, { open: '1' });
    const item = lane.items.find((i) => i.id === incidentId)!;
    expect(item).toMatchObject({ raiserLabel: 'Synthetic R.', lastFix: null });
    // Detail: 400 REASON_REQUIRED without a reason (platform and switched in), full with one.
    expect(await errOf(() => incidentsCtl.detail(support, incidentId))).toEqual({ status: 400, code: 'REASON_REQUIRED' });
    expect(await errOf(() => incidentsCtl.detail(supportSwitched, incidentId))).toEqual({ status: 400, code: 'REASON_REQUIRED' });
    const detail = await incidentsCtl.detail(support, incidentId, encodeURIComponent(REASON));
    expect(detail.raiserLabel).toBe('Synthetic Rider (SFX1)');
    expect(detail.lastFix).not.toBeNull();
    // The read audit is in the CUSTOMER's log (its sensitive-access log), with superAdmin + reason; none in the platform's.
    const rows = await prisma.auditLog.findMany({ where: { entity: 'TransportIncident', entityId: incidentId, action: 'ACCESS' } });
    expect(rows.map((r) => ({ companyId: r.companyId, userId: r.userId, changes: r.changes }))).toEqual([
      { companyId: w.cust, userId: w.support, changes: { what: 'incident-detail', actingCompanyId: w.platform, superAdmin: true, reason: REASON } },
    ]);
    // Never acknowledge / resolve: 403 FORBIDDEN_GRANT on the platform and switched into the customer; nothing changed.
    for (const c of [support, supportSwitched]) {
      expect(await errOf(() => incidentsCtl.ack(c, incidentId, { note: 'Called the rider' }))).toEqual({ status: 403, code: 'FORBIDDEN_GRANT' });
      expect(await errOf(() => incidentsCtl.resolve(c, incidentId, { resolution: 'FALSE_ALARM', note: 'x' }))).toEqual({ status: 403, code: 'FORBIDDEN_GRANT' });
    }
    expect((await prisma.transportIncident.findUniqueOrThrow({ where: { id: incidentId } })).status).toBe('OPEN');
    // The provider's read (MANAGE_INCIDENTS) is also logged in the customer's log, with the acting company.
    await incidentsCtl.detail(provDesk(), incidentId);
    const prov = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'TransportIncident', entityId: incidentId, userId: w.provDesk } });
    expect(prov).toMatchObject({ companyId: w.cust, changes: { what: 'incident-detail', actingCompanyId: w.prov } });
    // The customer's own dispatcher still acknowledges (own log, no acting company).
    expect((await incidentsCtl.ack(custDesk, incidentId, { note: 'Called the rider' })).status).toBe('ACKNOWLEDGED');
  });

  it('QA B1: a provider dispatcher whose picker shows its own company still sees and acts on the customer SOS', async () => {
    const incidentId = await providerLinkedSos();
    const desk = provDesk() as AuthContext;
    const narrowed = { ...desk, ...customerContextOf(desk, w.prov)! } as never;
    const lane = await incidentsCtl.list(narrowed, { open: '1' });
    expect(lane.items.map((i) => i.id)).toContain(incidentId);
    expect(lane.openCount).toBeGreaterThanOrEqual(1);
    expect((await incidentsCtl.ack(narrowed, incidentId, { note: 'Driver called back' })).status).toBe('ACKNOWLEDGED');
  });
});
