import { ForbiddenException, NotFoundException, UseGuards, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ETMS_ROLE_TEMPLATES, moduleMenuKeys, type CompanyFeature, type PermissionMap } from '@veetracer/shared';
import { validateRolePermissions } from '../access/access-rules';
import { AuthContextService } from '../access/auth-context.service';
import type { AuthContext } from '../access/auth-context';
import type { Grant } from '../access/decorators';
import { PermissionGuard } from '../access/permission.guard';
import { ensureEtmsRoleTemplates } from './etms-role-templates';
import { TransportFeatureGuard } from './transport-feature.guard';

function httpCtx(auth: Partial<AuthContext> | undefined, method = 'GET'): ExecutionContext {
  const req = { auth, method, query: {}, url: '/api/transport/agreements' };
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
const guardFor = (grants: Grant[]) => new PermissionGuard({ getAllAndOverride: () => grants } as unknown as Reflector);
const caller = (permissions: PermissionMap, features: CompanyFeature[]): Partial<AuthContext> => ({ companyId: 'c1', permissions, features });
const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return ((e as { getResponse(): { code?: string } }).getResponse?.() ?? {}).code;
  }
  return 'no error';
};

describe('ETMS module gating (MenuDef.requires)', () => {
  const etmsRoute = guardFor([['etms_partners', 'view']]);

  it('ETMS menus are the module menus', () => {
    expect(moduleMenuKeys('etms')).toEqual(['etms_dashboard', 'etms_partners', 'etms_passengers', 'etms_schedules', 'etms_bookings', 'etms_dispatch', 'etms_planning', 'etms_settings', 'etms_self', 'etms_driver']);
  });

  it('company without the add-on: plain 404, even for a role that holds the menu', () => {
    expect(() => etmsRoute.canActivate(httpCtx(caller({ etms_partners: ['view'] }, [])))).toThrow(NotFoundException);
    expect(codeOf(() => etmsRoute.canActivate(httpCtx(caller({}, []))))).toBe('NOT_FOUND');
    expect(() => etmsRoute.canActivate(httpCtx({ companyId: 'c1', permissions: { etms_partners: ['view'] } }))).toThrow(NotFoundException);
  });

  it('company with the add-on but no grant: 403 FORBIDDEN_GRANT; with the grant: allowed', () => {
    expect(() => etmsRoute.canActivate(httpCtx(caller({}, ['etms'])))).toThrow(ForbiddenException);
    expect(codeOf(() => etmsRoute.canActivate(httpCtx(caller({}, ['etms']))))).toBe('FORBIDDEN_GRANT');
    expect(etmsRoute.canActivate(httpCtx(caller({ etms_partners: ['view'] }, ['etms'])))).toBe(true);
  });

  it('existing GPS routes behave exactly as before, with or without the add-on', () => {
    const gps = guardFor([['live_map', 'view']]);
    expect(gps.canActivate(httpCtx(caller({ live_map: ['view'] }, [])))).toBe(true);
    expect(gps.canActivate(httpCtx(caller({ live_map: ['view'] }, ['etms'])))).toBe(true);
    expect(() => gps.canActivate(httpCtx(caller({}, ['etms'])))).toThrow('Permission denied');
    expect(codeOf(() => gps.canActivate(httpCtx(caller({}, []))))).toBeUndefined();
  });

  it('a feature-gated ETMS controller guarded by a fleet menu (vehicles, driver login): 404 without the add-on, even with no grant', () => {
    @UseGuards(TransportFeatureGuard)
    class GatedController {}
    const fleetRoute = guardFor([['objects', 'edit']]);
    const on = (auth: Partial<AuthContext>) => ({ ...httpCtx(auth, 'PUT'), getClass: () => GatedController }) as unknown as ExecutionContext;
    expect(codeOf(() => fleetRoute.canActivate(on(caller({}, []))))).toBe('NOT_FOUND');
    expect(codeOf(() => fleetRoute.canActivate(on(caller({ objects: ['edit'] }, []))))).toBe('NOT_FOUND');
    expect(() => fleetRoute.canActivate(on(caller({}, ['etms'])))).toThrow('Permission denied');
    expect(fleetRoute.canActivate(on(caller({ objects: ['edit'] }, ['etms'])))).toBe(true);
  });

  describe('TransportFeatureGuard', () => {
    const guard = new TransportFeatureGuard();
    afterEach(() => delete process.env.ETMS);

    it('404 without the add-on, passes with it', () => {
      expect(() => guard.canActivate(httpCtx(caller({}, [])))).toThrow(NotFoundException);
      expect(guard.canActivate(httpCtx(caller({}, ['etms'])))).toBe(true);
    });

    it('ETMS=off on the server hides every ETMS route', () => {
      process.env.ETMS = 'off';
      expect(() => guard.canActivate(httpCtx(caller({}, ['etms'])))).toThrow(NotFoundException);
    });
  });
});

describe('AuthContextService: features, module menus and ctx.agreements', () => {
  const role = { dataScope: 'COMPANY', permissions: [{ menu: 'etms_partners', actions: ['view'] }, { menu: 'live_map', actions: ['view'] }] };
  const customerOn = { status: 'ACTIVE', isPlatform: false, settings: { features: ['etms'] } };
  const agreementRow = { id: 'a1', customerCompanyId: 'cust', grants: ['VIEW_BOOKINGS'], siteIds: [], dataProfile: 'MINIMAL', validFrom: new Date(1000), validTo: null, customer: customerOn };

  function service(settings: unknown, opts: { superAdmin?: boolean; selected?: unknown; customer?: unknown; roles?: unknown[] } = {}) {
    const findMany = jest.fn(async () => [{ ...agreementRow, customer: opts.customer ?? customerOn }]);
    const prisma = {
      user: {
        findUnique: async () => ({
          id: 'u1',
          companyId: 'prov',
          isActive: true,
          isSuperAdmin: !!opts.superAdmin,
          company: { status: 'ACTIVE', settings, isPlatform: false },
          roles: opts.roles ?? [{ role }],
          branches: [],
          objects: [],
        }),
      },
      company: { findUnique: async () => opts.selected ?? null },
      vehicleShare: { findMany: async () => [] },
      transportServiceAgreement: { findMany },
    };
    return { svc: new AuthContextService(prisma as never, null as never, null as never), findMany };
  }

  it('add-on off: ETMS grants stripped, no agreement query, GPS grants untouched', async () => {
    const { svc, findMany } = service({});
    const ctx = await svc.forUser('u1', undefined, null);
    expect(ctx.permissions).toEqual({ live_map: ['view'] });
    expect(ctx.features).toEqual([]);
    expect(ctx.agreements).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('add-on on: ETMS grants kept and the provider-side active agreements loaded (ACTIVE, in validity, never own company)', async () => {
    const { svc, findMany } = service({ features: ['etms'] });
    const ctx = await svc.forUser('u1', undefined, null);
    expect(ctx.permissions.etms_partners).toEqual(['view']);
    expect(ctx.companyId).toBe('prov');
    expect(ctx.agreements).toEqual([{ id: 'a1', customerCompanyId: 'cust', grants: ['VIEW_BOOKINGS'], siteIds: [], dataProfile: 'MINIMAL', validFrom: 1000, validTo: null }]);
    const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({
      providerCompanyId: 'prov',
      customerCompanyId: { not: 'prov' },
      status: 'ACTIVE',
      customer: { status: 'ACTIVE', isPlatform: false, settings: { path: ['features'], array_contains: ['etms'] } },
    });
  });

  it('F3: customer module off → the provider loses the grants (query filter and code check); back on → restored', async () => {
    const off = service({ features: ['etms'] }, { customer: { ...customerOn, settings: { features: ['attendance'] } } });
    expect((await off.svc.forUser('u1', undefined, null)).agreements).toEqual([]);
    const none = service({ features: ['etms'] }, { customer: { ...customerOn, settings: {} } });
    expect((await none.svc.forUser('u1', undefined, null)).agreements).toEqual([]);
    const suspended = service({ features: ['etms'] }, { customer: { ...customerOn, status: 'SUSPENDED' } });
    expect((await suspended.svc.forUser('u1', undefined, null)).agreements).toEqual([]);
    const on = service({ features: ['etms'] });
    expect((await on.svc.forUser('u1', undefined, null)).agreements?.map((a) => a.id)).toEqual(['a1']);
  });

  it('R-12: isCompanyAdmin only for holders of the own company’s built-in Admin role (and the Super Admin)', async () => {
    const admin = { isSystem: true, name: 'Admin', companyId: 'prov', dataScope: 'COMPANY', permissions: [] };
    expect((await service({}, { roles: [{ role: admin }] }).svc.forUser('u1', undefined, null)).isCompanyAdmin).toBe(true);
    expect((await service({}, { roles: [{ role: { ...admin, isSystem: false } }] }).svc.forUser('u1', undefined, null)).isCompanyAdmin).toBe(false);
    expect((await service({}, { roles: [{ role: { ...admin, companyId: 'other' } }] }).svc.forUser('u1', undefined, null)).isCompanyAdmin).toBe(false);
    expect((await service({}).svc.forUser('u1', undefined, null)).isCompanyAdmin).toBe(false);
    expect((await service({}, { superAdmin: true }).svc.forUser('u1', undefined, null)).isCompanyAdmin).toBe(true);
  });

  it('Super Admin switched into a company without the add-on sees no ETMS menus', async () => {
    const { svc } = service({ features: ['etms'] }, { superAdmin: true, selected: { settings: {}, isPlatform: false } });
    const ctx = await svc.forUser('u1', '6f1c1a54-8a6a-4a43-9d6c-2d8b4a1e0b11', null);
    expect(ctx.companyId).toBe('6f1c1a54-8a6a-4a43-9d6c-2d8b4a1e0b11');
    expect(ctx.permissions.etms_partners).toBeUndefined();
    expect(ctx.permissions.sa_companies).toBeDefined();
  });
});

describe('ETMS role templates (P6)', () => {
  it('seeds the four templates once, editable, and keeps a same-named existing role untouched', async () => {
    const created: { name: string; isSystem: boolean; dataScope: string }[] = [];
    const db = {
      role: {
        findUnique: async ({ where }: { where: { companyId_name: { name: string } } }) => (where.companyId_name.name === 'Transport driver' ? { id: 'mine' } : null),
        create: async ({ data }: { data: { name: string; isSystem: boolean; dataScope: string } }) => created.push(data),
      },
    };
    const names = await ensureEtmsRoleTemplates(db as never, 'c1');
    expect(names).toEqual(['Transport admin', 'Transport dispatcher', 'Transport passenger']);
    expect(created.every((r) => r.isSystem === false)).toBe(true);
    expect(created.find((r) => r.name === 'Transport dispatcher')?.dataScope).toBe('ASSIGNED');
  });

  it('templates use only valid menus and actions', () => {
    for (const t of ETMS_ROLE_TEMPLATES) {
      expect(validateRolePermissions(Object.entries(t.permissions).map(([menu, actions]) => ({ menu, actions: actions ?? [] })))).toBeNull();
    }
    expect(ETMS_ROLE_TEMPLATES.find((t) => t.name === 'Transport passenger')?.permissions).toEqual({ etms_self: ['view'] });
  });
});
