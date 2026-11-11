import { NotFoundException } from '@nestjs/common';
import type { TransportVehicleRowDto } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import { FleetLinksService } from './fleet-links.service';

/**
 * GET /api/transport/vehicles (E2 gap 1): every own vehicle in the caller's scope with its seat profile or null, and
 * DELETE /api/drivers/:id/login?mode= (gap 5), against an in-memory store that evaluates the service's where-clauses.
 */
type Obj = Record<string, unknown>;

function matches(row: Obj, where: Obj | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return (cond as Obj[]).every((w) => matches(row, w));
    if (k === 'OR') return (cond as Obj[]).some((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, cond as Obj);
    const v = row[k];
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Obj;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('contains' in c) return typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase());
      if ('is' in c) return c.is === null ? v === null || v === undefined : true;
      if ('isNot' in c) return c.isNot === null ? v !== null && v !== undefined : true;
      return true;
    }
    return v === cond;
  });
}

const A = 'opA';
const B = 'opB';

function world() {
  const profile = (seats: number) => ({ seats, wheelchairSpaces: 1, hasAc: true, category: 'VAN', notes: null, createdAt: new Date(), updatedAt: new Date('2026-11-11T00:00:00Z') });
  const objects: Obj[] = [
    { id: 'v1', companyId: A, branchId: 'b1', type: 'VEHICLE', name: 'Van 1', plateNumber: 'TN01AB1234', isActive: true, transportProfile: { objectId: 'v1', companyId: A, ...profile(12) } },
    { id: 'v2', companyId: A, branchId: 'b2', type: 'VEHICLE', name: 'Bus 2', plateNumber: null, isActive: false, transportProfile: null },
    { id: 'v3', companyId: A, branchId: null, type: 'VEHICLE', name: 'Car 3', plateNumber: 'TN09', isActive: true, transportProfile: null },
    { id: 'p1', companyId: A, branchId: 'b1', type: 'PERSON', name: 'Guard', plateNumber: null, isActive: true, transportProfile: null },
    { id: 'vb', companyId: B, branchId: null, type: 'VEHICLE', name: 'Other company van', plateNumber: null, isActive: true, transportProfile: null },
  ];
  const drivers: Obj[] = [{ id: 'd1', companyId: A, name: 'Kumar', mobile: '+919800000009', isActive: true, userId: null, branchId: null }];
  const users: Obj[] = [];
  const roles: Obj[] = [];
  const userRoles: Obj[] = [];
  const userWithRoles = (u: Obj | undefined) => (u ? { ...u, roles: userRoles.filter((ur) => ur.userId === u.id).map((ur) => ({ ...ur, role: roles.find((r) => r.id === ur.roleId) })) } : null);
  const prisma: Obj = {
    trackedObject: {
      findMany: async ({ where, skip, take }: { where: Obj; skip: number; take: number }) =>
        objects
          .filter((o) => matches(o, where))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .slice(skip, skip + take),
      count: async ({ where }: { where: Obj }) => objects.filter((o) => matches(o, where)).length,
    },
    driver: {
      findFirst: async ({ where }: { where: Obj }) => drivers.find((d) => matches(d, where)) ?? null,
      count: async ({ where }: { where: Obj }) => drivers.filter((d) => matches(d, where)).length,
      update: async ({ where, data }: { where: { id: string }; data: Obj }) => Object.assign(drivers.find((d) => d.id === where.id)!, data),
    },
    company: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
    role: {
      findUnique: async ({ where }: { where: { companyId_name: { companyId: string; name: string } } }) => roles.find((r) => r.companyId === where.companyId_name.companyId && r.name === where.companyId_name.name) ?? null,
      create: async ({ data }: { data: Obj }) => {
        const r = { id: `role-${roles.length + 1}`, companyId: data.companyId, name: data.name };
        roles.push(r);
        return r;
      },
    },
    user: {
      findMany: async ({ where }: { where: Obj }) => users.filter((u) => matches(u, where)).map(userWithRoles),
      findUnique: async ({ where }: { where: { id: string } }) => userWithRoles(users.find((u) => u.id === where.id)),
      create: async ({ data }: { data: Obj & { roles: { create: { roleId: string }[] } } }) => {
        const { roles: rc, ...rest } = data;
        const u = { id: `user-${users.length + 1}`, isActive: true, isSuperAdmin: false, passwordHash: null, ...rest };
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
    userRole: { deleteMany: async () => ({ count: 0 }) },
    session: { updateMany: async () => ({ count: 0 }) },
    rolePermission: { createMany: async () => ({ count: 0 }), findMany: async () => [] },
  };
  prisma.$transaction = async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
  const audits: Obj[] = [];
  const svc = new FleetLinksService(prisma as never, { record: async (_c: unknown, e: Obj) => audits.push(e) } as never, { invalidateCache: async () => undefined } as never);
  return { svc, drivers, users, audits };
}

function ctx(companyId: string, over: Partial<AuthContext> = {}): AuthContext {
  return { userId: `u-${companyId}`, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null, agreements: [], shares: [], ...over } as AuthContext;
}

const page = (r: unknown) => r as { items: TransportVehicleRowDto[]; total: number };

describe('GET /api/transport/vehicles: every own vehicle, seats null when unset', () => {
  it('lists all of the company’s vehicles (not persons, not other companies), profile null while seats were never set', async () => {
    const w = world();
    const res = page(await w.svc.listVehicles(ctx(A), {}));
    expect(res.total).toBe(3);
    expect(res.items.map((v) => [v.objectId, v.profile?.seats ?? null])).toEqual([
      ['v2', null],
      ['v3', null],
      ['v1', 12],
    ]);
    expect(res.items[2]).toMatchObject({ objectName: 'Van 1', plateNumber: 'TN01AB1234', isActive: true, branchId: 'b1', profile: { objectId: 'v1', objectName: 'Van 1', wheelchairSpaces: 1, category: 'VAN' } });
  });

  it('respects branch scope (own branches + assigned objects) and never shows shared vehicles', async () => {
    const w = world();
    const scoped = page(await w.svc.listVehicles(ctx(A, { dataScope: 'ASSIGNED', branchIds: ['b1'], objectIds: ['v3'], shares: [{ objectId: 'vb' }] as never }), {}));
    expect(scoped.items.map((v) => v.objectId).sort()).toEqual(['v1', 'v3']);
    expect(page(await w.svc.listVehicles(ctx(B), {})).items.map((v) => v.objectId)).toEqual(['vb']);
  });

  it('search, status, seats=set|unset and paging', async () => {
    const w = world();
    expect(page(await w.svc.listVehicles(ctx(A), { q: 'tn0' })).items.map((v) => v.objectId).sort()).toEqual(['v1', 'v3']);
    expect(page(await w.svc.listVehicles(ctx(A), { seats: 'unset' })).items.map((v) => v.objectId)).toEqual(['v2', 'v3']);
    expect(page(await w.svc.listVehicles(ctx(A), { seats: 'set' })).items.map((v) => v.objectId)).toEqual(['v1']);
    expect(page(await w.svc.listVehicles(ctx(A), { status: 'INACTIVE' })).items.map((v) => v.objectId)).toEqual(['v2']);
    const p2 = page(await w.svc.listVehicles(ctx(A), { page: 2, pageSize: 2 }));
    expect([p2.total, p2.items.map((v) => v.objectId)]).toEqual([3, ['v1']]);
  });
});

describe('DELETE /api/drivers/:id/login?mode=', () => {
  it('disable keeps Driver.userId; unlink clears it; another company’s driver is 404', async () => {
    const w = world();
    await w.svc.grantDriverLogin(ctx(A), 'd1', {});
    const userId = w.drivers[0].userId;
    expect(userId).toBeTruthy();
    const disabled = await w.svc.revokeDriverLogin(ctx(A), 'd1', 'disable');
    expect(disabled).toMatchObject({ userId, active: false });
    expect(w.drivers[0].userId).toBe(userId);
    const unlinked = await w.svc.revokeDriverLogin(ctx(A), 'd1', 'unlink');
    expect(unlinked).toMatchObject({ userId: null, active: false });
    expect(w.drivers[0].userId).toBeNull();
    expect(w.users).toHaveLength(1); // never deleted
    expect(w.audits.some((a) => (a.details as Obj | undefined)?.what === 'driver-login-unlinked')).toBe(true);
    await expect(w.svc.revokeDriverLogin(ctx(B), 'd1', 'unlink')).rejects.toThrow(NotFoundException);
  });
});
