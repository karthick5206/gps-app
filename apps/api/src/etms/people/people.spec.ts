import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PassengerDto } from '@veetracer/shared';
import type { AuthContext, TransportAgreementScope } from '../../access/auth-context';
import { diffSnapshots } from '../../audit/audit.service';
import { ConsentNoticeService } from './consent-notice.service';
import { PeopleService } from './people.service';

/**
 * Passenger API rules (authorisation matrix doc 05 §6, minimum data profile doc 10 §2, consent doc 10 §4.2, D5 / P3
 * identity) against an in-memory store that evaluates the service's Prisma where-clauses, so cross-company visibility is
 * tested on the real queries.
 */
type Obj = Record<string, unknown>;

function matches(row: Obj, where: Obj | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return (cond as Obj[]).every((w) => matches(row, w));
    if (k === 'OR') return (cond as Obj[]).some((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, cond as Obj);
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Obj;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(v);
      if ('not' in c) return v !== c.not;
      if ('contains' in c) return typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase());
      return true;
    }
    return v === cond;
  });
}

const A = 'custA';
const B = 'custB';
const PROV = 'prov';
const SITE1 = 'site-1';
const SITE2 = 'site-2';

function world() {
  const now = new Date('2026-11-10T10:00:00Z');
  const profiles: Obj[] = [];
  const consents: Obj[] = [];
  const users: Obj[] = [];
  const roles: Obj[] = [];
  const userRoles: Obj[] = [];
  const notices: Obj[] = [];
  const auditRows: Obj[] = [];
  const pois: Obj[] = [
    { id: SITE1, companyId: A, name: 'HQ', lat: 13.01, lng: 80.2, isActive: true },
    { id: SITE2, companyId: A, name: 'Annex', lat: 13.02, lng: 80.21, isActive: true },
    { id: 'stop-1', companyId: A, name: 'Stop Velachery', lat: 12.98, lng: 80.22, isActive: true },
    { id: 'site-b', companyId: B, name: 'B HQ', lat: 12.9, lng: 77.6, isActive: true },
  ];
  const branches: Obj[] = [
    { id: 'b1', companyId: A, name: 'North', isActive: true },
    { id: 'b2', companyId: A, name: 'South', isActive: true },
  ];
  const add = (over: Obj): Obj => {
    const r: Obj = {
      id: randomUUID(),
      companyId: A,
      branchId: null,
      userId: null,
      employeeCode: `E${profiles.length + 1}`,
      displayName: 'Asha Krishnan',
      mobile: '+919876543210',
      email: `p${profiles.length + 1}@corp.test`,
      homeAddress: '12 Anna Salai, Chennai',
      homeLat: 13.060412,
      homeLng: 80.249679,
      homeGeocodeSource: 'PIN',
      homeGeocodeConfidence: null,
      officePoiId: SITE1,
      defaultStopPoiId: null,
      accessibility: { wheelchair: true, notes: 'Front seat' },
      preferences: {},
      emergencyContacts: [{ name: 'Ravi', phone: '+919800000001' }],
      isActive: true,
      anonymisedAt: null,
      createdById: null,
      createdAt: now,
      updatedAt: now,
      ...over,
    };
    profiles.push(r);
    return r;
  };
  const withRel = (r: Obj | undefined) => {
    if (!r) return null;
    const user = users.find((u) => u.id === r.userId);
    return {
      ...r,
      branch: branches.find((b) => b.id === r.branchId) ?? null,
      officePoi: pois.find((p) => p.id === r.officePoiId) ?? null,
      defaultStop: pois.find((p) => p.id === r.defaultStopPoiId) ?? null,
      user: user ? { ...user, roles: userRoles.filter((ur) => ur.userId === user.id).map((ur) => ({ role: roles.find((x) => x.id === ur.roleId) })) } : null,
    };
  };
  const userWithRoles = (u: Obj | undefined) => (u ? { ...u, roles: userRoles.filter((ur) => ur.userId === u.id) } : null);
  let tick = 0;
  const prisma: Obj = {
    employeeTransportProfile: {
      findFirst: async ({ where }: { where: Obj }) => withRel(profiles.find((p) => matches(p, where))),
      findMany: async ({ where }: { where: Obj }) => profiles.filter((p) => matches(p, where)).map(withRel),
      count: async ({ where }: { where: Obj }) => profiles.filter((p) => matches(p, where)).length,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withRel(profiles.find((p) => p.id === where.id)),
      create: async ({ data }: { data: Obj }) => {
        if (profiles.some((p) => p.companyId === data.companyId && p.employeeCode === data.employeeCode)) throw new Error('P2002');
        return withRel(add({ ...data, id: randomUUID() }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Obj }) => {
        const r = profiles.find((p) => p.id === where.id)!;
        Object.assign(r, data, { updatedAt: new Date() });
        return withRel(r);
      },
    },
    employeeTransportConsent: {
      create: async ({ data }: { data: Obj }) => {
        const r = { id: randomUUID(), occurredAt: new Date(now.getTime() + ++tick * 1000), ...data };
        consents.push(r);
        return r;
      },
      findMany: async ({ where }: { where: Obj }) => consents.filter((c) => matches(c, where)).sort((a, b) => (b.occurredAt as Date).getTime() - (a.occurredAt as Date).getTime()),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const latest = (rows: Obj[], key: (r: Obj) => string) => {
        const m = new Map<string, Obj>();
        for (const r of [...rows].sort((a, b) => (a.occurredAt as Date).getTime() - (b.occurredAt as Date).getTime())) m.set(key(r), r);
        return [...m.values()];
      };
      if (sql.includes('DISTINCT ON ("profileId", "purpose")')) {
        const ids = values[0] as string[];
        return latest(consents.filter((c) => ids.includes(c.profileId as string)), (r) => `${r.profileId}|${r.purpose}`);
      }
      const [companies, purpose] = values as [string[], string];
      return latest(consents.filter((c) => companies.includes(c.companyId as string) && c.purpose === purpose), (r) => r.profileId as string).filter((r) => r.granted);
    },
    transportConsentNotice: {
      findMany: async ({ where }: { where: Obj }) => notices.filter((n) => matches(n, where)),
      findFirst: async ({ where }: { where: Obj }) => notices.filter((n) => matches(n, where)).sort((a, b) => (b.seq as number) - (a.seq as number))[0] ?? null,
      create: async ({ data }: { data: Obj }) => {
        const r = { id: randomUUID(), createdAt: new Date(), ...data };
        notices.push(r);
        return r;
      },
    },
    // Interprets the where of PeopleService.history: companyId, action.not, OR of { entity, entityId | entityId.in | changes.path }.
    auditLog: {
      findMany: async ({ where }: { where: { companyId: string; action?: { not: string }; OR: Obj[] } }) =>
        auditRows
          .filter((r) => r.companyId === where.companyId && (!where.action || r.action !== where.action.not))
          .filter((r) =>
            where.OR.some((o) => {
              if (o.entity !== r.entity) return false;
              if (typeof o.entityId === 'string') return r.entityId === o.entityId;
              if (o.entityId) return ((o.entityId as Obj).in as string[]).includes(r.entityId as string);
              const { path, equals } = o.changes as { path: string[]; equals: string };
              return path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Obj)[k] : undefined), r.changes) === equals;
            }),
          )
          .reverse(),
    },
    company: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
    branch: { count: async ({ where }: { where: Obj }) => branches.filter((b) => matches(b, where)).length },
    poi: { count: async ({ where }: { where: Obj }) => pois.filter((p) => matches(p, where)).length },
    role: {
      findUnique: async ({ where }: { where: { companyId_name: { companyId: string; name: string } } }) => roles.find((r) => r.companyId === where.companyId_name.companyId && r.name === where.companyId_name.name) ?? null,
      create: async ({ data }: { data: Obj }) => {
        const r = { id: randomUUID(), companyId: data.companyId, name: data.name };
        roles.push(r);
        return r;
      },
    },
    user: {
      findMany: async ({ where }: { where: Obj }) => users.filter((u) => matches(u, where)).map(userWithRoles),
      findUnique: async ({ where }: { where: { id: string } }) => userWithRoles(users.find((u) => u.id === where.id)),
      create: async ({ data }: { data: Obj & { roles: { create: { roleId: string }[] } } }) => {
        if (users.some((u) => (data.email && u.email === data.email) || (data.mobile && u.mobile === data.mobile))) {
          const { Prisma } = await import('@prisma/client');
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        const { roles: rc, ...rest } = data;
        const u = { id: randomUUID(), isActive: true, isSuperAdmin: false, passwordHash: null, lastLoginAt: null, ...rest };
        users.push(u);
        for (const c of rc.create) userRoles.push({ userId: u.id, roleId: c.roleId });
        return u;
      },
      update: async ({ where, data }: { where: { id: string }; data: Obj & { roles?: { create: { roleId: string }[] } } }) => {
        const u = users.find((x) => x.id === where.id)!;
        const { roles: rc, ...rest } = data;
        Object.assign(u, rest);
        for (const c of rc?.create ?? []) userRoles.push({ userId: u.id, roleId: c.roleId });
        return u;
      },
    },
    userRole: {
      deleteMany: async ({ where }: { where: Obj }) => {
        const hit = userRoles.filter((ur) => matches(ur, where));
        for (const h of hit) userRoles.splice(userRoles.indexOf(h), 1);
        return { count: hit.length };
      },
    },
    session: { updateMany: async () => ({ count: 0 }) },
  };
  prisma.$transaction = async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
  const audits: Obj[] = [];
  const row = (actor: { companyId: unknown; userId: unknown; ip: unknown }, e: Obj) => {
    const hasDiff = e.before !== undefined || e.after !== undefined;
    auditRows.push({ id: randomUUID(), companyId: actor.companyId, userId: actor.userId, ip: actor.ip, action: e.action, entity: e.entity, entityId: e.entityId ?? null, changes: hasDiff ? diffSnapshots((e.before ?? null) as Obj | null, (e.after ?? null) as Obj | null) : (e.details ?? null), createdAt: new Date() });
  };
  const auditSvc = {
    record: async (c: AuthContext, e: Obj) => {
      audits.push({ ...e, companyId: c.companyId });
      row(c, e);
    },
    recordSystem: async (actor: { companyId: unknown; userId: unknown; ip: unknown }, e: Obj) => {
      audits.push({ ...e, companyId: actor.companyId, system: true });
      row(actor, e);
    },
    toDtos: async (rows: Obj[]) => rows.map((r) => ({ ...r, userName: r.userId ? 'Name of ' + String(r.userId) : null, createdAt: (r.createdAt as Date).toISOString() })),
  };
  const geocoding = { enabled: true, search: async (q: string) => (q.includes('Unknown') ? [] : [{ label: 'Found', lat: 13.1, lng: 80.3, confidence: 0.6, matchType: 'street' }]) };
  const noticeSvc = new ConsentNoticeService(prisma as never, auditSvc as never);
  const svc = new PeopleService(prisma as never, auditSvc as never, { invalidateCache: async () => undefined } as never, geocoding as never, noticeSvc);
  /** Publish the next notice version of a purpose for company A (effective now). */
  const publish = (purpose: 'TRANSPORT_PROFILE' | 'NOTIFICATIONS_SMS' | 'SOS_LOCATION' | 'PICKUP_LOCATION_SHARE' = 'TRANSPORT_PROFILE') =>
    noticeSvc.publish(ctx(A), { purpose, title: 'Transport profile', body: 'We use your home location to plan your pickup.' });
  return { svc, noticeSvc, publish, profiles, consents, users, roles, userRoles, audits, auditRows, notices, add };
}

const agreement = (grants: TransportAgreementScope['grants'], over: Partial<TransportAgreementScope> = {}): TransportAgreementScope => ({
  id: 'agr-1',
  customerCompanyId: A,
  grants,
  siteIds: [],
  dataProfile: 'MINIMAL',
  validFrom: 0,
  validTo: null,
  ...over,
});

function ctx(companyId: string, over: Partial<AuthContext> = {}): AuthContext {
  return { userId: `user-${companyId}`, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: '10.0.0.1', agreements: [], ...over } as AuthContext;
}

const adminA = ctx(A);
const adminB = ctx(B);
const dispatcherA = ctx(A, { userId: 'disp', dataScope: 'ASSIGNED', branchIds: ['b1'] });
const list = async (svc: PeopleService, c: AuthContext, q: Obj = {}) => (await svc.list(c, q as never)) as unknown as { items: PassengerDto[]; total: number };
const code = (e: unknown) => (e as { getResponse(): { code?: string } }).getResponse().code;

describe('passengers: company isolation (doc 05 §6, 11 §3.2)', () => {
  it('the customer admin sees its own passengers; list rows mask contacts and hide the address', async () => {
    const w = world();
    const p = w.add({});
    w.add({ companyId: B, officePoiId: 'site-b' });
    const res = await list(w.svc, adminA);
    expect(res.items.map((i) => i.id)).toEqual([p.id]);
    expect(res.items[0]).toMatchObject({ projection: 'FULL', mobile: '+91•••••43210', email: 'p•••@corp.test', home: { address: null, lat: 13.060412 } });
    expect(w.audits).toEqual([]); // a JSON list is not a sensitive read
  });

  it('another company gets 404 on get / update / consents / app access, and an empty list', async () => {
    const w = world();
    const p = w.add({});
    expect((await list(w.svc, adminB)).items).toEqual([]);
    await expect(w.svc.get(adminB, p.id as string)).rejects.toThrow(NotFoundException);
    await expect(w.svc.update(adminB, p.id as string, { displayName: 'X' })).rejects.toThrow(NotFoundException);
    await expect(w.svc.consents(adminB, p.id as string)).rejects.toThrow(NotFoundException);
    await expect(w.svc.grantAppAccess(adminB, p.id as string, {})).rejects.toThrow(NotFoundException);
    await expect(w.svc.recordConsentOnBehalf(adminB, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v1' })).rejects.toThrow(NotFoundException);
  });

  it('detail reveals contacts, address and emergency contacts to the admin and writes an ACCESS audit', async () => {
    const w = world();
    const p = w.add({});
    const dto = await w.svc.get(adminA, p.id as string, { reason: 'support ticket 7' });
    expect(dto).toMatchObject({ projection: 'FULL', mobile: '+919876543210', home: { address: '12 Anna Salai, Chennai' }, emergencyContacts: [{ name: 'Ravi', phone: '+919800000001' }] });
    expect(w.audits).toEqual([expect.objectContaining({ action: 'ACCESS', entityId: p.id, companyId: A, details: expect.objectContaining({ what: 'detail', projection: 'FULL', reason: 'support ticket 7' }) })]);
  });
});

describe('passengers: provider access under an agreement (D1, doc 10 §2 minimum data profile)', () => {
  it('a provider without an agreement, or whose agreement lacks VIEW_PASSENGER_MINIMAL, gets nothing', async () => {
    const w = world();
    const p = w.add({});
    for (const c of [ctx(PROV), ctx(PROV, { agreements: [agreement(['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_CONTACT'])] })]) {
      expect((await list(w.svc, c)).items).toEqual([]);
      await expect(w.svc.get(c, p.id as string)).rejects.toThrow(NotFoundException);
    }
  });

  it('an expired agreement grants nothing', async () => {
    const w = world();
    const p = w.add({});
    const c = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'], { validTo: Date.now() - 1000 })] });
    await expect(w.svc.get(c, p.id as string)).rejects.toThrow(NotFoundException);
  });

  it('with the grant: MINIMAL only (short name, office, pickup point; no address, contacts, health, login or consents)', async () => {
    const w = world();
    const p = w.add({});
    w.add({ isActive: false });
    const c = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'])] });
    const res = await list(w.svc, c);
    expect(res.items).toHaveLength(1); // archived passengers are not shared
    const dto = await w.svc.get(c, p.id as string);
    expect(dto).toMatchObject({
      projection: 'MINIMAL',
      displayName: 'Asha K.',
      employeeCode: 'E1',
      office: { id: SITE1, name: 'HQ' },
      mobile: null,
      email: null,
      home: null,
      accessibility: null,
      accessibilityNeeds: true,
      emergencyContacts: null,
      appAccess: null,
      consents: null,
      branchId: null,
      createdAt: null,
      pickup: null, // no routing consent yet
      defaultStop: null,
      routingConsent: false,
    });
    expect(JSON.stringify(dto)).not.toContain('Anna Salai');
    // The read is logged in the CUSTOMER's audit log (data owner), with the agreement.
    expect(w.audits).toEqual([expect.objectContaining({ action: 'ACCESS', companyId: A, system: true, details: expect.objectContaining({ projection: 'MINIMAL', agreementId: 'agr-1', actingCompanyId: PROV }) })]);
  });

  it('pickup point only after the passenger consented; home rounded to 4 decimals, never the address', async () => {
    const w = world();
    const p = w.add({});
    await w.publish();
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v1' });
    const c = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'])] });
    expect((await w.svc.get(c, p.id as string)).pickup).toEqual({ kind: 'HOME', lat: 13.0604, lng: 80.2497, label: null, poiId: null });
    w.profiles[0].defaultStopPoiId = 'stop-1';
    expect((await w.svc.get(c, p.id as string)).pickup).toEqual({ kind: 'STOP', lat: 12.98, lng: 80.22, label: 'Stop Velachery', poiId: 'stop-1' });
  });

  it('contacts: masked with VIEW_PASSENGER_CONTACT, in clear only with the STANDARD data profile', async () => {
    const w = world();
    const p = w.add({});
    const masked = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL', 'VIEW_PASSENGER_CONTACT'])] });
    expect(await w.svc.get(masked, p.id as string)).toMatchObject({ mobile: '+91•••••43210', email: 'p•••@corp.test', home: null });
    const clear = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL', 'VIEW_PASSENGER_CONTACT'], { dataProfile: 'STANDARD' })] });
    expect(await w.svc.get(clear, p.id as string)).toMatchObject({ mobile: '+919876543210', home: null });
  });

  it('a site-limited agreement shows only passengers of those sites', async () => {
    const w = world();
    const p1 = w.add({ officePoiId: SITE1 });
    const p2 = w.add({ officePoiId: SITE2 });
    const c = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'], { siteIds: [SITE1] })] });
    expect((await list(w.svc, c)).items.map((i) => i.id)).toEqual([p1.id]);
    await expect(w.svc.get(c, p2.id as string)).rejects.toThrow(NotFoundException);
  });

  it('providers never change passengers or see consents (403 on a visible row)', async () => {
    const w = world();
    const p = w.add({});
    const c = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'])] });
    await expect(w.svc.update(c, p.id as string, { displayName: 'X' })).rejects.toThrow(ForbiddenException);
    await expect(w.svc.consents(c, p.id as string)).rejects.toThrow(ForbiddenException);
    await expect(w.svc.grantAppAccess(c, p.id as string, {})).rejects.toThrow(ForbiddenException);
  });

  it('contact search never matches other companies’ passengers', async () => {
    const w = world();
    w.add({ email: 'secret@corp.test' });
    const c = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'])] });
    expect((await list(w.svc, c, { q: 'secret' })).items).toEqual([]);
    expect((await list(w.svc, adminA, { q: 'secret' })).items).toHaveLength(1);
  });
});

describe('passengers: dispatcher (STANDARD, branch scope)', () => {
  it('sees own branches and company-wide passengers, address masked and point rounded', async () => {
    const w = world();
    const north = w.add({ branchId: 'b1' });
    const all = w.add({ branchId: null });
    const south = w.add({ branchId: 'b2' });
    expect((await list(w.svc, dispatcherA)).items.map((i) => i.id).sort()).toEqual([north.id, all.id].sort());
    await expect(w.svc.get(dispatcherA, south.id as string)).rejects.toThrow(NotFoundException);
    const dto = await w.svc.get(dispatcherA, north.id as string);
    expect(dto).toMatchObject({ projection: 'STANDARD', mobile: '+919876543210', home: { address: null, lat: 13.0604, lng: 80.2497 }, emergencyContacts: null });
  });

  it('may edit allowed fields but not the home location, emergency contacts or consents', async () => {
    const w = world();
    const p = w.add({ branchId: 'b1' });
    await expect(w.svc.update(dispatcherA, p.id as string, { home: { lat: 13.1, lng: 80.1 } })).rejects.toThrow(ForbiddenException);
    await expect(w.svc.update(dispatcherA, p.id as string, { emergencyContacts: [] })).rejects.toThrow(ForbiddenException);
    await expect(w.svc.recordConsentOnBehalf(dispatcherA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v1' })).rejects.toThrow(ForbiddenException);
    await expect(w.svc.update(dispatcherA, p.id as string, { branchId: 'b2' })).rejects.toThrow(ForbiddenException);
    expect((await w.svc.update(dispatcherA, p.id as string, { displayName: 'Asha K Iyer' })).displayName).toBe('Asha K Iyer');
  });
});

describe('passengers: create / update validation', () => {
  it('normalises contacts, validates references and the home point, refuses duplicates', async () => {
    const w = world();
    const dto = await w.svc.create(adminA, { employeeCode: ' E100 ', displayName: 'Mala  R', mobile: '98765 00100', email: 'MALA@corp.test', officePoiId: SITE1, home: { lat: 13.0812345, lng: 80.2712345, source: 'PIN' } });
    expect(dto).toMatchObject({ employeeCode: 'E100', displayName: 'Mala R', mobile: '+919876500100', email: 'mala@corp.test', home: { lat: 13.081235, lng: 80.271235, source: 'PIN' } });
    await expect(w.svc.create(adminA, { employeeCode: 'E100', displayName: 'Other' })).rejects.toMatchObject({ response: { code: 'PASSENGER_DUPLICATE' } });
    await expect(w.svc.create(adminA, { employeeCode: 'E101', displayName: 'Other', email: 'mala@corp.test' })).rejects.toThrow(ConflictException);
    await expect(w.svc.create(adminA, { employeeCode: 'E102', displayName: 'X', mobile: '123' })).rejects.toThrow(BadRequestException);
    await expect(w.svc.create(adminA, { employeeCode: 'E103', displayName: 'X', home: { lat: 0, lng: 0 } })).rejects.toThrow(BadRequestException);
    await expect(w.svc.create(adminA, { employeeCode: 'E104', displayName: 'X', home: { lat: 13 } })).rejects.toThrow(BadRequestException);
    await expect(w.svc.create(adminA, { employeeCode: 'E105', displayName: 'X', officePoiId: 'site-b' })).rejects.toThrow(BadRequestException);
    expect(w.audits.filter((a) => a.action === 'CREATE' && a.entity === 'EmployeeTransportProfile')).toHaveLength(1);
  });

  it('audit snapshots never contain the home address, coordinates or health data', async () => {
    const w = world();
    await w.svc.create(adminA, { employeeCode: 'E9', displayName: 'Z', home: { address: '5 Secret Lane', lat: 13.2, lng: 80.2 }, accessibility: { notes: 'diabetic' } });
    const text = JSON.stringify(w.audits);
    expect(text).not.toContain('Secret Lane');
    expect(text).not.toContain('diabetic');
    expect(text).not.toContain('13.2');
  });

  it('server geocoding uses the Photon search; no result keeps the address and lands in "Needs location"', async () => {
    const w = world();
    const found = await w.svc.create(adminA, { employeeCode: 'G1', displayName: 'G', home: { address: '1 Known Road', geocode: true } });
    expect(found.home).toMatchObject({ lat: 13.1, lng: 80.3, source: 'PHOTON', confidence: 0.6 }); // Photon match type → confidence
    const none = await w.svc.create(adminA, { employeeCode: 'G2', displayName: 'G', home: { address: 'Unknown place', geocode: true } });
    expect(none).toMatchObject({ hasHomeLocation: false, needsLocation: true, home: { lat: null, source: null } });
    expect((await list(w.svc, adminA, { needsLocation: 'true' })).items.map((i) => i.employeeCode)).toEqual(['G2']);
  });

  it('archive keeps the row (isActive false) and disables the passenger login', async () => {
    const w = world();
    const p = w.add({ email: 'asha@corp.test' });
    await w.svc.grantAppAccess(adminA, p.id as string, {});
    const dto = await w.svc.archive(adminA, p.id as string);
    expect(dto.isActive).toBe(false);
    expect(w.users[0].isActive).toBe(false);
    expect(w.profiles).toHaveLength(1);
  });
});

describe('consent (doc 10 §4.2): explicit, append-only, revocable, against the current notice', () => {
  it('grant, idempotent repeat, re-grant on a new notice version, revoke; history kept', async () => {
    const w = world();
    const p = w.add({});
    await w.publish();
    const grant = { purpose: 'TRANSPORT_PROFILE' as const, granted: true };
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, noticeVersion: 'v1' });
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, grant);
    expect(w.consents).toHaveLength(1);
    await w.publish();
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, noticeVersion: 'v2' });
    const revoked = await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, granted: false });
    expect(revoked.current).toEqual([expect.objectContaining({ purpose: 'TRANSPORT_PROFILE', active: false })]);
    expect(revoked.history.map((h) => [h.granted, h.noticeVersion, h.channel])).toEqual([
      [false, 'v2', 'ADMIN_ON_BEHALF'],
      [true, 'v2', 'ADMIN_ON_BEHALF'],
      [true, 'v1', 'ADMIN_ON_BEHALF'],
    ]);
    expect(w.consents[0]).toMatchObject({ actorUserId: adminA.userId, companyId: A, profileId: p.id });
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, granted: false });
    expect(w.consents).toHaveLength(3); // withdrawing a withdrawn consent writes nothing
  });

  it('no notice → 409 CONSENT_NOTICE_MISSING; a stale version → 409 CONSENT_NOTICE_OUTDATED; the version is never taken from the client', async () => {
    const w = world();
    const p = w.add({});
    await expect(w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true })).rejects.toMatchObject({ response: { code: 'CONSENT_NOTICE_MISSING' } });
    await w.publish();
    await w.publish();
    await expect(w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v1' })).rejects.toMatchObject({
      response: { code: 'CONSENT_NOTICE_OUTDATED', currentVersion: 'v2' },
    });
    await expect(w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'made-up' })).rejects.toMatchObject({ response: { code: 'CONSENT_NOTICE_OUTDATED' } });
    // The notice of one purpose does not cover another.
    await expect(w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'SOS_LOCATION', granted: true })).rejects.toMatchObject({ response: { code: 'CONSENT_NOTICE_MISSING' } });
    const res = await w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true });
    expect(res.current[0]).toMatchObject({ active: true, noticeVersion: 'v2' });
    expect(w.consents).toHaveLength(1);
  });

  it('a notice scheduled for later is not current yet; another company’s notice never applies', async () => {
    const w = world();
    const p = w.add({});
    await w.noticeSvc.publish(ctx(B), { purpose: 'TRANSPORT_PROFILE', title: 'B', body: 'Company B text' });
    await expect(w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true })).rejects.toMatchObject({ response: { code: 'CONSENT_NOTICE_MISSING' } });
    await w.noticeSvc.publish(adminA, { purpose: 'TRANSPORT_PROFILE', title: 'Later', body: 'Next week', effectiveFrom: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    await expect(w.svc.recordConsentOnBehalf(adminA, p.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true })).rejects.toMatchObject({ response: { code: 'CONSENT_NOTICE_MISSING' } });
    const listed = await w.noticeSvc.list(adminA);
    expect(listed.current.find((c) => c.purpose === 'TRANSPORT_PROFILE')).toMatchObject({ notice: null, scheduled: expect.objectContaining({ version: 'v1', title: 'Later' }) });
  });

  it('no location is used for routing without an active consent', async () => {
    const w = world();
    const p1 = w.add({});
    const p2 = w.add({ email: 'b@corp.test' });
    await w.publish('TRANSPORT_PROFILE');
    await w.publish('NOTIFICATIONS_SMS');
    await w.svc.recordConsentOnBehalf(adminA, p1.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true });
    await w.svc.recordConsentOnBehalf(adminA, p2.id as string, { purpose: 'NOTIFICATIONS_SMS', granted: true });
    const pickups = await w.svc.routingPickups(A, [p1.id as string, p2.id as string]);
    expect([...pickups.keys()]).toEqual([p1.id]);
    expect(pickups.get(p1.id as string)).toEqual({ kind: 'HOME', lat: 13.060412, lng: 80.249679, label: null, poiId: null });
    expect((await list(w.svc, adminA, { routingConsent: 'false' })).items.map((i) => i.id)).toEqual([p2.id]);
    await w.svc.recordConsentOnBehalf(adminA, p1.id as string, { purpose: 'TRANSPORT_PROFILE', granted: false });
    expect((await w.svc.routingPickups(A, [p1.id as string])).size).toBe(0);
    expect((await w.svc.routingPickups(B, [p1.id as string])).size).toBe(0); // another company's id
  });

  it('the passenger reads the current notices and records its own consent (channel WEB); non-passengers get 403 NOT_A_PASSENGER', async () => {
    const w = world();
    const p = w.add({ email: 'asha@corp.test' });
    await w.svc.grantAppAccess(adminA, p.id as string, {});
    await w.publish();
    await w.publish();
    await w.publish();
    const me = ctx(A, { userId: w.users[0].id as string, dataScope: 'ASSIGNED' });
    const notices = await w.svc.myNotices(me);
    expect(notices.find((n) => n.purpose === 'TRANSPORT_PROFILE')?.notice).toMatchObject({ version: 'v3', body: 'We use your home location to plan your pickup.' });
    expect(notices.find((n) => n.purpose === 'SOS_LOCATION')?.notice).toBeNull();
    const res = await w.svc.recordMyConsent(me, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v3' });
    expect(res.current[0]).toMatchObject({ active: true, channel: 'WEB', noticeVersion: 'v3' });
    expect(w.consents[0]).toMatchObject({ subjectUserId: w.users[0].id, actorUserId: w.users[0].id });
    await expect(w.svc.myConsents(ctx(A, { userId: 'stranger' }))).rejects.toMatchObject({ response: { code: 'NOT_A_PASSENGER' } });
    await expect(w.svc.myNotices(ctx(A, { userId: 'stranger' }))).rejects.toMatchObject({ response: { code: 'NOT_A_PASSENGER' } });
  });
});

describe('consent notice (doc 10 §4.2): company-level, versioned, immutable', () => {
  it('publishing assigns v1, v2… per purpose, keeps every version and audits the change', async () => {
    const w = world();
    const n1 = await w.noticeSvc.publish(adminA, { purpose: 'TRANSPORT_PROFILE', title: '  Your  transport ', body: 'Line one   \r\n\r\n\r\n\r\nLine two  ' });
    expect(n1).toMatchObject({ version: 'v1', title: 'Your transport', body: 'Line one\n\nLine two', locale: 'en' });
    const n2 = await w.noticeSvc.publish(adminA, { purpose: 'TRANSPORT_PROFILE', title: 'Second', body: 'Text 2' });
    const s1 = await w.noticeSvc.publish(adminA, { purpose: 'SOS_LOCATION', title: 'SOS', body: 'SOS text' });
    expect([n2.version, s1.version]).toEqual(['v2', 'v1']);
    const listed = await w.noticeSvc.list(adminA);
    expect(listed.current.find((c) => c.purpose === 'TRANSPORT_PROFILE')?.notice?.version).toBe('v2');
    expect(listed.history).toHaveLength(3);
    expect(w.notices.find((n) => n.version === 'v1' && n.purpose === 'TRANSPORT_PROFILE')).toMatchObject({ title: 'Your transport' }); // never rewritten
    expect(w.audits.filter((a) => a.entity === 'TransportConsentNotice')).toHaveLength(3);
    expect((await w.noticeSvc.list(adminB)).history).toHaveLength(0); // company isolation
  });

  it('only whole-company roles publish; no past effective date; blank text refused', async () => {
    const w = world();
    await expect(w.noticeSvc.publish(dispatcherA, { purpose: 'TRANSPORT_PROFILE', title: 'x', body: 'y' })).rejects.toMatchObject({ response: { code: 'FORBIDDEN_GRANT' } });
    await expect(w.noticeSvc.publish(adminA, { purpose: 'TRANSPORT_PROFILE', title: 'x', body: 'y', effectiveFrom: '2020-01-01T00:00:00Z' })).rejects.toThrow(BadRequestException);
    await expect(w.noticeSvc.publish(adminA, { purpose: 'TRANSPORT_PROFILE', title: 'x', body: '   \n  ' })).rejects.toThrow(BadRequestException);
    expect(w.notices).toHaveLength(0);
  });
});

describe('passenger app access (D5, P3 one login per person)', () => {
  it('creates a User with the Passenger role template', async () => {
    const w = world();
    const p = w.add({ email: 'asha@corp.test', mobile: '+919876500001' });
    const res = await w.svc.grantAppAccess(adminA, p.id as string, { password: 'secret123' });
    expect(res.outcome).toBe('CREATED');
    expect(res.invite).toEqual({ channel: 'MANUAL', passwordSet: true });
    expect(w.users[0]).toMatchObject({ companyId: A, email: 'asha@corp.test', mobile: '+919876500001' });
    const role = w.roles.find((r) => r.id === w.userRoles[0].roleId);
    expect(role?.name).toBe('Transport passenger');
    expect(res.passenger.appAccess).toMatchObject({ active: true, otherRoles: false });
  });

  it('IDENTITY_IN_USE when the email or mobile belongs to a User of another company (or two different Users)', async () => {
    const w = world();
    w.users.push({ id: 'u-b', companyId: B, email: 'asha@corp.test', mobile: null, isActive: true, isSuperAdmin: false });
    const p = w.add({ email: 'asha@corp.test' });
    await expect(w.svc.grantAppAccess(adminA, p.id as string, {})).rejects.toMatchObject({ response: { code: 'IDENTITY_IN_USE' } });
    w.users.push({ id: 'u-a', companyId: A, email: null, mobile: '+919876500009', isActive: true, isSuperAdmin: false });
    w.users[0].companyId = A;
    try {
      await w.svc.grantAppAccess(adminA, p.id as string, { mobile: '+919876500009' });
      throw new Error('expected IDENTITY_IN_USE');
    } catch (e) {
      expect(code(e)).toBe('IDENTITY_IN_USE');
    }
    expect(w.profiles[0].userId).toBeNull();
  });

  it('links an existing fleet User of the same company (dual role) and keeps its fleet login on revoke', async () => {
    const w = world();
    w.roles.push({ id: 'r-fleet', companyId: A, name: 'Manager' });
    w.users.push({ id: 'u-fleet', companyId: A, email: 'asha@corp.test', mobile: null, isActive: true, isSuperAdmin: false, passwordHash: 'x' });
    w.userRoles.push({ userId: 'u-fleet', roleId: 'r-fleet' });
    const p = w.add({ email: 'asha@corp.test' });
    const res = await w.svc.grantAppAccess(adminA, p.id as string, {});
    expect(res.outcome).toBe('LINKED');
    expect(res.passenger.appAccess).toMatchObject({ userId: 'u-fleet', active: true, otherRoles: true });
    const after = await w.svc.revokeAppAccess(adminA, p.id as string);
    expect(after.appAccess).toMatchObject({ active: false, otherRoles: true });
    expect(w.users[0].isActive).toBe(true);
    expect(w.userRoles).toEqual([{ userId: 'u-fleet', roleId: 'r-fleet' }]);
  });

  it('a User already linked to another passenger cannot be linked again', async () => {
    const w = world();
    const p1 = w.add({ email: 'shared@corp.test' });
    await w.svc.grantAppAccess(adminA, p1.id as string, {});
    const p2 = w.add({ email: 'other@corp.test' });
    await expect(w.svc.grantAppAccess(adminA, p2.id as string, { email: 'shared@corp.test' })).rejects.toMatchObject({ response: { code: 'IDENTITY_IN_USE' } });
  });
});

describe('passenger history (audit log, redacted per view level)', () => {
  /** A passenger created and changed by the admin, with consent, a login and a provider read. */
  async function seeded() {
    const w = world();
    const created = await w.svc.create(adminA, {
      employeeCode: 'H1',
      displayName: 'Asha Krishnan',
      mobile: '9876500011',
      email: 'asha.h@corp.test',
      officePoiId: SITE1,
      home: { address: '5 Secret Lane', lat: 13.2, lng: 80.2 },
      accessibility: { notes: 'diabetic' },
      emergencyContacts: [{ name: 'Ravi', phone: '9800000002' }],
    });
    await w.svc.update(adminA, created.id, { home: { address: '7 Hidden Road', lat: 13.3, lng: 80.3 }, mobile: '9876500012', defaultStopPoiId: 'stop-1' });
    await w.publish();
    await w.svc.recordConsentOnBehalf(adminA, created.id, { purpose: 'TRANSPORT_PROFILE', granted: true });
    await w.svc.grantAppAccess(adminA, created.id, {});
    const prov = ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL'])] });
    await w.svc.get(prov, created.id);
    return { w, id: created.id, prov };
  }
  const text = (x: unknown) => JSON.stringify(x);

  it('admin (FULL): profile, consent, login and read events; home / health / emergency values only as "changed"', async () => {
    const { w, id } = await seeded();
    const h = await w.svc.history(adminA, id);
    const entities = h.map((e) => `${e.entity}:${e.action}`);
    expect(entities).toEqual(expect.arrayContaining(['EmployeeTransportProfile:CREATE', 'EmployeeTransportProfile:UPDATE', 'EmployeeTransportConsent:CREATE', 'User:CREATE', 'EmployeeTransportProfile:ACCESS']));
    const update = h.find((e) => e.entity === 'EmployeeTransportProfile' && e.action === 'UPDATE' && text(e.changes).includes('mobile'))!;
    expect(update.changes).toMatchObject({ before: { mobile: '+919876500011', homeAddress: 'changed', homeLat: 'changed' }, after: { mobile: '+919876500012', homeAddress: 'changed', defaultStopPoiId: 'stop-1' } });
    expect(update).toMatchObject({ userId: adminA.userId, ip: '10.0.0.1' });
    const all = text(h);
    for (const secret of ['Secret Lane', 'Hidden Road', 'diabetic', '13.2', '13.3', '+919800000002', 'changed:']) expect(all).not.toContain(secret);
    // The history read itself is audited.
    expect(w.audits.at(-1)).toMatchObject({ action: 'ACCESS', entityId: id, details: expect.objectContaining({ what: 'history', projection: 'FULL' }) });
  });

  it('dispatcher (STANDARD): no home-location or emergency-contact fields at all, no read events, no IP', async () => {
    const { w, id } = await seeded();
    const h = await w.svc.history(dispatcherA, id);
    expect(h.length).toBeGreaterThan(0);
    expect(h.some((e) => e.action === 'ACCESS')).toBe(false);
    const all = text(h);
    for (const key of ['homeAddress', 'homeLat', 'homeLng', 'homeGeocodeSource', 'emergencyContacts']) expect(all).not.toContain(key);
    expect(all).toContain('+919876500012'); // contacts are visible to the dispatcher in the detail view too
    expect(h.every((e) => e.ip === null)).toBe(true);
  });

  it('provider (MINIMAL): only its projection fields, no contacts without the grant, no actor; consent / login entries hidden', async () => {
    const { w, id, prov } = await seeded();
    const h = await w.svc.history(prov, id);
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((e) => e.entity === 'EmployeeTransportProfile' && e.userId === null && e.userName === null && e.ip === null)).toBe(true);
    const keys = new Set(h.flatMap((e) => Object.keys(((e.changes as { after?: object })?.after ?? {}) as object)));
    expect([...keys].every((k) => ['employeeCode', 'displayName', 'officePoiId', 'isActive', 'defaultStopPoiId'].includes(k))).toBe(true);
    const all = text(h);
    expect(all).not.toContain('98765');
    expect(all).not.toContain('Krishnan'); // short name only
    expect(all).toContain('Asha K.');
    // The read is logged under the customer company, as for detail reads.
    expect(w.audits.at(-1)).toMatchObject({ action: 'ACCESS', companyId: A, system: true, details: expect.objectContaining({ what: 'history', projection: 'MINIMAL' }) });
  });

  it('provider with VIEW_PASSENGER_CONTACT sees masked contacts; no grant or another company → 404', async () => {
    const { w, id } = await seeded();
    const masked = await w.svc.history(ctx(PROV, { agreements: [agreement(['VIEW_PASSENGER_MINIMAL', 'VIEW_PASSENGER_CONTACT'])] }), id);
    const all = text(masked);
    expect(all).toContain('+91•••••00012');
    expect(all).not.toContain('+919876500012');
    await expect(w.svc.history(ctx(PROV), id)).rejects.toThrow(NotFoundException);
    await expect(w.svc.history(ctx(PROV, { agreements: [agreement(['VIEW_BOOKINGS'])] }), id)).rejects.toThrow(NotFoundException);
    await expect(w.svc.history(adminB, id)).rejects.toThrow(NotFoundException);
  });
});

describe('passenger login removal: disable vs unlink (LoginRemovalMode)', () => {
  it('disable keeps the link (enable again restores it); unlink clears it so another login can be linked; the User is never deleted', async () => {
    const w = world();
    const p = w.add({ email: 'asha@corp.test' });
    await w.svc.grantAppAccess(adminA, p.id as string, {});
    const userId = w.users[0].id;
    const disabled = await w.svc.revokeAppAccess(adminA, p.id as string, 'disable');
    expect(disabled.appAccess).toMatchObject({ userId, active: false });
    expect(w.profiles[0].userId).toBe(userId);
    const again = await w.svc.grantAppAccess(adminA, p.id as string, {});
    expect(again.outcome).toBe('REACTIVATED');

    const unlinked = await w.svc.revokeAppAccess(adminA, p.id as string, 'unlink');
    expect(unlinked.appAccess).toBeNull();
    expect(w.profiles[0].userId).toBeNull();
    expect(w.users).toHaveLength(1);
    expect(w.users[0].isActive).toBe(false);
    expect(w.audits.filter((a) => (a.details as Obj | undefined)?.what === 'passenger-login-unlinked')).toHaveLength(1);
    expect(w.audits.some((a) => a.entity === 'EmployeeTransportProfile' && (a.after as Obj | undefined)?.userId === null)).toBe(true);

    // Linking the same contact again finds the old, disabled transport-only login and re-enables it.
    const relinked = await w.svc.grantAppAccess(adminA, p.id as string, {});
    expect(relinked.outcome).toBe('REACTIVATED');
    expect(w.users[0].isActive).toBe(true);
    await w.svc.revokeAppAccess(adminA, p.id as string, 'unlink');
    // A different contact creates a new login.
    const fresh = await w.svc.grantAppAccess(adminA, p.id as string, { email: 'asha.new@corp.test', mobile: null });
    expect(fresh.outcome).toBe('CREATED');
    expect(w.users).toHaveLength(2);
    await expect(w.svc.revokeAppAccess(dispatcherA, w.add({ companyId: B, email: 'x@b.test' }).id as string, 'unlink')).rejects.toThrow(NotFoundException);
  });
});
