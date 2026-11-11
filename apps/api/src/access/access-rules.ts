import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Action, ACTIONS, can, DataScope, MENUS, MenuKey, PermissionMap } from '@veetracer/shared';
import { AuthContext, SharedVehicle } from './auth-context';

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

/** The share behind a vehicle the company doesn't own, if any. */
export function shareOf(ctx: Pick<AuthContext, 'shares'>, objectId: string): SharedVehicle | undefined {
  return ctx.shares?.find((x) => x.objectId === objectId);
}

/** Read paths only: the caller's objects plus those shared with their company. Never use it for a change. */
export function objectReadScopeWhere(ctx: ScopeCtx & Pick<AuthContext, 'shares'>): Prisma.TrackedObjectWhereInput {
  const own = objectScopeWhere(ctx);
  return ctx.shares?.length ? { OR: [own, { id: { in: ctx.shares.map((x) => x.objectId) } }] } : own;
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

// ───────────────────────────── Role-grant ceiling (R-12 / AZ-1, WP 0.5-9) ─────────────────────────────

/** Name of the built-in company administrator role (SYSTEM_ROLES). */
export const ADMIN_ROLE = 'Admin';

type CeilingCtx = Pick<AuthContext, 'isSuperAdmin' | 'isCompanyAdmin' | 'dataScope' | 'permissions'>;

/**
 * Callers the ceiling does not apply to: the Super Admin and holders of the company's built-in Admin role. Admins hold
 * every grantable menu of the company; module menus (ETMS) are not in the global Admin role but come from the module's
 * role templates, and the Admin must still be able to hand those out.
 */
export function aboveCeiling(ctx: Pick<AuthContext, 'isSuperAdmin' | 'isCompanyAdmin'>): boolean {
  return ctx.isSuperAdmin || !!ctx.isCompanyAdmin;
}

/**
 * What `role` grants beyond the caller's own rights: company-wide data scope the caller lacks, and menu actions the
 * caller does not hold (compared with the caller's effective permissions, so a module that is off grants nothing).
 * Empty = within the ceiling. Labels only (no ids), for the 403 message.
 */
export function ceilingExcess(ctx: CeilingCtx, role: RoleGrant): string[] {
  if (aboveCeiling(ctx)) return [];
  const out: string[] = [];
  if (role.dataScope === 'COMPANY' && ctx.dataScope !== 'COMPANY') out.push('whole-company data scope');
  for (const perm of role.permissions) {
    const mine = new Set<string>(ctx.permissions[perm.menu as MenuKey] ?? []);
    const extra = perm.actions.filter((a) => !mine.has(a));
    if (extra.length) out.push(`${MENU_BY_KEY.get(perm.menu)?.label ?? perm.menu}: ${extra.join(', ')}`);
  }
  return out;
}

function ceilingError(message: string, excess: string[]): ForbiddenException {
  const shown = excess.slice(0, 5).join('; ') + (excess.length > 5 ? `; and ${excess.length - 5} more` : '');
  return new ForbiddenException({ message: `${message} (${shown})`, code: 'PERMISSION_CEILING' });
}

/** Creating or editing a role: the role (before and after an edit) must not grant more than the caller holds. */
export function assertRoleWithinCeiling(ctx: CeilingCtx, role: RoleGrant, message = 'You cannot give a role rights you do not have yourself'): void {
  const excess = ceilingExcess(ctx, role);
  if (excess.length) throw ceilingError(message, excess);
}

/** Assigning roles to a user (or managing a user who holds them): each role must be within the caller's ceiling. */
export function assertRolesWithinCeiling(ctx: CeilingCtx, roles: (RoleGrant & { name: string })[], message: (name: string) => string): void {
  for (const role of roles) {
    const excess = ceilingExcess(ctx, role);
    if (excess.length) throw ceilingError(message(role.name), excess);
  }
}

/** Read scope of the live map and the vehicle / device / driver lists: nothing when the Super Admin views all companies. */
export function allCompaniesOr<T>(ctx: Pick<AuthContext, 'allCompanies'>, scoped: T): T | Record<string, never> {
  return ctx.allCompanies ? {} : scoped;
}
