import { ForbiddenException } from '@nestjs/common';
import { MENUS, SYSTEM_ROLES } from '@veetracer/shared';
import {
  assertCanManageUserAccess,
  branchScopeWhere,
  deviceScopeWhere,
  objectScopeWhere,
  resolvePermissions,
  RoleGrant,
  validateRolePermissions,
} from './access-rules';

const toGrant = (name: string): RoleGrant => {
  const role = SYSTEM_ROLES.find((r) => r.name === name)!;
  return {
    dataScope: role.dataScope,
    permissions: Object.entries(role.permissions).map(([menu, actions]) => ({ menu, actions: actions ?? [] })),
  };
};

const assigned = {
  companyId: 'c1',
  dataScope: 'ASSIGNED' as const,
  branchIds: ['b1'],
  objectIds: ['o1', 'o2'],
};

describe('resolvePermissions', () => {
  it('gives the Super Admin every menu (including platform menus) with COMPANY scope', () => {
    const { permissions, dataScope } = resolvePermissions([], true);
    expect(dataScope).toBe('COMPANY');
    expect(Object.keys(permissions)).toHaveLength(MENUS.length);
    expect(permissions.sa_companies).toEqual(['view', 'create', 'edit', 'delete', 'export']);
  });

  it('unions role permissions and picks COMPANY scope if any role has it', () => {
    const { permissions, dataScope } = resolvePermissions([toGrant('Viewer'), toGrant('Manager')], false);
    expect(dataScope).toBe('ASSIGNED');
    expect(permissions.live_map).toEqual(['view']); // device commands are Admin-only
    expect(resolvePermissions([toGrant('Admin')], false).permissions.live_map).toEqual(['view', 'command']);
    expect(permissions.users).toEqual(['view', 'create', 'edit']);
    expect(resolvePermissions([toGrant('Viewer'), toGrant('Admin')], false).dataScope).toBe('COMPANY');
  });

  it('never grants platform menus, unknown menus or actions a menu does not support', () => {
    const { permissions } = resolvePermissions(
      [
        {
          dataScope: 'COMPANY',
          permissions: [
            { menu: 'sa_companies', actions: ['view'] },
            { menu: 'nope', actions: ['view'] },
            { menu: 'dashboard', actions: ['view', 'delete', 'fly'] },
          ],
        },
      ],
      false,
    );
    expect(permissions).toEqual({ dashboard: ['view'] });
  });

  it('Admin system role holds every non-platform menu', () => {
    const { permissions } = resolvePermissions([toGrant('Admin')], false);
    expect(Object.keys(permissions).sort()).toEqual(MENUS.filter((m) => !m.superAdminOnly).map((m) => m.key).sort());
  });
});

describe('validateRolePermissions', () => {
  it('accepts valid matrices and rejects bad ones', () => {
    expect(validateRolePermissions([{ menu: 'objects', actions: ['view', 'export'] }])).toBeNull();
    expect(validateRolePermissions([{ menu: 'xyz', actions: [] }])).toMatch(/Unknown menu/);
    expect(validateRolePermissions([{ menu: 'sa_companies', actions: ['view'] }])).toMatch(/Super Admin/);
    expect(validateRolePermissions([{ menu: 'dashboard', actions: ['edit'] }])).toMatch(/not available/);
    expect(
      validateRolePermissions([
        { menu: 'dashboard', actions: ['view'] },
        { menu: 'dashboard', actions: ['view'] },
      ]),
    ).toMatch(/twice/);
  });
});

describe('data scope filters', () => {
  it('COMPANY scope filters by company only', () => {
    const ctx = { ...assigned, dataScope: 'COMPANY' as const };
    expect(objectScopeWhere(ctx)).toEqual({ companyId: 'c1' });
    expect(branchScopeWhere(ctx)).toEqual({ companyId: 'c1' });
    expect(deviceScopeWhere(ctx)).toEqual({ companyId: 'c1' });
  });

  it('ASSIGNED scope = branches ∪ mapped objects', () => {
    expect(objectScopeWhere(assigned)).toEqual({
      companyId: 'c1',
      OR: [{ branchId: { in: ['b1'] } }, { id: { in: ['o1', 'o2'] } }],
    });
    expect(branchScopeWhere(assigned)).toEqual({ companyId: 'c1', id: { in: ['b1'] } });
    expect(deviceScopeWhere(assigned)).toEqual({
      companyId: 'c1',
      assignments: { some: { toTime: null, object: objectScopeWhere(assigned) } },
    });
  });
});

describe('assertCanManageUserAccess', () => {
  it('lets COMPANY scope do anything', () => {
    expect(() =>
      assertCanManageUserAccess({ ...assigned, dataScope: 'COMPANY' }, [], [{ dataScope: 'COMPANY' }]),
    ).not.toThrow();
  });

  it('restricts ASSIGNED scope to own branches and non-company roles', () => {
    expect(() => assertCanManageUserAccess(assigned, ['b1'], [{ dataScope: 'ASSIGNED' }])).not.toThrow();
    expect(() => assertCanManageUserAccess(assigned, ['b2'], [])).toThrow(ForbiddenException);
    expect(() => assertCanManageUserAccess(assigned, [], [])).toThrow(ForbiddenException);
    expect(() => assertCanManageUserAccess(assigned, ['b1'], [{ dataScope: 'COMPANY' }])).toThrow(/company-wide/);
  });
});
