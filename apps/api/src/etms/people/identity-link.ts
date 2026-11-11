import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ETMS_ROLE_TEMPLATES, LOGIN_RESET_TTL_HOURS, maskEmail, maskPhone, type LoginResetDto, type PermissionMap } from '@veetracer/shared';
import { assertRolesWithinCeiling, assertRoleWithinCeiling, type RoleGrant } from '../../access/access-rules';
import type { AuthContext } from '../../access/auth-context';
import type { AuditService } from '../../audit/audit.service';
import { publishSessionsRevoked } from '../../auth/session-revocation';
import { hashPassword, randomToken, sha256 } from '../../common/secrets';
import type { RedisService } from '../../redis/redis.service';
import { ensureEtmsRoleTemplates, templatePermissions } from '../etms-role-templates';

type Tx = Prisma.TransactionClient;

/**
 * One generic message for every IDENTITY_IN_USE case (security review L1): it never says whether the contact belongs to
 * another tenant, to the Super Admin, to another person of this company, or that email and mobile belong to two logins.
 */
export const IDENTITY_IN_USE_MESSAGE = 'This email or mobile number cannot be used for this login. Use another one, or ask your administrator.';
export const identityInUse = () => new ConflictException({ message: IDENTITY_IN_USE_MESSAGE, code: 'IDENTITY_IN_USE' });
export const isIdentityInUse = (e: unknown): boolean => e instanceof ConflictException && (e.getResponse() as { code?: string }).code === 'IDENTITY_IN_USE';

/** IDENTITY_IN_USE refusals one caller may collect per window before further link attempts are refused (429). */
export const IDENTITY_REFUSAL_LIMIT = 10;
export const IDENTITY_REFUSAL_WINDOW_S = 60 * 60;
const refusalKey = (userId: string) => `vt:etms:identity-refusals:${userId}`;

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
  /**
   * Contacts the caller explicitly asked for (as opposed to the profile / driver defaults). With a login already linked,
   * a different requested contact is 409 LOGIN_ALREADY_LINKED (QA B1): the existing login is never silently kept for a
   * new identity; unlink first, then link the other contact.
   */
  requested?: { email?: string | null; mobile?: string | null };
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

export const ROLE_GRANT_SELECT = { name: true, dataScope: true, permissions: { select: { menu: true, actions: true } } } satisfies Prisma.RoleSelect;
export const LOGIN_USER_INCLUDE = { roles: { include: { role: { select: ROLE_GRANT_SELECT } } } } satisfies Prisma.UserInclude;
type RoleWithGrant = Prisma.RoleGetPayload<{ select: typeof ROLE_GRANT_SELECT }>;
export type LoginUser = Prisma.UserGetPayload<{ include: typeof LOGIN_USER_INCLUDE }>;

/**
 * R-12 (as Users' findManageable): setting the password of an existing login that also holds other roles (or issuing
 * its reset token) is managing that user, so each of those roles must be within the caller's ceiling; otherwise a
 * password reset through the passenger / driver login would hand the caller that user's rights. The caller's own login
 * is exempt.
 */
export function assertCanSetPassword(actor: LinkActor, user: { id: string; roles: { roleId: string; role: RoleWithGrant }[] }, templateRoleId: string | null): void {
  if (user.id === actor.userId) return;
  assertRolesWithinCeiling(
    actor,
    user.roles.filter((r) => r.roleId !== templateRoleId).map((r) => r.role),
    (name) => `You cannot set the password of a user who holds the role "${name}": it has rights you do not have yourself`,
  );
}

/**
 * Security review M1 / QA B1-B2: an admin / dispatcher may choose only the INITIAL password of a login: one that has
 * never signed in and has no password yet. A password is never overwritten through this path (not even silently
 * ignored): 409 PASSWORD_RESET_REQUIRED, and the person sets their own password through a one-time reset token
 * (issueLoginReset).
 */
export function assertPasswordNotYetUsed(user: { lastLoginAt: Date | null; passwordHash?: string | null }): void {
  if (user.lastLoginAt || user.passwordHash) {
    throw new ConflictException({
      message: user.lastLoginAt
        ? 'This login has already been used, so you cannot choose its password. Create a reset link instead: the person then sets their own password.'
        : 'This login already has a password, so you cannot replace it here. Create a reset link instead: the person then sets their own password.',
      code: 'PASSWORD_RESET_REQUIRED',
    });
  }
}

/** `what` of the audit entries ETMS writes when it deactivates a transport-only login. */
export const ETMS_LOGIN_DISABLE_WHATS = ['passenger-login-disabled', 'passenger-login-unlinked', 'passenger-archived', 'driver-login-disabled', 'driver-login-unlinked', 'driver-deactivated'];

/**
 * Security review L2: re-linking may re-enable a disabled login only when ETMS itself disabled it: the login holds
 * exactly the template role, and the latest UPDATE audit entry of the User is an ETMS disable that deactivated it. A
 * login a Users admin disabled (or changed since), one with no roles or with other roles stays disabled: 409
 * INVALID_STATE, a Users admin must enable it explicitly.
 */
async function assertEtmsMayReenable(tx: Tx, u: LoginUser, roleId: string): Promise<void> {
  const refuse = () => new ConflictException({ message: 'This login was disabled in Users. A Users administrator must enable it there first.', code: 'INVALID_STATE' });
  if (u.roles.length === 0 || u.roles.some((r) => r.roleId !== roleId)) throw refuse();
  const entries = await tx.auditLog.findMany({ where: { entityId: u.id, entity: { in: ['User', 'user'] }, action: 'UPDATE' }, select: { entity: true, changes: true, createdAt: true } });
  const latest = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.createdAt.getTime() - a.e.createdAt.getTime() || b.i - a.i)[0]?.e;
  const c = (latest?.changes ?? null) as { what?: unknown; outcome?: unknown } | null;
  const byEtms = latest?.entity === 'User' && typeof c?.what === 'string' && ETMS_LOGIN_DISABLE_WHATS.includes(c.what) && c.outcome === 'DEACTIVATED';
  if (!byEtms) throw refuse();
}

export interface LinkResult {
  userId: string;
  outcome: 'CREATED' | 'LINKED' | 'REACTIVATED';
  passwordSet: boolean;
  /** The password was set / replaced by this call (only possible before the login's first sign-in). */
  passwordChanged: boolean;
  /** Sessions of an existing login were revoked (password change or re-enable): publish G5 after the commit. */
  sessionsRevoked: boolean;
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
 * another profile / driver) is refused with 409 IDENTITY_IN_USE (one generic message). A User of the SAME company gets
 * the role added (dual role: fleet shell + "My commute"). A password is accepted only while the login has never signed
 * in (M1). Runs inside the caller's transaction; a unique-violation race maps to IDENTITY_IN_USE as well.
 */
export async function createOrLinkLogin(tx: Tx, req: LinkRequest): Promise<LinkResult> {
  const role = await templateRole(tx, req.companyId, req.roleName);
  assertLoginTemplateWithinCeiling(req.actor, req.roleName, role);
  const roleId = role.id;

  const linkExisting = async (u: LoginUser, viaCurrentLink: boolean): Promise<LinkResult> => {
    // Defence in depth (L2): the linked login must still be a plain login of the same company.
    if (u.companyId !== req.companyId || u.isSuperAdmin) throw identityInUse();
    const hasRole = u.roles.some((r) => r.roleId === roleId);
    if (viaCurrentLink) {
      const differs = (k: 'email' | 'mobile') => req.requested?.[k] !== undefined && (req.requested[k] ?? null) !== (u[k] ?? null);
      if (differs('email') || differs('mobile')) {
        throw new ConflictException({ message: 'This person already has a login with other contact details. To use another email or mobile, unlink the current login first.', code: 'LOGIN_ALREADY_LINKED' });
      }
    }
    if (!u.isActive) await assertEtmsMayReenable(tx, u, roleId);
    if (req.password) {
      assertCanSetPassword(req.actor, u, roleId);
      assertPasswordNotYetUsed(u);
    }
    if (hasRole && u.isActive && !req.password) return { userId: u.id, outcome: 'LINKED', passwordSet: !!u.passwordHash, passwordChanged: false, sessionsRevoked: false, before: null };
    const passwordHash = req.password ? await hashPassword(req.password) : undefined;
    await tx.user.update({
      where: { id: u.id },
      data: { ...(u.isActive ? {} : { isActive: true }), ...(passwordHash ? { passwordHash } : {}), ...(hasRole ? {} : { roles: { create: [{ roleId }] } }) },
    });
    const sessionsRevoked = !!passwordHash || !u.isActive;
    if (sessionsRevoked) await revokeUserSessions(tx, u.id);
    const reactivated = !u.isActive || (viaCurrentLink && !hasRole);
    return {
      userId: u.id,
      outcome: reactivated ? 'REACTIVATED' : 'LINKED',
      passwordSet: !!(passwordHash ?? u.passwordHash),
      passwordChanged: !!passwordHash,
      sessionsRevoked,
      before: reactivated ? { isActive: u.isActive, roleIds: u.roles.map((r) => r.roleId) } : null,
    };
  };

  if (req.currentUserId) {
    const u = await tx.user.findUnique({ where: { id: req.currentUserId }, include: LOGIN_USER_INCLUDE });
    if (u) return linkExisting(u, true);
  }

  if (!req.email && !req.mobile) throw new ConflictException({ message: 'An email or mobile number is needed for the login', code: 'VALIDATION_FAILED' });
  const or: Prisma.UserWhereInput[] = [];
  if (req.email) or.push({ email: req.email });
  if (req.mobile) or.push({ mobile: req.mobile });
  const found = await tx.user.findMany({ where: { OR: or }, include: LOGIN_USER_INCLUDE });
  if (found.length > 1) throw identityInUse();
  if (found.length === 1) {
    const u = found[0];
    if (u.companyId !== req.companyId || u.isSuperAdmin) throw identityInUse();
    if (await req.linkedElsewhere(u.id)) throw identityInUse();
    return linkExisting(u, false);
  }

  const passwordHash = req.password ? await hashPassword(req.password) : undefined;
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
    return { userId: created.id, outcome: 'CREATED', passwordSet: !!passwordHash, passwordChanged: !!passwordHash, sessionsRevoked: false, before: null };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw identityInUse();
    throw e;
  }
}

/** Revoke every open session of the user in the database (publish G5 with publishLoginRevocation after the commit). */
export async function revokeUserSessions(tx: Tx, userId: string): Promise<number> {
  const res = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return res.count;
}

/** G5 (R-14): close the user's live sockets on every API instance now (the existing publish path). Never throws. */
export async function publishLoginRevocation(redis: Partial<Pick<RedisService, 'client'>> | undefined, userId: string): Promise<void> {
  if (!redis?.client) return;
  await publishSessionsRevoked(redis as Pick<RedisService, 'client'>, { userId });
}

/**
 * Disable the role-specific login: a User that also holds other roles only loses this role (its fleet login keeps
 * working); otherwise the User is deactivated. Either way every session of the User is revoked (security review M1:
 * any disable / unlink signs the login out; publish G5 after the commit). The profile / driver link is kept so the
 * login can be re-enabled.
 */
export async function disableLogin(tx: Tx, companyId: string, userId: string, roleName: string): Promise<'ROLE_REMOVED' | 'DEACTIVATED' | 'NONE'> {
  const role = await tx.role.findUnique({ where: { companyId_name: { companyId, name: roleName } }, select: { id: true } });
  const u = await tx.user.findUnique({ where: { id: userId }, include: { roles: true } });
  if (!u) return 'NONE';
  await revokeUserSessions(tx, userId);
  const others = u.roles.filter((r) => r.roleId !== role?.id);
  if (others.length) {
    if (!role) return 'NONE';
    const res = await tx.userRole.deleteMany({ where: { userId, roleId: role.id } });
    return res.count ? 'ROLE_REMOVED' : 'NONE';
  }
  if (!u.isActive) return 'NONE';
  await tx.user.update({ where: { id: userId }, data: { isActive: false } });
  return 'DEACTIVATED';
}

/**
 * M1: a one-time reset token for an existing login, handed over by the admin; the person redeems it at
 * /reset-password (AuthService.resetPassword sets their own password and revokes every session). Earlier unused tokens
 * of the login are cancelled. There is no admin-chosen password once the login was used.
 */
export async function issueLoginReset(tx: Tx, userId: string, now = Date.now()): Promise<LoginResetDto> {
  await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date(now) } });
  const token = randomToken(32);
  const expiresAt = new Date(now + LOGIN_RESET_TTL_HOURS * 3600_000);
  await tx.passwordReset.create({ data: { userId, tokenHash: sha256(token), expiresAt } });
  return { token, path: `/reset-password?token=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString() };
}

/**
 * L1: before a link attempt, refuse callers that already collected IDENTITY_REFUSAL_LIMIT refusals in the window (429
 * IDENTITY_RATE_LIMITED), so the generic IDENTITY_IN_USE answer cannot be used as a bulk email / mobile oracle. Without
 * Valkey the budget is not enforced (refusals are still audited).
 */
export async function assertIdentityProbeBudget(redis: Partial<Pick<RedisService, 'client'>> | undefined, actorUserId: string): Promise<void> {
  let count = 0;
  try {
    count = Number(await redis?.client?.get(refusalKey(actorUserId))) || 0;
  } catch {
    return;
  }
  if (count >= IDENTITY_REFUSAL_LIMIT) {
    throw new HttpException({ message: 'Too many logins could not be created with the contacts given. Try again later.', code: 'IDENTITY_RATE_LIMITED' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * L1: audit an IDENTITY_IN_USE refusal (outside the rolled-back transaction) and count it against the caller. The audit
 * keeps the contacts masked: it shows that someone probed, not a list of the addresses that exist.
 */
export async function noteIdentityRefusal(
  redis: Partial<Pick<RedisService, 'client'>> | undefined,
  audit: Pick<AuditService, 'record'>,
  ctx: AuthContext,
  entry: { entity: string; entityId: string; what: string; email: string | null; mobile: string | null },
): Promise<void> {
  let refusals: number | null = null;
  try {
    const key = refusalKey(ctx.userId);
    refusals = (await redis?.client?.incr(key)) ?? null;
    if (refusals === 1) await redis?.client?.expire(key, IDENTITY_REFUSAL_WINDOW_S);
  } catch {
    refusals = null;
  }
  await audit.record(ctx, {
    action: 'UPDATE',
    entity: entry.entity,
    entityId: entry.entityId,
    details: { what: entry.what, refused: 'IDENTITY_IN_USE', email: maskEmail(entry.email), mobile: maskPhone(entry.mobile), ...(refusals !== null ? { refusalsInWindow: refusals } : {}) },
  });
}
