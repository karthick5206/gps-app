import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ETMS_ROLE_TEMPLATES, type PermissionMap } from '@veetracer/shared';
import { assertRolesWithinCeiling, assertRoleWithinCeiling, type RoleGrant } from '../../access/access-rules';
import type { AuthContext } from '../../access/auth-context';
import { hashPassword } from '../../common/secrets';
import { ensureEtmsRoleTemplates, templatePermissions } from '../etms-role-templates';

type Tx = Prisma.TransactionClient;

export const identityInUse = (message = 'This email or mobile number already belongs to another login') => new ConflictException({ message, code: 'IDENTITY_IN_USE' });

export interface LinkRequest {
  companyId: string;
  name: string;
  email: string | null;
  mobile: string | null;
  password?: string;
  /** Role template name (ETMS_PASSENGER_ROLE_NAME / ETMS_DRIVER_ROLE_NAME). */
  roleName: string;
  /** The User already linked to the profile / driver, if any. */
  currentUserId: string | null;
  /** The linking column on the other table is unique: a User may serve one profile and one driver at most. */
  linkedElsewhere: (userId: string) => Promise<boolean>;
  /** The caller (R-12 role-grant ceiling). */
  actor: LinkActor;
}

export type LinkActor = Pick<AuthContext, 'userId' | 'isSuperAdmin' | 'isCompanyAdmin' | 'dataScope' | 'permissions'>;

/**
 * Self-service menus a login template may carry although the caller does not hold them: they only ever show the login
 * holder's OWN data (relationship-checked, e.g. 403 NOT_A_PASSENGER), so handing them out widens nobody's access to
 * other people's data. Only the actions of the canonical template count (templatePermissions), never more.
 */
const SELF_SERVICE_MENUS = ['etms_self', 'etms_driver'] as const;

function selfServiceAllowance(roleName: string): PermissionMap {
  const def = ETMS_ROLE_TEMPLATES.find((t) => t.name === roleName);
  if (!def) return {};
  const base = templatePermissions(def.name, def.permissions);
  const out: PermissionMap = {};
  for (const m of SELF_SERVICE_MENUS) if (base[m]?.length) out[m] = [...base[m]!];
  return out;
}

/**
 * R-12 for passenger / driver logins: the role the login gets is the company's copy of the template, which an admin may
 * have changed since it was seeded. It may grant at most what the caller holds plus the template's own self-service
 * menus (SELF_SERVICE_MENUS); a widened template (more menus, or whole-company scope) is 403 PERMISSION_CEILING, so a
 * dispatcher cannot hand out (or take, by linking their own login) rights they do not have.
 */
export function assertLoginTemplateWithinCeiling(actor: LinkActor, roleName: string, role: RoleGrant): void {
  const permissions: PermissionMap = { ...actor.permissions };
  for (const [menu, actions] of Object.entries(selfServiceAllowance(roleName))) {
    const key = menu as keyof PermissionMap;
    permissions[key] = [...new Set([...(permissions[key] ?? []), ...(actions ?? [])])];
  }
  assertRoleWithinCeiling({ ...actor, permissions }, role, `You cannot give the role "${roleName}": it has rights you do not have yourself`);
}

const ROLE_GRANT_SELECT = { name: true, dataScope: true, permissions: { select: { menu: true, actions: true } } } satisfies Prisma.RoleSelect;
type RoleWithGrant = Prisma.RoleGetPayload<{ select: typeof ROLE_GRANT_SELECT }>;

/**
 * R-12 (as Users' findManageable): setting the password of an existing login that also holds other roles is managing
 * that user, so each of those roles must be within the caller's ceiling; otherwise a password reset through the
 * passenger / driver login would hand the caller that user's rights. The caller's own login is exempt.
 */
function assertCanSetPassword(actor: LinkActor, user: { id: string; roles: { roleId: string; role: RoleWithGrant }[] }, templateRoleId: string): void {
  if (user.id === actor.userId) return;
  assertRolesWithinCeiling(
    actor,
    user.roles.filter((r) => r.roleId !== templateRoleId).map((r) => r.role),
    (name) => `You cannot set the password of a user who holds the role "${name}": it has rights you do not have yourself`,
  );
}

export interface LinkResult {
  userId: string;
  outcome: 'CREATED' | 'LINKED' | 'REACTIVATED';
  passwordSet: boolean;
  before: Record<string, unknown> | null;
}

/** The company's role of that template, seeding the ETMS templates first when they are missing (idempotent). */
export async function templateRoleId(tx: Tx, companyId: string, roleName: string): Promise<string> {
  return (await templateRole(tx, companyId, roleName)).id;
}

/** The company's role of that template with its grants (for the R-12 check). */
export async function templateRole(tx: Tx, companyId: string, roleName: string): Promise<RoleGrant & { id: string }> {
  await ensureEtmsRoleTemplates(tx, companyId);
  const role = await tx.role.findUnique({ where: { companyId_name: { companyId, name: roleName } }, select: { id: true, ...ROLE_GRANT_SELECT } });
  if (!role) throw new Error(`Role template ${roleName} missing`);
  return role;
}

/**
 * Create or link the login of a passenger / driver (D5, P3). One login per person: email and mobile are globally unique
 * on User, so a contact that belongs to a User of ANOTHER company (or to the Super Admin, or to a User already linked to
 * another profile / driver) is refused with 409 IDENTITY_IN_USE. A User of the SAME company gets the role added (dual
 * role: fleet shell + "My commute"). Runs inside the caller's transaction; a unique-violation race maps to
 * IDENTITY_IN_USE as well.
 */
export async function createOrLinkLogin(tx: Tx, req: LinkRequest): Promise<LinkResult> {
  const role = await templateRole(tx, req.companyId, req.roleName);
  assertLoginTemplateWithinCeiling(req.actor, req.roleName, role);
  const roleId = role.id;
  const passwordHash = req.password ? await hashPassword(req.password) : undefined;

  if (req.currentUserId) {
    const u = await tx.user.findUnique({ where: { id: req.currentUserId }, include: { roles: { include: { role: { select: ROLE_GRANT_SELECT } } } } });
    if (u) {
      const hasRole = u.roles.some((r) => r.roleId === roleId);
      const otherRoles = u.roles.some((r) => r.roleId !== roleId);
      if (!u.isActive && otherRoles) {
        throw new ConflictException({ message: 'This login was disabled in Users; enable it there first', code: 'INVALID_STATE' });
      }
      if (hasRole && u.isActive && !passwordHash) return { userId: u.id, outcome: 'LINKED', passwordSet: !!u.passwordHash, before: null };
      if (passwordHash) assertCanSetPassword(req.actor, u, roleId);
      await tx.user.update({
        where: { id: u.id },
        data: { isActive: true, ...(passwordHash ? { passwordHash } : {}), ...(hasRole ? {} : { roles: { create: [{ roleId }] } }) },
      });
      return { userId: u.id, outcome: 'REACTIVATED', passwordSet: !!(passwordHash ?? u.passwordHash), before: { isActive: u.isActive, roleIds: u.roles.map((r) => r.roleId) } };
    }
  }

  if (!req.email && !req.mobile) throw new ConflictException({ message: 'An email or mobile number is needed for the login', code: 'VALIDATION_FAILED' });
  const or: Prisma.UserWhereInput[] = [];
  if (req.email) or.push({ email: req.email });
  if (req.mobile) or.push({ mobile: req.mobile });
  const found = await tx.user.findMany({ where: { OR: or }, include: { roles: { include: { role: { select: ROLE_GRANT_SELECT } } } } });
  if (found.length > 1) throw identityInUse('The email and the mobile number belong to two different logins');
  if (found.length === 1) {
    const u = found[0];
    if (u.companyId !== req.companyId || u.isSuperAdmin) throw identityInUse();
    if (await req.linkedElsewhere(u.id)) throw identityInUse('This login already belongs to another person');
    const hasRole = u.roles.some((r) => r.roleId === roleId);
    // A disabled login (e.g. one unlinked earlier): re-enable it only when it is a transport-only login; a fleet login
    // disabled in Users stays the Users admin's decision.
    if (!u.isActive && u.roles.some((r) => r.roleId !== roleId)) {
      throw new ConflictException({ message: 'This login was disabled in Users; enable it there first', code: 'INVALID_STATE' });
    }
    if (passwordHash && !u.passwordHash) assertCanSetPassword(req.actor, u, roleId);
    await tx.user.update({
      where: { id: u.id },
      data: { ...(u.isActive ? {} : { isActive: true }), ...(hasRole ? {} : { roles: { create: [{ roleId }] } }), ...(passwordHash && !u.passwordHash ? { passwordHash } : {}) },
    });
    return { userId: u.id, outcome: u.isActive ? 'LINKED' : 'REACTIVATED', passwordSet: !!(u.passwordHash ?? passwordHash), before: u.isActive ? null : { isActive: false, roleIds: u.roles.map((r) => r.roleId) } };
  }

  try {
    const created = await tx.user.create({
      data: {
        companyId: req.companyId,
        name: req.name.slice(0, 100),
        email: req.email,
        mobile: req.mobile,
        passwordHash: passwordHash ?? null,
        roles: { create: [{ roleId }] },
      },
      select: { id: true },
    });
    return { userId: created.id, outcome: 'CREATED', passwordSet: !!passwordHash, before: null };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw identityInUse();
    throw e;
  }
}

/**
 * Disable the role-specific login: a User that also holds other roles only loses this role (its fleet login keeps
 * working); otherwise the User is deactivated and its sessions revoked. The profile / driver link is kept so the
 * login can be re-enabled.
 */
export async function disableLogin(tx: Tx, companyId: string, userId: string, roleName: string): Promise<'ROLE_REMOVED' | 'DEACTIVATED' | 'NONE'> {
  const role = await tx.role.findUnique({ where: { companyId_name: { companyId, name: roleName } }, select: { id: true } });
  const u = await tx.user.findUnique({ where: { id: userId }, include: { roles: true } });
  if (!u) return 'NONE';
  const others = u.roles.filter((r) => r.roleId !== role?.id);
  if (others.length) {
    if (!role) return 'NONE';
    const res = await tx.userRole.deleteMany({ where: { userId, roleId: role.id } });
    return res.count ? 'ROLE_REMOVED' : 'NONE';
  }
  if (!u.isActive) return 'NONE';
  await tx.user.update({ where: { id: userId }, data: { isActive: false } });
  await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return 'DEACTIVATED';
}
