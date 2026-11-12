/**
 * ETMS E1b WP 1b.3: provider-side isolation on a real, freshly migrated PostgreSQL (doc 11 §3.1 "Level 2: a fixture per
 * scope, 2 providers × 3 customers × agreements"; §3.2 provider-to-customer leakage cases 1–10; doc 12 §6 E1b exit
 * criteria). Every caller context is built by the real AuthContextService.forUser (agreements loaded from the database
 * per request, as the HTTP pipeline does), and every read goes through the real services and their Prisma queries.
 *
 * Fixture (synthetic, tag `e1b-…`): providers P1, P2; customers C1, C2, C3; each customer has two offices (s1, s2), a
 * passenger at each and a booking per passenger.
 *   P1 ↔ C1 ACTIVE  (VIEW_BOOKINGS, MANAGE_DISPATCH, VIEW_PASSENGER_MINIMAL), all sites
 *   P1 ↔ C2 ACTIVE  (VIEW_BOOKINGS, VIEW_PASSENGER_MINIMAL), site s1 only, no dispatch
 *   P1 ↔ C3 none
 *   P2 ↔ C3 ACTIVE  (all grants incl. VIEW_PASSENGER_CONTACT, STANDARD)
 *   P2 ↔ C1 SUSPENDED, P2 ↔ C2 ENDED
 * P1's vehicle V1 runs trip T1 for C1 (08:00) and then trip T2 for C2 (10:00). Bookings of C1 / C2 carry provider P1,
 * those of C3 provider P2.
 *
 * Cases 3, 4, 5, 8 and 10 of §3.2 concern the driver API, the passenger's own view, sockets, notifications / webhooks and
 * GPS-only tenants; they are covered by existing suites (named in the test titles below) and re-asserted here only
 * where the provider side touches them. Not part of the normal run (testRegex is *.spec.ts):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_x_test npx jest --testRegex 'etms-provider-isolation\.db-test\.ts$' --runInBand
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { PassengerDto, TransportAccessLogEntryDto, TransportBookingDto, TransportTripDto } from '@veetracer/shared';
import { requireSupportReason } from '../access/access-reason';
import type { AuthContext } from '../access/auth-context';
import { AuthContextService } from '../access/auth-context.service';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { planPurge, rootCondition, stepSql, type Catalog, type FkEdge } from '../purge/purge-plan';
import { PURGE_EVIDENCE_WRITE } from '../purge/purge.service';
import { dbDescribe } from '../test/scratch-db';
import { AgreementsService } from './agreements/agreements.service';
import { FleetAllocationsService } from './agreements/fleet-allocations.service';
import { BookingsService } from './dispatch/bookings.service';
import { DispatchService } from './dispatch/dispatch.service';
import { TripLiveService } from './dispatch/trip-live';
import { TripsService } from './dispatch/trips.service';
import { ensureEtmsRoleTemplates } from './etms-role-templates';
import { ConsentNoticeService } from './people/consent-notice.service';
import { PeopleService } from './people/people.service';
import { TransportProviderService } from './provider/transport-provider.service';
import { TransportFeatureGuard } from './transport-feature.guard';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `e1b-${Date.now().toString(36)}`;
const DAY = 86_400_000;

const statusOf = (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e: unknown) => (e instanceof HttpException ? e.getStatus() : -1));
const codeOf = (p: Promise<unknown>): Promise<string> => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `unexpected: ${String(e)}`));
const items = <T>(r: unknown) => (r as { items: T[] }).items;

async function loadCatalog(db: PrismaClient): Promise<Catalog> {
  const fks = await db.$queryRawUnsafe<FkEdge[]>(`
    SELECT c.relname AS child, a.attname AS col, p.relname AS parent, pa.attname AS "refCol", con.confdeltype::text AS del
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class p ON p.oid = con.confrelid
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND n.nspname = 'public'`);
  const cols = await db.$queryRawUnsafe<{ table: string; column: string }[]>(`
    SELECT c.table_name AS "table", c.column_name AS "column" FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'`);
  const columns = new Map<string, Set<string>>();
  for (const { table, column } of cols) (columns.get(table) ?? columns.set(table, new Set()).get(table)!).add(column);
  return { fks, columns };
}

type Key = 'P1' | 'P2' | 'C1' | 'C2' | 'C3';

d(`ETMS E1b provider isolation (2 providers × 3 customers) on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = {
    invalidateCache: async () => undefined,
    client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => 1, publish: async () => 1, xadd: async () => '1-0' },
  };
  const audit = new AuditService(prisma as never);
  const contexts = new AuthContextService(prisma as never, null as never, null as never);
  const people = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
  const bookings = new BookingsService(prisma as never, audit, redis as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const dispatch = new DispatchService(prisma as never, audit, { enabled: false, route: async () => null, routeVia: async () => null } as never, live, redis as never);
  const trips = new TripsService(prisma as never, audit, plannedTrips, dispatch, live);
  const agreements = new AgreementsService(prisma as never, audit, redis as never);
  const fleet = new FleetAllocationsService(prisma as never, audit);
  const provider = new TransportProviderService(prisma as never);
  const guard = new TransportFeatureGuard();

  let partnerId = '';
  const co = {} as Record<Key, string>;
  const admin = {} as Record<Key, string>;
  const dispatcher = {} as Record<Key, string>;
  const site = {} as Record<'C1' | 'C2' | 'C3', { s1: string; s2: string }>;
  const pax = {} as Record<'C1' | 'C2' | 'C3', { s1: string; s2: string }>;
  const booking = {} as Record<'C1' | 'C2' | 'C3', { s1: string; s2: string }>;
  const agr = {} as Record<'P1C1' | 'P1C2' | 'P2C3' | 'P2C1' | 'P2C2', string>;
  let superAdmin = '';
  let v1 = '';
  let t1 = '';
  let t2 = '';
  let gpsOnly = '';

  /** As the HTTP pipeline: forUser (agreements from the DB), then the customer-context header via the feature guard. */
  const as = async (userId: string, opts: { companyId?: string; customer?: string } = {}): Promise<AuthContext> => {
    const ctx = await contexts.forUser(userId, opts.companyId, null);
    const exec = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ auth: ctx, headers: opts.customer ? { 'x-transport-customer': opts.customer } : {} }) }) } as unknown as ExecutionContext;
    guard.canActivate(exec);
    return ctx;
  };
  const passengerIds = async (ctx: AuthContext) => items<PassengerDto>(await people.list(ctx, {})).map((p) => p.id);
  const bookingIds = async (ctx: AuthContext) => items<TransportBookingDto>(await bookings.list(ctx, { pageSize: 200 })).map((b) => b.id);
  const tripIds = async (ctx: AuthContext) => items<TransportTripDto>(await trips.list(ctx, { pageSize: 200 })).map((t) => t.id);

  beforeAll(async () => {
    process.env.ETMS = 'on';
    const [p] = await prisma.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), ${`${TAG} partner`}, ${`${TAG}-partner`}, now()) RETURNING id`;
    partnerId = p.id;
    const company = async (name: string, features: string[]) =>
      (await prisma.company.create({ data: { partnerId, name: `${TAG} ${name}`, timezone: 'Asia/Kolkata', settings: { features } } })).id;
    co.P1 = await company('Provider One', ['etms', 'etmsProvider']);
    co.P2 = await company('Provider Two', ['etms', 'etmsProvider']);
    co.C1 = await company('Customer One', ['etms']);
    co.C2 = await company('Customer Two', ['etms']);
    co.C3 = await company('Customer Three', ['etms']);
    gpsOnly = await company('GPS only', []);
    const home = await company('Support home', []);
    superAdmin = (await prisma.user.create({ data: { companyId: home, name: `${TAG} support`, email: `${TAG}-sa@example.test`, isSuperAdmin: true } })).id;
    for (const k of Object.keys(co) as Key[]) {
      await ensureEtmsRoleTemplates(prisma as never, co[k]);
      const role = async (name: string) => (await prisma.role.findUniqueOrThrow({ where: { companyId_name: { companyId: co[k], name } } })).id;
      const user = async (label: string, roleName: string) => {
        const u = await prisma.user.create({ data: { companyId: co[k], name: `${TAG} ${k} ${label}`, email: `${TAG}-${k}-${label}@example.test`.toLowerCase() } });
        await prisma.userRole.create({ data: { userId: u.id, roleId: await role(roleName) } });
        return u.id;
      };
      admin[k] = await user('admin', 'Transport admin');
      dispatcher[k] = await user('dispatcher', 'Transport dispatcher');
    }
    for (const k of ['C1', 'C2', 'C3'] as const) {
      const poi = async (n: string) => (await prisma.poi.create({ data: { companyId: co[k], name: `${TAG} ${k} ${n}`, category: 'OFFICE', lat: 13.05, lng: 80.25 } })).id;
      site[k] = { s1: await poi('office 1'), s2: await poi('office 2') };
      const passenger = async (n: 's1' | 's2') =>
        (await prisma.employeeTransportProfile.create({
          data: { companyId: co[k], employeeCode: `${k}-${n}`, displayName: `${TAG} ${k} rider ${n}`, officePoiId: site[k][n], mobile: '+919800000000', email: `${k}-${n}@example.test`.toLowerCase(), homeAddress: `${k} ${n} synthetic lane`, homeLat: 13.06, homeLng: 80.24 },
        })).id;
      pax[k] = { s1: await passenger('s1'), s2: await passenger('s2') };
      const providerOf = k === 'C3' ? co.P2 : co.P1;
      const book = async (n: 's1' | 's2') =>
        (await prisma.transportBooking.create({
          data: { customerCompanyId: co[k], providerCompanyId: providerOf, profileId: pax[k][n], source: 'ADHOC', serviceDate: new Date(Date.now() + DAY), direction: 'IN', timeZone: 'Asia/Kolkata', windowStart: new Date(Date.now() + DAY), windowEnd: new Date(Date.now() + DAY + 3_600_000) },
        })).id;
      booking[k] = { s1: await book('s1'), s2: await book('s2') };
    }
    const agreement = async (p: Key, c: Key, status: 'ACTIVE' | 'SUSPENDED' | 'ENDED', grants: string[], extra: Record<string, unknown> = {}) =>
      (await prisma.transportServiceAgreement.create({
        data: {
          providerCompanyId: co[p],
          customerCompanyId: co[c],
          status,
          validFrom: new Date(Date.now() - 30 * DAY),
          grants: grants as never,
          approvedByCustomerAt: new Date(),
          approvedByProviderAt: new Date(),
          ...(status === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
          ...(status === 'ENDED' ? { endedAt: new Date() } : {}),
          ...extra,
        },
      })).id;
    agr.P1C1 = await agreement('P1', 'C1', 'ACTIVE', ['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL']);
    agr.P1C2 = await agreement('P1', 'C2', 'ACTIVE', ['VIEW_BOOKINGS', 'VIEW_PASSENGER_MINIMAL'], { siteIds: [site.C2.s1] });
    agr.P2C3 = await agreement('P2', 'C3', 'ACTIVE', ['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL', 'VIEW_PASSENGER_CONTACT'], { dataProfile: 'STANDARD' });
    agr.P2C1 = await agreement('P2', 'C1', 'SUSPENDED', ['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL']);
    agr.P2C2 = await agreement('P2', 'C2', 'ENDED', ['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL']);
    // Case 2: one vehicle of P1, a trip for C1 and then a trip for C2.
    v1 = (await prisma.trackedObject.create({ data: { companyId: co.P1, name: `${TAG} V1`, plateNumber: 'SYN 0001' } })).id;
    const trip = async (customer: Key, hour: number) => {
      const start = new Date(Date.now() + DAY);
      start.setUTCHours(hour, 0, 0, 0);
      const pt = await prisma.plannedTrip.create({ data: { companyId: co.P1, origin: 'ETMS', objectId: v1, routeName: `${TAG} run ${customer}`, corridorM: 300, plannedStart: start, plannedEnd: new Date(start.getTime() + 3_600_000) } });
      return (await prisma.transportTrip.create({ data: { plannedTripId: pt.id, providerCompanyId: co.P1, customerCompanyId: co[customer], agreementId: customer === 'C1' ? agr.P1C1 : agr.P1C2, serviceDate: new Date(start.toISOString().slice(0, 10)), direction: 'IN', seatCapacity: 4, publishedAt: new Date() } })).id;
    };
    t1 = await trip('C1', 2);
    t2 = await trip('C2', 4);
  });

  afterAll(async () => {
    const cat = await loadCatalog(prisma);
    for (const id of [...Object.values(co), gpsOnly]) {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(PURGE_EVIDENCE_WRITE);
          for (const s of planPurge(cat, 'Company', rootCondition(id))) await tx.$executeRawUnsafe(stepSql(s));
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    }
    const sa = await prisma.user.findUnique({ where: { id: superAdmin }, select: { companyId: true } });
    if (sa) {
      await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "companyId" = '${sa.companyId}'`);
      await prisma.user.delete({ where: { id: superAdmin } });
      await prisma.company.delete({ where: { id: sa.companyId } });
    }
    await prisma.$executeRawUnsafe(`DELETE FROM "Partner" WHERE id = '${partnerId}'`);
    const left = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "Company" WHERE name LIKE '${TAG} %'`);
    await prisma.$disconnect();
    expect(Number(left[0].n)).toBe(0);
  });

  it('[fixture] contexts come from the database: P1 acts for C1 and C2, P2 only for C3 (suspended / ended agreements give nothing)', async () => {
    expect((await as(admin.P1)).agreements!.map((a) => a.customerCompanyId).sort()).toEqual([co.C1, co.C2].sort());
    expect((await as(admin.P2)).agreements!.map((a) => a.customerCompanyId)).toEqual([co.C3]);
    for (const k of ['C1', 'C2', 'C3'] as const) expect((await as(admin[k])).agreements).toEqual([]);
  });

  it('[3.2 #1] provider lists show only customers with an active agreement, limited to the agreement sites and grants', async () => {
    const p1 = await as(admin.P1);
    expect((await passengerIds(p1)).sort()).toEqual([pax.C1.s1, pax.C1.s2, pax.C2.s1].sort());
    expect((await bookingIds(p1)).sort()).toEqual([booking.C1.s1, booking.C1.s2, booking.C2.s1].sort());
    expect(await tripIds(p1)).toEqual([t1]); // C2's agreement has no MANAGE_DISPATCH
    const p2 = await as(admin.P2);
    expect((await passengerIds(p2)).sort()).toEqual([pax.C3.s1, pax.C3.s2].sort());
    expect((await bookingIds(p2)).sort()).toEqual([booking.C3.s1, booking.C3.s2].sort());
    expect(await tripIds(p2)).toEqual([]);
    // MINIMAL projection for a provider: no home, no branch; contact masked or absent.
    const list = items<PassengerDto>(await people.list(p1, {}));
    for (const p of list) {
      expect(p.projection).toBe('MINIMAL');
      expect(p.home).toBeNull();
    }
    const detail = await people.get(p1, pax.C1.s1);
    expect(detail.projection).toBe('MINIMAL');
    expect(JSON.stringify(detail)).not.toContain('synthetic lane');
    expect(JSON.stringify(detail)).not.toContain('+919800000000');
  });

  it('[3.2 #2] the vehicle that served C1 does not open C2’s next trip (manifest) to the provider without a dispatch grant', async () => {
    const p1 = await as(admin.P1);
    expect(await statusOf(trips.get(p1, t1))).toBe(200);
    expect(await statusOf(trips.get(p1, t2))).toBe(404);
    expect(await statusOf(trips.get(await as(admin.P2), t1))).toBe(404);
    // Narrowed to C1, C2's rows are gone too; narrowed to C2, not even C1's trip shows.
    expect(await tripIds(await as(admin.P1, { customer: co.C2 }))).toEqual([]);
  });

  it('[3.2 #6] exports: a provider exports none of a customer’s passengers or bookings; the customer’s log shows the provider reads', async () => {
    const p1 = await as(admin.P1);
    const csv = async (f: unknown) => {
      const chunks: Buffer[] = [];
      for await (const c of (f as { getStream(): AsyncIterable<Buffer> }).getStream()) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString('utf8');
    };
    const passengersCsv = await csv(await people.list(p1, { format: 'csv' }));
    for (const k of ['C1', 'C2', 'C3'] as const) expect(passengersCsv).not.toContain(`${k}-s1`);
    const bookingsCsv = await csv(await bookings.list(p1, { format: 'csv' }));
    expect(bookingsCsv).not.toContain(`${TAG} C1`);
    // The provider's reads above are in C1's sensitive-access log, named with the provider; never in C3's.
    const c1Log = items<TransportAccessLogEntryDto>(await provider.accessLog(await as(admin.C1), {}));
    expect(c1Log.some((e) => e.actorKind === 'PROVIDER' && e.actorCompanyName === `${TAG} Provider One`)).toBe(true);
    expect(c1Log.every((e) => e.actorKind !== 'OWN')).toBe(true);
    const c3Log = items<TransportAccessLogEntryDto>(await provider.accessLog(await as(admin.C3), {}));
    expect(c3Log.some((e) => e.actorCompanyName === `${TAG} Provider One`)).toBe(false);
    // Branch-scoped users never see the log; P1's own log holds no customer reads.
    expect(await codeOf(provider.accessLog(await as(dispatcher.C1), {}))).toBe('SCOPE_REQUIRED');
    expect(items(await provider.accessLog(await as(admin.P1), {}))).toEqual([]);
  });

  it('[3.2 #7] other tenants’ ids are 404, never 403; search finds nothing across tenants; a foreign customer header is 404', async () => {
    const p1 = await as(admin.P1);
    expect(await statusOf(people.get(p1, pax.C3.s1))).toBe(404);
    expect(await statusOf(people.get(p1, pax.C2.s2))).toBe(404); // outside the agreement's sites
    expect(await statusOf(bookings.get(p1, booking.C3.s1))).toBe(404);
    expect(await statusOf(bookings.get(p1, booking.C2.s2))).toBe(404);
    expect(await statusOf(bookings.get(p1, booking.C2.s1))).toBe(200);
    expect(await statusOf(agreements.get(p1, agr.P2C3))).toBe(404);
    expect(await statusOf(fleet.list(p1, agr.P2C3))).toBe(404);
    expect(items(await people.list(p1, { q: 'C3' }))).toEqual([]);
    expect(items(await people.list(p1, { q: '+9198' }))).toEqual([]); // contacts are not searchable by providers
    for (const id of [co.C3, co.P2, randomUUID(), 'x']) expect(await statusOf(as(admin.P1, { customer: id }))).toBe(404);
    // C1 as a customer cannot "act for" P1 or C2 either.
    expect(await statusOf(as(admin.C1, { customer: co.C2 }))).toBe(404);
  });

  it('[3.2 #9] only the Super Admin switches company (X-Company-Id); it then needs a reason for passenger data, logged for the customer', async () => {
    expect((await as(admin.P1, { companyId: co.C3 })).companyId).toBe(co.P1);
    const sa = await as(superAdmin, { companyId: co.C1 });
    expect(sa.companyId).toBe(co.C1);
    expect(() => requireSupportReason(sa, undefined)).toThrow(HttpException);
    const reason = requireSupportReason(sa, encodeURIComponent('Ticket 77: rider cannot log in'));
    await people.get(sa, pax.C1.s1, { reason });
    const log = items<TransportAccessLogEntryDto>(await provider.accessLog(await as(admin.C1), {}));
    expect(log.some((e) => e.actorKind === 'SUPPORT' && e.reason === 'Ticket 77: rider cannot log in' && e.subjectName === `${TAG} C1 rider s1`)).toBe(true);
  });

  it('[3.2 #10] a GPS-only tenant loads no agreements and its context is untouched by ETMS', async () => {
    const u = await prisma.user.create({ data: { companyId: gpsOnly, name: `${TAG} gps user`, email: `${TAG}-gps@example.test` } });
    const ctx = await contexts.forUser(u.id, undefined, null);
    expect(ctx.agreements).toEqual([]);
    expect(TransportFeatureGuard.hiddenFor(ctx)).toBe(true);
  });

  it('customer context: the picker offers exactly the in-force customers; narrowing hides the other customers’ rows', async () => {
    const ctxDto = await provider.context(await as(admin.P1));
    expect(ctxDto.showPicker).toBe(true);
    expect(ctxDto.customers.map((c) => c.customerCompanyId)).toEqual([co.P1, co.C1, co.C2]);
    const c2Only = await as(admin.P1, { customer: co.C2 });
    expect(await passengerIds(c2Only)).toEqual([pax.C2.s1]);
    expect(await bookingIds(c2Only)).toEqual([booking.C2.s1]);
    expect(await statusOf(people.get(c2Only, pax.C1.s1))).toBe(404);
    expect((await provider.context(c2Only)).selected).toBe(co.C2);
    // A customer company (no provider add-on) gets no picker.
    expect((await provider.context(await as(admin.C1))).showPicker).toBe(false);
  });

  it('fleet allocation: P1 allocates V1 to C1; C1 sees it read-only; P2 and C3 get 404; double allocation is 409', async () => {
    const p1 = await as(admin.P1);
    const a = await fleet.create(p1, agr.P1C1, { objectId: v1 });
    expect(a).toMatchObject({ active: true, canEnd: true, vehicle: { id: v1 } });
    expect(await codeOf(fleet.create(p1, agr.P1C1, { objectId: v1 }))).toBe('ALLOCATION_OVERLAP');
    // The same vehicle may also serve C2 (another agreement).
    expect(await codeOf(fleet.create(p1, agr.P1C2, { objectId: v1 }))).toBe('OK');
    const seen = await fleet.list(await as(admin.C1), agr.P1C1);
    expect(seen.map((x) => [x.vehicle?.id, x.canEnd])).toEqual([[v1, false]]);
    expect(await codeOf(fleet.create(await as(admin.C1), agr.P1C1, { objectId: v1 }))).toBe('FORBIDDEN_GRANT');
    expect(await statusOf(fleet.list(await as(admin.P2), agr.P1C1))).toBe(404);
    expect(await statusOf(fleet.list(await as(admin.C3), agr.P1C1))).toBe(404);
    // Another provider's vehicle id is "not found" (no enumeration).
    const foreign = await prisma.trackedObject.create({ data: { companyId: co.P2, name: `${TAG} P2 bus` } });
    expect(await codeOf(fleet.create(p1, agr.P1C1, { objectId: foreign.id }))).toBe('NOT_FOUND');
  });

  it('[exit] ending an agreement revokes the provider’s access on the very next request and closes its allocations', async () => {
    const before = await as(admin.P1);
    expect(await passengerIds(before)).toContain(pax.C1.s1);
    const row = await prisma.transportServiceAgreement.findUniqueOrThrow({ where: { id: agr.P1C1 } });
    await agreements.end(await as(admin.C1), agr.P1C1, 'contract over', row.version);
    // Next request: a fresh context from the database (as every HTTP request builds one).
    const after = await as(admin.P1);
    expect(after.agreements!.map((a) => a.customerCompanyId)).toEqual([co.C2]);
    expect(await passengerIds(after)).toEqual([pax.C2.s1]);
    expect(await bookingIds(after)).toEqual([booking.C2.s1]);
    expect(await tripIds(after)).toEqual([]);
    expect(await statusOf(people.get(after, pax.C1.s1))).toBe(404);
    expect(await statusOf(bookings.get(after, booking.C1.s1))).toBe(404);
    expect(await statusOf(trips.get(after, t1))).toBe(404);
    expect(await statusOf(as(admin.P1, { customer: co.C1 }))).toBe(404);
    expect((await provider.context(after)).customers.map((c) => c.customerCompanyId)).toEqual([co.P1, co.C2]);
    const open = await prisma.transportFleetAllocation.count({ where: { agreementId: agr.P1C1, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] } });
    expect(open).toBe(0);
    // The agreement row itself stays readable to both parties (history), with no commands left for the provider.
    expect((await agreements.get(after, agr.P1C1)).status).toBe('ENDED');
  });

  it('[exit] suspending works the same way; resuming restores access (customer’s call only)', async () => {
    const row = await prisma.transportServiceAgreement.findUniqueOrThrow({ where: { id: agr.P2C3 } });
    await agreements.suspend(await as(admin.C3), agr.P2C3, 'review', row.version);
    const p2 = await as(admin.P2);
    expect(await passengerIds(p2)).toEqual([]);
    expect(await bookingIds(p2)).toEqual([]);
    await agreements.resume(await as(admin.C3), agr.P2C3, row.version + 1);
    expect((await passengerIds(await as(admin.P2))).sort()).toEqual([pax.C3.s1, pax.C3.s2].sort());
  });

  it('[exit] switching the provider add-on off removes every customer grant on the next request', async () => {
    const before = await prisma.company.findUniqueOrThrow({ where: { id: co.P2 }, select: { settings: true } });
    await prisma.company.update({ where: { id: co.P2 }, data: { settings: { features: ['etms'] } } });
    const p2 = await as(admin.P2);
    expect(p2.agreements).toEqual([]);
    expect(await passengerIds(p2)).toEqual([]);
    await prisma.company.update({ where: { id: co.P2 }, data: { settings: before.settings as never } });
  });
});
