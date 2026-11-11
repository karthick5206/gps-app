import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hashPassword } from '../../common/secrets';
import { ensureEtmsRoleTemplates } from '../etms-role-templates';

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
}

export interface LinkResult {
  userId: string;
  outcome: 'CREATED' | 'LINKED' | 'REACTIVATED';
  passwordSet: boolean;
  before: Record<string, unknown> | null;
}

/** The company's role of that template, seeding the ETMS templates first when they are missing (idempotent). */
export async function templateRoleId(tx: Tx, companyId: string, roleName: string): Promise<string> {
  await ensureEtmsRoleTemplates(tx, companyId);
  const role = await tx.role.findUnique({ where: { companyId_name: { companyId, name: roleName } }, select: { id: true } });
  if (!role) throw new Error(`Role template ${roleName} missing`);
  return role.id;
}

/**
 * Create or link the login of a passenger / driver (D5, P3). One login per person: email and mobile are globally unique
 * on User, so a contact that belongs to a User of ANOTHER company (or to the Super Admin, or to a User already linked to
 * another profile / driver) is refused with 409 IDENTITY_IN_USE. A User of the SAME company gets the role added (dual
 * role: fleet shell + "My commute"). Runs inside the caller's transaction; a unique-violation race maps to
 * IDENTITY_IN_USE as well.
 */
export async function createOrLinkLogin(tx: Tx, req: LinkRequest): Promise<LinkResult> {
  const roleId = await templateRoleId(tx, req.companyId, req.roleName);
  const passwordHash = req.password ? await hashPassword(req.password) : undefined;

  if (req.currentUserId) {
    const u = await tx.user.findUnique({ where: { id: req.currentUserId }, include: { roles: true } });
    if (u) {
      const hasRole = u.roles.some((r) => r.roleId === roleId);
      const otherRoles = u.roles.some((r) => r.roleId !== roleId);
      if (!u.isActive && otherRoles) {
        throw new ConflictException({ message: 'This login was disabled in Users; enable it there first', code: 'INVALID_STATE' });
      }
      if (hasRole && u.isActive && !passwordHash) return { userId: u.id, outcome: 'LINKED', passwordSet: !!u.passwordHash, before: null };
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
  const found = await tx.user.findMany({ where: { OR: or }, include: { roles: true } });
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
