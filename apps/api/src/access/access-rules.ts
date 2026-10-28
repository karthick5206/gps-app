import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Action, ACTIONS, can, DataScope, MENUS, MenuKey, PermissionMap } from '@veetracer/shared';
import { AuthContext } from './auth-context';

export interface RoleGrant {
  dataScope: DataScope;
  permissions: { menu: string; actions: string[] }[];
}

const MENU_BY_KEY = new Map(MENUS.map((m) => [m.key as string, m]));
const ALL_ACTIONS = new Set<string>(ACTIONS);

/** Super Admin: every menu and action. Others: union of their roles, restricted to valid, non-platform menus. */
export function resolvePermissions(
  roles: RoleGrant[],
  isSuperAdmin: boolean,
): { permissions: PermissionMap; dataScope: DataScope } {
  if (isSuperAdmin) {
    return {
      permissions: Object.fromEntries(MENUS.map((m) => [m.key, [...m.actions]])) as PermissionMap,
      dataScope: 'COMPANY',
    };
  }
  const granted = new Map<MenuKey, Set<Action>>();
  for (const role of roles) {
    for (const perm of role.permissions) {
      const menu = MENU_BY_KEY.get(perm.menu);
      if (!menu || menu.superAdminOnly) continue;
      const set = granted.get(menu.key) ?? new Set<Action>();
      for (const action of perm.actions) {
        if (ALL_ACTIONS.has(action) && menu.actions.includes(action as Action)) set.add(action as Action);
      }
      if (set.size) granted.set(menu.key, set);
    }
  }
  const permissions: PermissionMap = {};
  for (const menu of MENUS) {
    const set = granted.get(menu.key);
    if (set) permissions[menu.key] = menu.actions.filter((a) => set.has(a));
  }
  const dataScope: DataScope = roles.some((r) => r.dataScope === 'COMPANY') ? 'COMPANY' : 'ASSIGNED';
  return { permissions, dataScope };
}

/** Validate a role's permission matrix against the menu catalogue; returns an error message or null. */
export function validateRolePermissions(perms: { menu: string; actions: string[] }[]): string | null {
  const seen = new Set<string>();
  for (const perm of perms) {
    const menu = MENU_BY_KEY.get(perm.menu);
    if (!menu) return `Unknown menu "${perm.menu}"`;
    if (menu.superAdminOnly) return `Menu "${perm.menu}" is reserved for the Super Admin`;
    if (seen.has(perm.menu)) return `Menu "${perm.menu}" listed twice`;
    seen.add(perm.menu);
    const bad = perm.actions.find((a) => !menu.actions.includes(a as Action));
    if (bad) return `Action "${bad}" is not available for menu "${perm.menu}"`;
  }
  return null;
}

export function hasPermission(ctx: Pick<AuthContext, 'permissions'>, menu: MenuKey, action: Action): boolean {
  return can(ctx.permissions, menu, action);
}

type ScopeCtx = Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'objectIds'>;

/** Objects the caller may see: whole company, or their branches ∪ their mapped objects. */
export function objectScopeWhere(ctx: ScopeCtx): Prisma.TrackedObjectWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, OR: [{ branchId: { in: ctx.branchIds } }, { id: { in: ctx.objectIds } }] };
}

export function branchScopeWhere(ctx: ScopeCtx): Prisma.BranchWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, id: { in: ctx.branchIds } };
}

/** Company devices; in ASSIGNED scope only those currently fitted to a visible object. */
export function deviceScopeWhere(ctx: ScopeCtx): Prisma.DeviceWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return {
    companyId: ctx.companyId,
    assignments: { some: { toTime: null, object: objectScopeWhere(ctx) } },
  };
}

/** Users visible to the caller: whole company, or users sharing one of the caller's branches (plus self). */
export function userScopeWhere(ctx: ScopeCtx & Pick<AuthContext, 'userId'>): Prisma.UserWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return {
    companyId: ctx.companyId,
    OR: [{ id: ctx.userId }, { branches: { some: { branchId: { in: ctx.branchIds } } } }],
  };
}

/** ASSIGNED-scope callers may only place users in their own branches and never grant COMPANY scope. */
export function assertCanManageUserAccess(
  ctx: ScopeCtx,
  branchIds: string[],
  roles: { dataScope: DataScope }[],
): void {
  if (ctx.dataScope === 'COMPANY') return;
  if (branchIds.length === 0) throw new ForbiddenException('Users you manage must belong to one of your branches');
  const own = new Set(ctx.branchIds);
  if (branchIds.some((id) => !own.has(id))) throw new ForbiddenException('You can only use your own branches');
  if (roles.some((r) => r.dataScope === 'COMPANY')) {
    throw new ForbiddenException('You cannot assign roles with company-wide scope');
  }
}

/** Read scope of the live map and the vehicle / device / driver lists: nothing when the Super Admin views all companies. */
export function allCompaniesOr<T>(ctx: Pick<AuthContext, 'allCompanies'>, scoped: T): T | Record<string, never> {
  return ctx.allCompanies ? {} : scoped;
}
