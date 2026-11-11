import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PassengerDto } from '@veetracer/shared';
import type { AuthContext, TransportAgreementScope } from '../../access/auth-context';
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
  const auditSvc = {
    record: async (c: AuthContext, e: Obj) => audits.push({ ...e, companyId: c.companyId }),
    recordSystem: async (actor: Obj, e: Obj) => audits.push({ ...e, companyId: actor.companyId, system: true }),
  };
  const geocoding = { enabled: true, search: async (q: string) => (q.includes('Unknown') ? [] : [{ label: 'Found', lat: 13.1, lng: 80.3 }]) };
  const svc = new PeopleService(prisma as never, auditSvc as never, { invalidateCache: async () => undefined } as never, geocoding as never);
  return { svc, profiles, consents, users, roles, userRoles, audits, add };
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
    expect(found.home).toMatchObject({ lat: 13.1, lng: 80.3, source: 'PHOTON' });
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

describe('consent (doc 10 §4.2): explicit, append-only, revocable', () => {
  it('grant, idempotent repeat, re-grant on a new notice version, revoke; history kept', async () => {
    const w = world();
    const p = w.add({});
    const grant = { purpose: 'TRANSPORT_PROFILE' as const, granted: true, noticeVersion: 'v1' };
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, grant);
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, grant);
    expect(w.consents).toHaveLength(1);
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, noticeVersion: 'v2' });
    const revoked = await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, granted: false });
    expect(revoked.current).toEqual([expect.objectContaining({ purpose: 'TRANSPORT_PROFILE', active: false })]);
    expect(revoked.history.map((h) => [h.granted, h.noticeVersion, h.channel])).toEqual([
      [false, 'v1', 'ADMIN_ON_BEHALF'],
      [true, 'v2', 'ADMIN_ON_BEHALF'],
      [true, 'v1', 'ADMIN_ON_BEHALF'],
    ]);
    expect(w.consents[0]).toMatchObject({ actorUserId: adminA.userId, companyId: A, profileId: p.id });
    await w.svc.recordConsentOnBehalf(adminA, p.id as string, { ...grant, granted: false });
    expect(w.consents).toHaveLength(3); // withdrawing a withdrawn consent writes nothing
  });

  it('no location is used for routing without an active consent', async () => {
    const w = world();
    const p1 = w.add({});
    const p2 = w.add({ email: 'b@corp.test' });
    await w.svc.recordConsentOnBehalf(adminA, p1.id as string, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v1' });
    await w.svc.recordConsentOnBehalf(adminA, p2.id as string, { purpose: 'NOTIFICATIONS_SMS', granted: true, noticeVersion: 'v1' });
    const pickups = await w.svc.routingPickups(A, [p1.id as string, p2.id as string]);
    expect([...pickups.keys()]).toEqual([p1.id]);
    expect(pickups.get(p1.id as string)).toEqual({ kind: 'HOME', lat: 13.060412, lng: 80.249679, label: null, poiId: null });
    expect((await list(w.svc, adminA, { routingConsent: 'false' })).items.map((i) => i.id)).toEqual([p2.id]);
    await w.svc.recordConsentOnBehalf(adminA, p1.id as string, { purpose: 'TRANSPORT_PROFILE', granted: false, noticeVersion: 'v1' });
    expect((await w.svc.routingPickups(A, [p1.id as string])).size).toBe(0);
    expect((await w.svc.routingPickups(B, [p1.id as string])).size).toBe(0); // another company's id
  });

  it('the passenger records its own consent (channel WEB); non-passengers get 403 NOT_A_PASSENGER', async () => {
    const w = world();
    const p = w.add({ email: 'asha@corp.test' });
    await w.svc.grantAppAccess(adminA, p.id as string, {});
    const me = ctx(A, { userId: w.users[0].id as string, dataScope: 'ASSIGNED' });
    const res = await w.svc.recordMyConsent(me, { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v3' });
    expect(res.current[0]).toMatchObject({ active: true, channel: 'WEB', noticeVersion: 'v3' });
    expect(w.consents[0]).toMatchObject({ subjectUserId: w.users[0].id, actorUserId: w.users[0].id });
    await expect(w.svc.myConsents(ctx(A, { userId: 'stranger' }))).rejects.toMatchObject({ response: { code: 'NOT_A_PASSENGER' } });
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
