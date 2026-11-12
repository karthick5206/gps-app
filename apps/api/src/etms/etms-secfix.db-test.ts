/**
 * v1.14.0 security / QA fix round on a real, freshly migrated PostgreSQL (synthetic data only, tag sfx-…):
 *  - M1: VeeTrax support (Super Admin) is view only on incidents, needs X-Access-Reason for the detail, and the detail
 *    read lands in the incident's customer company log (like the E1b passenger reads); provider reads too.
 *  - QA B1: the customer picker (X-Transport-Customer) never narrows the SOS lane.
 *  - M2: relay off → resume and rollback → roll-forward never replay a handled SOS as a new siren; a late, still-OPEN
 *    SOS gets the quiet "still open since HH:MM" push; nothing still OPEN is dropped.
 *  - L1: a repeat press that links the trip (and so the operator) notifies the operator's dispatchers.
 *  - L4 / QA B6: SOS push recipients follow the incidents lane rule (etms / etmsProvider add-ons, customer ETMS on).
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
import { SafetyOutboxRelayService } from './safety/safety-outbox-relay.service';
import { SOS_CHANNEL } from './safety/sos-bus';
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

/** In-memory Valkey stand-in recording what the relay publishes (no real Valkey needed here). */
class RecordingValkey {
  published: { channel: string; message: { payload: { incidentId: string; status: string } } }[] = [];
  xadds = 0;
  readonly client = {
    publish: (channel: string, message: string) => {
      this.published.push({ channel, message: JSON.parse(message) as never });
      return Promise.resolve(1);
    },
    xadd: () => {
      this.xadds++;
      return Promise.resolve('1-0');
    },
  };
}

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

  describe('M2: no stale siren replay', () => {
    const valkey = new RecordingValkey();
    const relay = new SafetyOutboxRelayService(prisma as never, valkey as never);
    const pushOf = (incidentId: string) => prisma.notificationLog.findMany({ where: { refId: incidentId }, orderBy: { recipient: 'asc' } });
    const outboxOf = (incidentId: string) => prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: incidentId, type: 'transport.incident.created' } });
    /** Drain every due SAFETY row of this test's incidents (other suites' rows in the same DB are left alone). */
    const drain = async () => {
      for (let i = 0; i < 5; i++) {
        await prisma.outboxEvent.updateMany({ where: { publishedAt: null, class: 'SAFETY' }, data: { availableAt: new Date(Date.now() - 1000) } });
        const r = await relay.run();
        if (!r.claimed) break;
      }
    };
    const raise = async () => (await sos.raisePassenger(pax(), { note: 'help' }, id())).receipt.incidentId;
    afterEach(() => {
      delete process.env.ETMS_SOS_RELAY;
    });

    it('relay off → resume: fresh OPEN rings; one handled meanwhile is settled silently; a late OPEN one is the quiet form', async () => {
      await drain();
      valkey.published = [];
      process.env.ETMS_SOS_RELAY = 'off';
      expect(relay.enabled).toBe(false);
      await relay.tick(); // off: nothing claimed
      // 1) handled from the polled lane while the relay was off.
      const handled = await raise();
      expect((await incidentsCtl.resolve(custDesk, handled, { resolution: 'FALSE_ALARM', note: 'Pressed by mistake' })).status).toBe('RESOLVED');
      // 2) still OPEN, raised 40 minutes ago (the relay has been off since).
      const lateOpen = await raise();
      const at = new Date(Date.now() - 40 * 60_000);
      await prisma.transportIncident.update({ where: { id: lateOpen }, data: { raisedAt: at, receivedAt: at } });
      await prisma.outboxEvent.updateMany({ where: { aggregateId: lateOpen }, data: { createdAt: at, occurredAt: at } });
      expect((await outboxOf(handled)).publishedAt).toBeNull();
      expect((await outboxOf(lateOpen)).publishedAt).toBeNull();
      // Relay back on.
      delete process.env.ETMS_SOS_RELAY;
      await drain();
      // Handled: settled (published), NO push rows, socket refresh says RESOLVED (never OPEN), no "notified" history entry.
      expect((await outboxOf(handled)).publishedAt).not.toBeNull();
      expect(await pushOf(handled)).toEqual([]);
      const handledMsgs = valkey.published.filter((p) => p.message.payload.incidentId === handled);
      expect(handledMsgs.length).toBeGreaterThan(0);
      expect(handledMsgs.every((p) => p.channel === SOS_CHANNEL && p.message.payload.status === 'RESOLVED')).toBe(true);
      expect(await prisma.transportIncidentEvent.count({ where: { incidentId: handled, kind: { in: ['NOTIFY_PUBLISHED', 'NOTIFY_DIRECT'] } } })).toBe(0);
      // Late OPEN: delivered (never dropped) with the quiet form to the customer's dispatcher, the time in IST.
      const late = await pushOf(lateOpen);
      expect(late.map((l) => l.refType)).toEqual(['TRANSPORT_INCIDENT_LATE']);
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      expect(late[0]).toMatchObject({ recipient: `user:${w.custDesk}`, subject: 'Missed SOS, still open', body: `An SOS has been open since ${hhmm} and was not delivered at once. Open VeeTrax now.` });
      expect(valkey.published.filter((p) => p.message.payload.incidentId === lateOpen).map((p) => p.message.payload.status)).toEqual(['OPEN']);
      const ev = await prisma.transportIncidentEvent.findFirstOrThrow({ where: { incidentId: lateOpen, kind: 'NOTIFY_PUBLISHED' } });
      expect(ev.data).toMatchObject({ late: true });
      // A fresh SOS after the resume rings as usual (siren ref type).
      await closeOpen();
      const fresh = await raise();
      await drain();
      expect((await pushOf(fresh)).map((l) => l.refType)).toEqual(['TRANSPORT_INCIDENT']);
    });

    it('L1: a repeat press that links the trip adds the operator, whose dispatchers are pushed (only they)', async () => {
      await closeOpen();
      await drain();
      const trip = id();
      await sql(`INSERT INTO "TransportTrip" (id, "providerCompanyId", "customerCompanyId", "agreementId", "serviceDate", direction, "seatCapacity", "updatedAt") VALUES ('${trip}', '${w.prov}', '${w.cust}', '${w.agreement}', CURRENT_DATE, 'IN', 4, now())`);
      // First press: no linkable trip (customer only). Second press: the trip is now found (stubbed lookup).
      const first = await raise();
      await drain();
      expect((await pushOf(first)).map((l) => l.recipient)).toEqual([`user:${w.custDesk}`]);
      const stub = sos as unknown as { tripLink: () => Promise<unknown> };
      const original = stub.tripLink;
      stub.tripLink = () => Promise.resolve({ tripId: trip, providerCompanyId: w.prov, customerCompanyId: w.cust, vehicleLabel: 'TN 01 SF 0001' });
      try {
        const again = await sos.raisePassenger(pax(), { note: 'still need help' }, id());
        expect(again).toMatchObject({ created: false, receipt: { incidentId: first, merged: true } });
      } finally {
        stub.tripLink = original;
      }
      const linkedRow = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: first, type: 'transport.incident.linked' } });
      expect(linkedRow).toMatchObject({ class: 'SAFETY', providerCompanyId: w.prov, customerCompanyId: w.cust, publishedAt: null });
      await drain();
      const pushes = await pushOf(first);
      expect(pushes.map((l) => [l.recipient, l.refType]).sort()).toEqual([[`user:${w.custDesk}`, 'TRANSPORT_INCIDENT'], [`user:${w.provDesk}`, 'TRANSPORT_INCIDENT']].sort());
      expect(valkey.published.some((p) => p.message.payload.incidentId === first && p.message.payload.status === 'OPEN')).toBe(true);
      // A third press (already linked) writes no further linked row.
      await sos.raisePassenger(pax(), { note: 'third' }, id());
      expect(await prisma.outboxEvent.count({ where: { aggregateId: first, type: 'transport.incident.linked' } })).toBe(1);
    });

    it('L4 / B6: push recipients follow the lane rule: no etmsProvider or customer ETMS off → the provider gets nothing', async () => {
      const incident = { raiserType: 'PASSENGER', providerCompanyId: w.prov, customerCompanyId: w.cust };
      const setFeatures = (company: string, f: string[]) => prisma.company.update({ where: { id: company }, data: { settings: { features: f } } });
      try {
        expect(await relay.recipientCompanies(incident)).toEqual([w.prov, w.cust]);
        await setFeatures(w.prov, ['etms']); // etmsProvider off: no customer grants on the lane, so no push either
        expect(await relay.recipientCompanies(incident)).toEqual([w.cust]);
        await setFeatures(w.prov, ['etms', 'etmsProvider']);
        await setFeatures(w.cust, []); // the customer's module off: neither its own desk nor (through the agreement) the provider
        expect(await relay.recipientCompanies(incident)).toEqual([]);
        await setFeatures(w.cust, ['etms']);
        await prisma.transportServiceAgreement.update({ where: { id: w.agreement }, data: { grants: ['VIEW_BOOKINGS'] } });
        expect(await relay.recipientCompanies(incident)).toEqual([w.cust]);
        // A driver SOS: the operator always; the customer of the trip as the lane allows it (incidentAccess).
        expect(await relay.recipientCompanies({ raiserType: 'DRIVER', providerCompanyId: w.prov, customerCompanyId: w.cust })).toEqual([w.prov, w.cust]);
      } finally {
        await setFeatures(w.prov, ['etms', 'etmsProvider']);
        await setFeatures(w.cust, ['etms']);
        await prisma.transportServiceAgreement.update({ where: { id: w.agreement }, data: { grants: ['MANAGE_INCIDENTS'] } });
      }
    });

    it('rollback (no relay for a day) → roll-forward: the acknowledged one is settled, the open one is the quiet form', async () => {
      await drain();
      valkey.published = [];
      const day = new Date(Date.now() - 26 * 3_600_000);
      const acked = await raise();
      expect((await incidentsCtl.ack(custDesk, acked, { note: 'Called the rider' })).status).toBe('ACKNOWLEDGED');
      await closeOpen();
      const open = await raise();
      for (const i of [acked, open]) await prisma.outboxEvent.updateMany({ where: { aggregateId: i, type: 'transport.incident.created' }, data: { createdAt: day } });
      // The acknowledgement row itself (transport.incident.acknowledged) carries the real status.
      await drain();
      expect(await pushOf(acked)).toEqual([]);
      expect(valkey.published.filter((p) => p.message.payload.incidentId === acked).every((p) => p.message.payload.status === 'ACKNOWLEDGED')).toBe(true);
      expect((await pushOf(open)).map((l) => l.refType)).toEqual(['TRANSPORT_INCIDENT_LATE']);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: { in: [acked, open] }, publishedAt: null } })).toBe(0);
    });
  });
});
