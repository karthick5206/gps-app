import { ETMS_ROLE_TEMPLATES, SYSTEM_ROLES, withoutUnavailableMenus, type CompanyFeature, type DataScope, type PermissionMap } from '@veetracer/shared';
import { RolesService } from '../masters/roles/roles.service';
import { UsersService } from '../masters/users/users.service';
import { aboveCeiling, assertRoleWithinCeiling, ceilingExcess, resolvePermissions, RoleGrant } from './access-rules';
import type { AuthContext } from './auth-context';

/**
 * R-12 / AZ-1 / WP 0.5-9 (docs/employee-transport/10 W3, 12 §2.2, 13 ETR-03; docs/modernization/02-role-permission-matrix
 * §3): nobody builds, edits, deletes or assigns a role that grants more than they hold, and nobody manages a user who
 * holds such a role. The Super Admin and holders of the company's built-in Admin role are above the ceiling.
 */
type Obj = Record<string, unknown>;
type Role = { id: string; name: string; isSystem: boolean; dataScope: DataScope; permissions: { menu: string; actions: string[] }[] };

const grantsOf = (p: PermissionMap) => Object.entries(p).map(([menu, actions]) => ({ menu, actions: [...(actions ?? [])] }));
const sys = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!;
const tpl = (name: string) => ETMS_ROLE_TEMPLATES.find((r) => r.name === name)!;
const role = (id: string, name: string, dataScope: DataScope, permissions: PermissionMap, isSystem = false): Role => ({ id, name, isSystem, dataScope, permissions: grantsOf(permissions) });

const ROLES: Record<string, Role> = {
  'r-admin': role('r-admin', 'Admin', 'COMPANY', sys('Admin').permissions, true),
  'r-manager': role('r-manager', 'Manager', 'ASSIGNED', sys('Manager').permissions, true),
  'r-user': role('r-user', 'User', 'ASSIGNED', sys('User').permissions, true),
  'r-viewer': role('r-viewer', 'Viewer', 'ASSIGNED', sys('Viewer').permissions, true),
  // A custom ASSIGNED role with more than a Manager has (device commands, billing).
  'r-power': role('r-power', 'Power user', 'ASSIGNED', { live_map: ['view', 'command'], billing: ['view'] }),
  'r-dispatcher': role('r-dispatcher', 'Transport dispatcher', 'ASSIGNED', tpl('Transport dispatcher').permissions),
  // F1 scenario: the dispatcher template after someone added etms_partners:edit.
  'r-dispatcher-edit': role('r-dispatcher-edit', 'Transport dispatcher+', 'ASSIGNED', { ...tpl('Transport dispatcher').permissions, etms_partners: ['view', 'edit'] }),
  'r-tadmin': role('r-tadmin', 'Transport admin', 'COMPANY', tpl('Transport admin').permissions),
  // A whole-company HR role that manages users and roles but holds little else.
  'r-hr': role('r-hr', 'HR', 'COMPANY', { users: ['view', 'create', 'edit', 'delete', 'export'], roles: ['view', 'create', 'edit', 'delete'], live_map: ['view'] }),
};

function ctxFor(roleIds: string[], opts: { features?: CompanyFeature[]; admin?: boolean; superAdmin?: boolean; userId?: string } = {}): AuthContext {
  const grants: RoleGrant[] = roleIds.map((id) => ROLES[id]);
  const resolved = resolvePermissions(grants, !!opts.superAdmin);
  return {
    userId: opts.userId ?? 'me',
    homeCompanyId: 'c1',
    companyId: 'c1',
    isSuperAdmin: !!opts.superAdmin,
    isCompanyAdmin: !!opts.admin || !!opts.superAdmin,
    permissions: withoutUnavailableMenus(resolved.permissions, opts.features ?? []),
    dataScope: resolved.dataScope,
    branchIds: ['b1'],
    objectIds: [],
    features: opts.features ?? [],
    ip: null,
  };
}

const MANAGER = ctxFor(['r-manager']);
const ADMIN = ctxFor(['r-admin'], { admin: true });
const HR = ctxFor(['r-hr']);
const SUPER = ctxFor([], { superAdmin: true });
const ETMS: CompanyFeature[] = ['etms'];

const status = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { getStatus?(): number; getResponse?(): unknown; message?: string }) => {
      const r = e.getResponse?.();
      const code = typeof r === 'object' && r !== null ? ((r as { code?: string }).code ?? '') : '';
      return e.getStatus ? `${e.getStatus()} ${code}`.trim() : `error ${e.message}`;
    },
  );

describe('ceilingExcess / assertRoleWithinCeiling (pure)', () => {
  it('built-in roles below a Manager are within its ceiling; the Manager role itself too', () => {
    for (const id of ['r-user', 'r-viewer', 'r-manager']) expect([id, ceilingExcess(MANAGER, ROLES[id])]).toEqual([id, []]);
  });

  it('extra actions and company-wide scope are reported, labels only', () => {
    expect(ceilingExcess(MANAGER, ROLES['r-power'])).toEqual(['Live Map: command', 'Billing & Licences: view']);
    expect(ceilingExcess(MANAGER, ROLES['r-admin'])).toContain('whole-company data scope');
    expect(ceilingExcess(MANAGER, { dataScope: 'COMPANY', permissions: [] })).toEqual(['whole-company data scope']);
    expect(() => assertRoleWithinCeiling(MANAGER, ROLES['r-power'])).toThrow(/rights you do not have yourself \(Live Map: command; Billing & Licences: view\)/);
  });

  it('module menus: a non-Admin cannot hand out ETMS rights it does not hold, also when the module is off', () => {
    expect(ceilingExcess(ctxFor(['r-manager']), ROLES['r-dispatcher'])).toContain('Transport dashboard: view');
    expect(ceilingExcess(ctxFor(['r-tadmin'], { features: ETMS }), ROLES['r-dispatcher'])).toEqual([]);
    // Same Transport admin while the module is off: its ETMS grants are stripped, so it can't pass them on.
    expect(ceilingExcess(ctxFor(['r-tadmin']), ROLES['r-dispatcher'])).toContain('Customers / Providers & agreements: view');
  });

  it('the Super Admin and company Admins are above the ceiling (Admins hand out module roles they do not hold)', () => {
    expect(aboveCeiling(SUPER)).toBe(true);
    expect(aboveCeiling(ADMIN)).toBe(true);
    expect(aboveCeiling(HR)).toBe(false);
    expect(ADMIN.permissions.etms_partners).toBeUndefined();
    expect(ceilingExcess(ADMIN, ROLES['r-tadmin'])).toEqual([]);
    expect(ceilingExcess(SUPER, ROLES['r-power'])).toEqual([]);
  });

  it('a non-Admin holding every Admin grant (an Admin copy) is within for all non-module roles', () => {
    const copy = ctxFor(['r-admin']); // same grants, but not the built-in Admin role
    for (const id of ['r-admin', 'r-manager', 'r-power', 'r-hr']) expect([id, ceilingExcess(copy, ROLES[id])]).toEqual([id, []]);
    expect(ceilingExcess(copy, ROLES['r-tadmin']).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── RolesService ─────────────────────────────

function rolesService() {
  const db = new Map(Object.values(ROLES).map((r) => [r.id, structuredClone(r)]));
  const row = (r: Role) => ({ ...r, description: null, companyId: 'c1', createdAt: new Date(), updatedAt: new Date(), _count: { users: 0 } });
  const prisma = {
    role: {
      create: jest.fn(async ({ data }: { data: Obj }) => row({ id: 'new', name: data.name as string, isSystem: false, dataScope: data.dataScope as DataScope, permissions: (data.permissions as { create: Role['permissions'] }).create })),
      findFirst: async ({ where }: { where: { id: string } }) => (db.has(where.id) ? row(db.get(where.id)!) : null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Obj }) => {
        const r = db.get(where.id)!;
        if (data.dataScope) r.dataScope = data.dataScope as DataScope;
        if (data.permissions) r.permissions = (data.permissions as { create: Role['permissions'] }).create;
        return row(r);
      }),
      delete: jest.fn(async () => undefined),
    },
    rolePermission: { deleteMany: async () => undefined },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const svc = new RolesService(prisma as never, { record: async () => undefined } as never, { invalidateCache: async () => undefined } as never);
  return { svc, prisma };
}

describe('RolesService: role ceiling (all menus, not only ETMS)', () => {
  const perms = (p: PermissionMap) => grantsOf(p) as never;

  it('create: within the caller’s rights → ok; beyond → 403 PERMISSION_CEILING, nothing written', async () => {
    const { svc, prisma } = rolesService();
    expect(await status(svc.create(HR, { name: 'Clerk', dataScope: 'ASSIGNED', permissions: perms({ users: ['view'], live_map: ['view'] }) }))).toBe('ok');
    expect(await status(svc.create(HR, { name: 'Boss', dataScope: 'ASSIGNED', permissions: perms({ live_map: ['view', 'command'] }) }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.create(HR, { name: 'Admin copy', dataScope: 'COMPANY', permissions: perms(sys('Admin').permissions) }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.create(MANAGER, { name: 'Wide', dataScope: 'COMPANY', permissions: perms({ live_map: ['view'] }) }))).toBe('403 PERMISSION_CEILING');
    expect(prisma.role.create).toHaveBeenCalledTimes(1);
  });

  it('F1 scenario: someone with roles:edit but no etms_partners:edit cannot add it to the dispatcher template', async () => {
    const { svc, prisma } = rolesService();
    const hrWithEtms = ctxFor(['r-hr'], { features: ETMS });
    expect(await status(svc.update(hrWithEtms, 'r-dispatcher', { permissions: perms({ ...tpl('Transport dispatcher').permissions, etms_partners: ['view', 'edit'] }) }))).toBe('403 PERMISSION_CEILING');
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it('update: a role above the caller can’t be touched, not even narrowed; a role within can’t be widened beyond', async () => {
    const { svc } = rolesService();
    expect(await status(svc.update(HR, 'r-admin', { description: 'x' }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.update(HR, 'r-power', { permissions: perms({ live_map: ['view'] }) }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.update(HR, 'r-viewer', { permissions: perms({ live_map: ['view'] }) }))).toBe('403 PERMISSION_CEILING'); // Viewer has history etc. HR lacks
    const lean = { id: 'r-lean', name: 'Lean', isSystem: false, dataScope: 'ASSIGNED' as const, permissions: [{ menu: 'live_map', actions: ['view'] }] };
    ROLES['r-lean'] = lean;
    const fresh = rolesService();
    expect(await status(fresh.svc.update(HR, 'r-lean', { permissions: perms({ live_map: ['view'], users: ['view'] }) }))).toBe('ok');
    expect(await status(fresh.svc.update(HR, 'r-lean', { permissions: perms({ live_map: ['view', 'command'] }) }))).toBe('403 PERMISSION_CEILING');
    expect(await status(fresh.svc.update(HR, 'r-lean', { dataScope: 'COMPANY' }))).toBe('ok'); // HR is COMPANY scope itself
    delete ROLES['r-lean'];
  });

  it('delete: a role above the caller can’t be deleted', async () => {
    const { svc, prisma } = rolesService();
    expect(await status(svc.remove(HR, 'r-power'))).toBe('403 PERMISSION_CEILING');
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('Admins and the Super Admin are unaffected: any role, including module roles they do not hold', async () => {
    const { svc } = rolesService();
    expect(await status(svc.create(ADMIN, { name: 'Ops', dataScope: 'COMPANY', permissions: perms({ live_map: ['view', 'command'], billing: ['view', 'edit'] }) }))).toBe('ok');
    expect(await status(svc.update(ADMIN, 'r-dispatcher', { permissions: perms({ ...tpl('Transport dispatcher').permissions, etms_partners: ['view', 'edit'] }) }))).toBe('ok');
    expect(await status(svc.update(ADMIN, 'r-power', { permissions: perms({ live_map: ['view'] }) }))).toBe('ok');
    expect(await status(svc.remove(ADMIN, 'r-power'))).toBe('ok');
    expect(await status(svc.update(SUPER, 'r-tadmin', { description: 'x' }))).toBe('ok');
  });
});

// ───────────────────────────── UsersService ─────────────────────────────

function usersService() {
  const mkUser = (id: string, roleIds: string[], extra: Obj = {}) => ({
    id,
    companyId: 'c1',
    name: id,
    email: `${id}@example.com`,
    mobile: null,
    isActive: true,
    isSuperAdmin: false,
    managerId: null,
    manager: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: roleIds.map((roleId) => ({ roleId, role: ROLES[roleId] })),
    branches: [{ branchId: 'b1', branch: { id: 'b1', name: 'B1' } }],
    objects: [],
    ...extra,
  });
  const users = new Map(
    [
      mkUser('me', ['r-manager']),
      mkUser('hr', ['r-hr']),
      mkUser('staff', ['r-user']),
      mkUser('boss', ['r-admin']),
      mkUser('power', ['r-power']),
      mkUser('tadmin-off', ['r-manager', 'r-dispatcher']),
    ].map((u) => [u.id, u]),
  );
  const prisma = {
    user: {
      findFirst: async ({ where }: { where: Obj }) => [...users.values()].find((u) => JSON.stringify(where).includes(`"id":"${u.id}"`)) ?? null,
      create: jest.fn(async ({ data }: { data: Obj }) => mkUser('new', ((data.roles as { create: { roleId: string }[] }).create ?? []).map((r) => r.roleId))),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Obj }) => {
        const u = users.get(where.id)!;
        const roles = data.roles as { create: { roleId: string }[] } | undefined;
        return roles ? mkUser(u.id, roles.create.map((r) => r.roleId)) : u;
      }),
      delete: jest.fn(async () => undefined),
      count: async () => 1,
    },
    role: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ROLES[id]).filter(Boolean) },
    branch: { count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length },
    trackedObject: { count: async () => 0 },
    userRole: { deleteMany: async () => undefined },
    userBranch: { deleteMany: async () => undefined },
    userObject: { deleteMany: async () => undefined },
    session: { updateMany: async () => undefined },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const svc = new UsersService(prisma as never, { record: async () => undefined } as never, { invalidateCache: async () => undefined } as never);
  return { svc, prisma };
}

describe('UsersService: assigning roles and managing users (all menus)', () => {
  const newUser = (roleIds: string[]) => ({ name: 'New', email: 'new@example.com', roleIds, branchIds: ['b1'] });

  it('a Manager may still give User / Viewer / Manager (unchanged behaviour)', async () => {
    const { svc } = usersService();
    expect(await status(svc.create(MANAGER, newUser(['r-user'])))).toBe('ok');
    expect(await status(svc.create(MANAGER, newUser(['r-viewer', 'r-manager'])))).toBe('ok');
    expect(await status(svc.update(MANAGER, 'staff', { roleIds: ['r-viewer'] }))).toBe('ok');
  });

  it('a Manager may not give a custom ASSIGNED role with more rights (was allowed before R-12)', async () => {
    const { svc, prisma } = usersService();
    expect(await status(svc.create(MANAGER, newUser(['r-power'])))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.update(MANAGER, 'staff', { roleIds: ['r-user', 'r-power'] }))).toBe('403 PERMISSION_CEILING');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('F1 scenario: a branch-scoped user cannot give themselves the widened dispatcher role (ETMS rights it lacks)', async () => {
    const { svc, prisma } = usersService();
    const manager = ctxFor(['r-manager'], { features: ETMS });
    expect(await status(svc.update(manager, 'me', { roleIds: ['r-manager', 'r-dispatcher-edit'] }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.update(manager, 'me', { roleIds: ['r-manager', 'r-power'] }))).toBe('403 PERMISSION_CEILING');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('nobody but an Admin manages a user holding a role above them (e.g. resets an Admin’s password)', async () => {
    const { svc, prisma } = usersService();
    expect(await status(svc.update(HR, 'boss', { password: 'Secret#12345' }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.update(HR, 'power', { name: 'x' }))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.remove(HR, 'boss'))).toBe('403 PERMISSION_CEILING');
    expect(await status(svc.update(HR, 'staff', { name: 'x' }))).toBe('403 PERMISSION_CEILING'); // User role has menus HR lacks
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('callers may edit themselves and keep roles they already hold, even if one is above their current rights', async () => {
    const { svc } = usersService();
    // Holds the dispatcher role while the module is off (its ETMS grants are stripped): keeping it is fine.
    const me = ctxFor(['r-manager', 'r-dispatcher'], { userId: 'tadmin-off' });
    expect(await status(svc.update(me, 'tadmin-off', { name: 'New name' }))).toBe('ok');
    expect(await status(svc.update(me, 'tadmin-off', { roleIds: ['r-manager', 'r-dispatcher'] }))).toBe('ok');
    expect(await status(svc.update(me, 'tadmin-off', { roleIds: ['r-manager'] }))).toBe('ok');
  });

  it('Admins and the Super Admin are unaffected: any role to anyone, ETMS roles included', async () => {
    const { svc } = usersService();
    expect(await status(svc.create(ADMIN, newUser(['r-admin'])))).toBe('ok');
    expect(await status(svc.create(ADMIN, newUser(['r-tadmin', 'r-dispatcher-edit', 'r-power'])))).toBe('ok');
    expect(await status(svc.update(ADMIN, 'boss', { password: 'Secret#12345' }))).toBe('ok');
    expect(await status(svc.update(ADMIN, 'power', { roleIds: ['r-tadmin'] }))).toBe('ok');
    expect(await status(svc.create(SUPER, newUser(['r-power'])))).toBe('ok');
  });

  it('the old scope ceiling still applies: a Manager never gives a COMPANY-scope role', async () => {
    const { svc } = usersService();
    expect(await status(svc.create(MANAGER, newUser(['r-tadmin'])))).toBe('403');
  });
});
