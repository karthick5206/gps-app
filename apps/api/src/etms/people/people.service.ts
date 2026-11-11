import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ETMS_PASSENGER_ROLE_NAME,
  ROUTING_CONSENT_PURPOSE,
  currentConsents,
  normaliseEmail,
  normalisePhone,
  phoneCountryForTimezone,
  validHomePoint,
  type AuditLogDto,
  type ConsentChannel,
  type LoginRemovalMode,
  type ConsentRecordDto,
  type GeocodeCandidate,
  type PassengerAppAccessResult,
  type PassengerConsentsDto,
  type PassengerDto,
  type PassengerPickupDto,
} from '@veetracer/shared';
import { createHash, randomBytes } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { transportNotFound } from '../../access/transport-scope';
import { AuditService } from '../../audit/audit.service';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { GeocodingService } from '../../geocoding/geocoding.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ConsentNoticeService } from './consent-notice.service';
import { createOrLinkLogin, disableLogin } from './identity-link';
import { redactHistoryEntry } from './passenger-history';
import {
  PASSENGER_INCLUDE,
  accessibilityOf,
  canWritePassenger,
  ownPassengerWhere,
  passengerReadWhere,
  passengerView,
  pickupOf,
  providerPassengerAccess,
  toPassengerDto,
  type ConsentRowLike,
  type PassengerRow,
  type PassengerView,
} from './people-access';
import { CreatePassengerDto, PassengerAppAccessDto, PassengerListQuery, RecordConsentDto, UpdatePassengerDto } from './people.dto';

export const PROFILE_ENTITY = 'EmployeeTransportProfile';
export const CONSENT_ENTITY = 'EmployeeTransportConsent';
type Db = PrismaService | Prisma.TransactionClient;

const LIST_SORT = { displayName: 'displayName', employeeCode: 'employeeCode', createdAt: 'createdAt', updatedAt: 'updatedAt' };

const CSV: CsvSpec<PassengerDto> = {
  name: 'transport-passengers',
  columns: [
    { header: 'Employee code', value: (p) => p.employeeCode },
    { header: 'Name', value: (p) => p.displayName },
    { header: 'Active', value: (p) => (p.isActive ? 'yes' : 'no') },
    { header: 'Branch', value: (p) => p.branchName ?? '' },
    { header: 'Office', value: (p) => p.office?.name ?? '' },
    { header: 'Default stop', value: (p) => p.defaultStop?.name ?? '' },
    { header: 'Mobile', value: (p) => p.mobile ?? '' },
    { header: 'Email', value: (p) => p.email ?? '' },
    { header: 'Home address', value: (p) => p.home?.address ?? '' },
    { header: 'Home lat', value: (p) => p.home?.lat ?? '' },
    { header: 'Home lng', value: (p) => p.home?.lng ?? '' },
    { header: 'Location source', value: (p) => p.home?.source ?? '' },
    { header: 'Needs location', value: (p) => (p.needsLocation ? 'yes' : 'no') },
    { header: 'Routing consent', value: (p) => (p.routingConsent ? 'yes' : 'no') },
    { header: 'Wheelchair', value: (p) => (p.accessibility?.wheelchair ? 'yes' : '') },
    { header: 'App access', value: (p) => (p.appAccess?.active ? 'yes' : 'no') },
  ],
};

/** Per-process salt: audit diffs show that a sensitive field changed without storing its value (PD H minimisation). */
const AUDIT_SALT = randomBytes(16).toString('hex');
const redact = (v: unknown): string | null => (v === null || v === undefined ? null : `changed:${createHash('sha256').update(AUDIT_SALT + JSON.stringify(v)).digest('hex').slice(0, 10)}`);

/** Audit snapshot of a profile with the high-class personal data (home, health, emergency contacts) redacted. */
export function profileSnapshot(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && ['branch', 'officePoi', 'defaultStop', 'user'].includes(k)) continue;
    out[k] = ['homeAddress', 'homeLat', 'homeLng', 'accessibility', 'emergencyContacts'].includes(k) ? redact(v) : v;
  }
  return out;
}

const err = (code: string, message: string) => ({ message, code });
const invalid = (message: string) => new BadRequestException(err('VALIDATION_FAILED', message));
const duplicate = (message: string) => new ConflictException(err('PASSENGER_DUPLICATE', message));
const forbidden = (message: string) => new ForbiddenException(err('FORBIDDEN_GRANT', message));

/** Latest consent row per (profile, purpose) for the given profiles. */
export async function latestConsents(db: Db, profileIds: string[]): Promise<Map<string, ConsentRowLike[]>> {
  const out = new Map<string, ConsentRowLike[]>();
  if (!profileIds.length) return out;
  const rows = await db.$queryRaw<(ConsentRowLike & { profileId: string })[]>`
    SELECT DISTINCT ON ("profileId", "purpose") "profileId", "purpose", "granted", "noticeVersion", "channel", "occurredAt"
    FROM "EmployeeTransportConsent" WHERE "profileId" = ANY(${profileIds}::uuid[])
    ORDER BY "profileId", "purpose", "occurredAt" DESC`;
  for (const r of rows) (out.get(r.profileId) ?? out.set(r.profileId, []).get(r.profileId)!).push(r);
  return out;
}

/** Profiles (of the given companies) whose latest TRANSPORT_PROFILE consent row is a grant. */
async function routingConsentIds(db: Db, companyIds: string[]): Promise<string[]> {
  if (!companyIds.length) return [];
  const rows = await db.$queryRaw<{ profileId: string }[]>`
    SELECT "profileId" FROM (
      SELECT DISTINCT ON ("profileId") "profileId", "granted" FROM "EmployeeTransportConsent"
      WHERE "companyId" = ANY(${companyIds}::uuid[]) AND "purpose" = ${ROUTING_CONSENT_PURPOSE}
      ORDER BY "profileId", "occurredAt" DESC
    ) t WHERE "granted"`;
  return rows.map((r) => r.profileId);
}

export interface AccessReason {
  reason?: string | null;
}

/**
 * Passengers of the corporate customer (E2; docs 05 §2.2, 02 §4.3 / §7, 10 §2 / §4, 15 §4). Reads are scoped and
 * projected by people-access.ts; every write is audited in its transaction; sensitive reads (detail with contacts /
 * home, CSV export, consent history) write AuditAction ACCESS, under the data owner's company when a provider reads.
 */
@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly geocoding: GeocodingService,
    private readonly notices: ConsentNoticeService,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  async list(ctx: AuthContext, query: PassengerListQuery, access: AccessReason = {}) {
    const own = ownPassengerWhere(ctx);
    const plan = planList<Prisma.EmployeeTransportProfileWhereInput, Prisma.EmployeeTransportProfileOrderByWithRelationInput>(query, {
      // Contacts are searchable only inside the caller's own company (no contact enumeration by providers).
      search: (q) => ({
        OR: [
          { displayName: { contains: q, mode: 'insensitive' } },
          { employeeCode: { contains: q, mode: 'insensitive' } },
          { AND: [own, { OR: [{ email: { contains: q, mode: 'insensitive' } }, { mobile: { contains: q } }] }] },
        ],
      }),
      sort: LIST_SORT,
      defaultSort: 'displayName',
    } satisfies ListSpec);
    const filters: Prisma.EmployeeTransportProfileWhereInput[] = [passengerReadWhere(ctx), plan.where];
    if (query.siteId) filters.push({ officePoiId: query.siteId });
    if (query.branchId) filters.push({ branchId: query.branchId });
    if (query.needsLocation === 'true') filters.push({ isActive: true, homeLat: null, defaultStopPoiId: null });
    if (query.needsLocation === 'false') filters.push({ OR: [{ homeLat: { not: null } }, { defaultStopPoiId: { not: null } }] });
    if (query.appAccess === 'true') filters.push({ userId: { not: null } });
    if (query.appAccess === 'false') filters.push({ userId: null });
    if (query.routingConsent) {
      const companies = [ctx.companyId, ...providerPassengerAccess(ctx).map((p) => p.customerCompanyId)];
      const ids = await routingConsentIds(this.prisma, companies);
      filters.push(query.routingConsent === 'true' ? { id: { in: ids } } : { id: { notIn: ids } });
    }
    const where: Prisma.EmployeeTransportProfileWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employeeTransportProfile.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: PASSENGER_INCLUDE }),
      this.prisma.employeeTransportProfile.count({ where }),
    ]);
    const consents = await latestConsents(this.prisma, rows.map((r) => r.id));
    const now = Date.now();
    const items = rows.flatMap((r) => {
      const view = passengerView(ctx, r, now);
      return view ? [toPassengerDto(r, view, consents.get(r.id) ?? [], plan.csv)] : [];
    });
    if (plan.csv) {
      await this.audit.record(ctx, {
        action: 'ACCESS',
        entity: PROFILE_ENTITY,
        details: { what: 'csv-export', rows: items.length, projections: [...new Set(items.map((i) => i.projection))], ...(access.reason ? { reason: access.reason } : {}) },
      });
    }
    return listResult(plan, items, total, CSV);
  }

  /** Detail (contacts in clear for FULL / STANDARD, home address for FULL): audited as a sensitive read. */
  async get(ctx: AuthContext, id: string, access: AccessReason = {}): Promise<PassengerDto> {
    const { row, view } = await this.findVisible(ctx, id);
    const consents = await latestConsents(this.prisma, [row.id]);
    const dto = toPassengerDto(row, view, consents.get(row.id) ?? [], true);
    await this.auditAccess(ctx, row, view, 'detail', access);
    return dto;
  }

  /** Consent history (corporate admin of the passenger's company only, doc 05 §6). */
  async consents(ctx: AuthContext, id: string, access: AccessReason = {}): Promise<PassengerConsentsDto> {
    const { row, view } = await this.findVisible(ctx, id);
    if (view.projection !== 'FULL') throw forbidden('Only the corporate admin can see consent records');
    const dto = await this.consentHistory(row.id);
    await this.auditAccess(ctx, row, view, 'consent-history', access);
    return dto;
  }

  /**
   * The passenger's history from the audit log (profile changes, consent records, login changes; sensitive reads for
   * the corporate admin), redacted per view level by passenger-history.ts. Audited as a read.
   */
  async history(ctx: AuthContext, id: string, access: AccessReason = {}): Promise<AuditLogDto[]> {
    const { row, view } = await this.findVisible(ctx, id);
    const or: Prisma.AuditLogWhereInput[] = [{ entity: PROFILE_ENTITY, entityId: row.id }];
    if (view.projection !== 'MINIMAL') {
      const consentIds = (await this.prisma.employeeTransportConsent.findMany({ where: { profileId: row.id }, select: { id: true } })).map((c) => c.id);
      if (consentIds.length) or.push({ entity: CONSENT_ENTITY, entityId: { in: consentIds } });
      // Login changes are audited on the User with the passenger id in the details (or the CREATE diff).
      or.push({ entity: 'User', changes: { path: ['passengerId'], equals: row.id } });
      or.push({ entity: 'User', changes: { path: ['passengerId', 'to'], equals: row.id } });
    }
    const rows = await this.prisma.auditLog.findMany({
      where: { companyId: row.companyId, OR: or, ...(view.projection === 'FULL' ? {} : { action: { not: 'ACCESS' } }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 300,
    });
    const consents = await latestConsents(this.prisma, [row.id]);
    const routingConsent = currentConsents(consents.get(row.id) ?? []).find((c) => c.purpose === ROUTING_CONSENT_PURPOSE)?.active ?? false;
    const h = { view, routingConsent, profileEntity: PROFILE_ENTITY };
    const out = (await this.audit.toDtos(rows)).flatMap((e) => {
      const r = redactHistoryEntry(e, h);
      return r ? [r] : [];
    });
    await this.auditAccess(ctx, row, view, 'history', access);
    return out;
  }

  /** Photon candidates for an address (self-hosted only; [] when no geocoder is configured). */
  geocode(q: string): Promise<GeocodeCandidate[]> {
    return this.geocoding.search(q.slice(0, 120));
  }

  /**
   * Pickup points routing may use (E3 / E4 entry point): active passengers of `customerCompanyId` with an ACTIVE
   * TRANSPORT_PROFILE consent only (doc 02 §7.3); others are absent from the map. Full precision (internal use).
   */
  async routingPickups(customerCompanyId: string, profileIds: string[]): Promise<Map<string, PassengerPickupDto>> {
    const rows = await this.prisma.employeeTransportProfile.findMany({
      where: { companyId: customerCompanyId, id: { in: profileIds }, isActive: true },
      select: { id: true, homeLat: true, homeLng: true, defaultStop: { select: { id: true, name: true, lat: true, lng: true } } },
    });
    const consents = await latestConsents(this.prisma, rows.map((r) => r.id));
    const out = new Map<string, PassengerPickupDto>();
    for (const r of rows) {
      const active = currentConsents(consents.get(r.id) ?? []).find((c) => c.purpose === ROUTING_CONSENT_PURPOSE)?.active ?? false;
      const p = pickupOf(r, active, 'FULL');
      if (p) out.set(r.id, p);
    }
    return out;
  }

  // ───────────────────────────── writes ─────────────────────────────

  async create(ctx: AuthContext, dto: CreatePassengerDto): Promise<PassengerDto> {
    const data = await this.prepare(ctx, dto, null, ctx.dataScope === 'COMPANY' ? 'FULL' : 'STANDARD');
    const employeeCode = dto.employeeCode.trim();
    await this.assertUnique(ctx.companyId, null, employeeCode, data.email ?? null, data.mobile ?? null);
    if (ctx.dataScope !== 'COMPANY' && !data.branchId) throw forbidden('Choose one of your branches');
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.employeeTransportProfile
        .create({ data: { ...data, companyId: ctx.companyId, employeeCode, createdById: ctx.userId } as Prisma.EmployeeTransportProfileUncheckedCreateInput, include: PASSENGER_INCLUDE })
        .catch((e: unknown) => {
          throw this.duplicateOr(e);
        });
      await this.audit.record(ctx, { action: 'CREATE', entity: PROFILE_ENTITY, entityId: created.id, after: profileSnapshot(created) }, tx);
      return created;
    });
    return toPassengerDto(row, passengerView(ctx, row) ?? { projection: 'FULL', contact: 'CLEAR', agreementId: null }, [], true);
  }

  async update(ctx: AuthContext, id: string, dto: UpdatePassengerDto): Promise<PassengerDto> {
    const { row: before, view } = await this.findWritable(ctx, id);
    const data = await this.prepare(ctx, dto, before, view.projection);
    const employeeCode = dto.employeeCode?.trim();
    if (employeeCode !== undefined) data.employeeCode = employeeCode;
    const email = data.email === undefined ? before.email : data.email;
    const mobile = data.mobile === undefined ? before.mobile : data.mobile;
    await this.assertUnique(before.companyId, before.id, employeeCode ?? before.employeeCode, (data.isActive ?? before.isActive) ? email : null, (data.isActive ?? before.isActive) ? mobile : null);
    const row = await this.prisma.$transaction(async (tx) => {
      const after = await tx.employeeTransportProfile
        .update({ where: { id }, data: data as Prisma.EmployeeTransportProfileUncheckedUpdateInput, include: PASSENGER_INCLUDE })
        .catch((e: unknown) => {
          throw this.duplicateOr(e);
        });
      await this.audit.record(ctx, { action: 'UPDATE', entity: PROFILE_ENTITY, entityId: id, before: profileSnapshot(before), after: profileSnapshot(after) }, tx);
      if (data.isActive === false && before.isActive && after.userId) await disableLogin(tx, after.companyId, after.userId, ETMS_PASSENGER_ROLE_NAME);
      return after;
    });
    if (data.isActive === false && before.userId) await this.redis.invalidateCache('user').catch(() => undefined);
    const consents = await latestConsents(this.prisma, [row.id]);
    return toPassengerDto(row, view, consents.get(row.id) ?? [], true);
  }

  /** DELETE = archive (doc 15 §1.1: masters are archived, never deleted); the passenger login is disabled too. */
  async archive(ctx: AuthContext, id: string): Promise<PassengerDto> {
    return this.update(ctx, id, { isActive: false });
  }

  // ───────────────────────────── app access (D5, P3) ─────────────────────────────

  async grantAppAccess(ctx: AuthContext, id: string, dto: PassengerAppAccessDto): Promise<PassengerAppAccessResult> {
    const { row, view } = await this.findWritable(ctx, id);
    if (!row.isActive) throw new ConflictException(err('INVALID_STATE', 'Reactivate the passenger first'));
    const country = await this.country(row.companyId);
    const email = dto.email === undefined ? row.email : dto.email === null ? null : normaliseEmail(dto.email);
    if (dto.email && !email) throw invalid('Invalid email address');
    const mobile = dto.mobile === undefined ? row.mobile : dto.mobile === null ? null : normalisePhone(dto.mobile, country);
    if (dto.mobile && !mobile) throw invalid('Invalid mobile number');
    const result = await this.prisma.$transaction(async (tx) => {
      const link = await createOrLinkLogin(tx, {
        companyId: row.companyId,
        name: row.displayName,
        email,
        mobile,
        password: dto.password,
        roleName: ETMS_PASSENGER_ROLE_NAME,
        currentUserId: row.userId,
        linkedElsewhere: async (userId) => (await tx.employeeTransportProfile.count({ where: { userId, NOT: { id: row.id } } })) > 0,
      });
      if (row.userId !== link.userId) await tx.employeeTransportProfile.update({ where: { id: row.id }, data: { userId: link.userId } });
      if (link.outcome === 'CREATED') await this.audit.record(ctx, { action: 'CREATE', entity: 'User', entityId: link.userId, after: { name: row.displayName, email, mobile, role: ETMS_PASSENGER_ROLE_NAME, passengerId: row.id } }, tx);
      else await this.audit.record(ctx, { action: 'UPDATE', entity: 'User', entityId: link.userId, details: { what: 'passenger-login', outcome: link.outcome, passengerId: row.id, passwordChanged: !!dto.password } }, tx);
      await this.audit.record(ctx, { action: 'UPDATE', entity: PROFILE_ENTITY, entityId: row.id, before: { userId: row.userId }, after: { userId: link.userId } }, tx);
      return link;
    });
    await this.redis.invalidateCache('user').catch(() => undefined);
    const fresh = await this.prisma.employeeTransportProfile.findUniqueOrThrow({ where: { id: row.id }, include: PASSENGER_INCLUDE });
    const consents = await latestConsents(this.prisma, [row.id]);
    return { passenger: toPassengerDto(fresh, view, consents.get(row.id) ?? [], true), outcome: result.outcome, invite: { channel: 'MANUAL', passwordSet: result.passwordSet } };
  }

  /**
   * Remove the passenger's login (LoginRemovalMode): `disable` (default) keeps the link so the login can be enabled
   * again; `unlink` also clears profile.userId so another login can be created or linked. The User is never deleted.
   */
  async revokeAppAccess(ctx: AuthContext, id: string, mode: LoginRemovalMode = 'disable'): Promise<PassengerDto> {
    const { row, view } = await this.findWritable(ctx, id);
    if (!row.userId) throw new ConflictException(err('INVALID_STATE', 'This passenger has no login'));
    const userId = row.userId;
    await this.prisma.$transaction(async (tx) => {
      const outcome = await disableLogin(tx, row.companyId, userId, ETMS_PASSENGER_ROLE_NAME);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'User', entityId: userId, details: { what: mode === 'unlink' ? 'passenger-login-unlinked' : 'passenger-login-disabled', outcome, passengerId: row.id } }, tx);
      if (mode === 'unlink') {
        await tx.employeeTransportProfile.update({ where: { id: row.id }, data: { userId: null } });
        await this.audit.record(ctx, { action: 'UPDATE', entity: PROFILE_ENTITY, entityId: row.id, before: { userId }, after: { userId: null } }, tx);
      }
    });
    await this.redis.invalidateCache('user').catch(() => undefined);
    const fresh = await this.prisma.employeeTransportProfile.findUniqueOrThrow({ where: { id: row.id }, include: PASSENGER_INCLUDE });
    const consents = await latestConsents(this.prisma, [row.id]);
    return toPassengerDto(fresh, view, consents.get(row.id) ?? [], true);
  }

  // ───────────────────────────── consent (doc 10 §4.2) ─────────────────────────────

  /** Corporate admin records a grant / withdrawal on the passenger's behalf (channel ADMIN_ON_BEHALF). */
  async recordConsentOnBehalf(ctx: AuthContext, id: string, dto: RecordConsentDto): Promise<PassengerConsentsDto> {
    const { row, view } = await this.findWritable(ctx, id);
    if (view.projection !== 'FULL') throw forbidden('Only the corporate admin can record consent on behalf of a passenger');
    await this.recordConsent(ctx, row, dto, 'ADMIN_ON_BEHALF');
    return this.consentHistory(row.id);
  }

  /** The signed-in passenger's own profile (MeTransport, doc 02 §4.2): 403 NOT_A_PASSENGER without an active one. */
  async myProfileRow(ctx: AuthContext): Promise<PassengerRow> {
    const row = await this.prisma.employeeTransportProfile.findFirst({ where: { userId: ctx.userId, companyId: ctx.companyId, isActive: true }, include: PASSENGER_INCLUDE });
    if (!row) throw new ForbiddenException(err('NOT_A_PASSENGER', 'You are not registered as a transport passenger'));
    return row;
  }

  async myConsents(ctx: AuthContext): Promise<PassengerConsentsDto> {
    const row = await this.myProfileRow(ctx);
    return this.consentHistory(row.id);
  }

  /** The notices the signed-in passenger is asked to agree to (current version per purpose). */
  async myNotices(ctx: AuthContext) {
    const row = await this.myProfileRow(ctx);
    return this.notices.currentAll(row.companyId);
  }

  async recordMyConsent(ctx: AuthContext, dto: RecordConsentDto, channel: ConsentChannel = 'WEB'): Promise<PassengerConsentsDto> {
    const row = await this.myProfileRow(ctx);
    await this.recordConsent(ctx, row, dto, channel);
    return this.consentHistory(row.id);
  }

  /**
   * Append one evidence row. A grant records the company's CURRENT notice version for the purpose (doc 10 §4.2): no
   * notice → 409 CONSENT_NOTICE_MISSING; the client showed another version → 409 CONSENT_NOTICE_OUTDATED. A withdrawal
   * records the version of the grant it withdraws. A grant that repeats the current grant on the same version, or a
   * withdrawal of a consent that is not active, writes nothing (idempotent); history is never rewritten.
   */
  private async recordConsent(ctx: AuthContext, row: PassengerRow, dto: RecordConsentDto, channel: ConsentChannel): Promise<void> {
    const current = currentConsents((await latestConsents(this.prisma, [row.id])).get(row.id) ?? []).find((c) => c.purpose === dto.purpose);
    let noticeVersion: string;
    if (dto.granted) {
      const notice = await this.notices.current(row.companyId, dto.purpose);
      if (!notice) throw new ConflictException(err('CONSENT_NOTICE_MISSING', 'Publish the consent notice for this purpose in Transport settings first'));
      if (dto.noticeVersion && dto.noticeVersion.trim() !== notice.version) {
        throw new ConflictException({ ...err('CONSENT_NOTICE_OUTDATED', 'The notice has changed since it was shown. Read the current notice and try again.'), currentVersion: notice.version });
      }
      noticeVersion = notice.version;
      if (current?.active && current.noticeVersion === noticeVersion) return;
    } else {
      if (!current?.active) return;
      noticeVersion = current.noticeVersion ?? dto.noticeVersion?.trim() ?? '-';
    }
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.employeeTransportConsent.create({
        data: {
          companyId: row.companyId,
          profileId: row.id,
          subjectUserId: row.userId,
          actorUserId: ctx.userId,
          purpose: dto.purpose,
          noticeVersion,
          locale: dto.locale ?? null,
          granted: dto.granted,
          channel,
          ip: ctx.ip,
        },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: CONSENT_ENTITY, entityId: created.id, after: { profileId: row.id, purpose: dto.purpose, granted: dto.granted, noticeVersion: created.noticeVersion, channel } }, tx);
    });
  }

  private async consentHistory(profileId: string): Promise<PassengerConsentsDto> {
    const rows = await this.prisma.employeeTransportConsent.findMany({ where: { profileId }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 500 });
    const history: ConsentRecordDto[] = rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      granted: r.granted,
      noticeVersion: r.noticeVersion,
      locale: r.locale,
      channel: r.channel,
      subjectUserId: r.subjectUserId,
      actorUserId: r.actorUserId,
      occurredAt: r.occurredAt.toISOString(),
    }));
    return { current: currentConsents(rows), history };
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async findVisible(ctx: AuthContext, id: string): Promise<{ row: PassengerRow; view: PassengerView }> {
    const row = await this.prisma.employeeTransportProfile.findFirst({ where: { AND: [{ id }, passengerReadWhere(ctx)] }, include: PASSENGER_INCLUDE });
    const view = row ? passengerView(ctx, row) : null;
    if (!row || !view) throw transportNotFound('Passenger not found');
    return { row, view };
  }

  /** Own-company row inside the caller's scope; a provider-visible row is 403 (read-only), anything else 404. */
  private async findWritable(ctx: AuthContext, id: string): Promise<{ row: PassengerRow; view: PassengerView }> {
    const { row, view } = await this.findVisible(ctx, id);
    if (!canWritePassenger(ctx, row)) throw forbidden('Passengers can only be changed by their own company');
    return { row, view };
  }

  private async auditAccess(ctx: AuthContext, row: PassengerRow, view: PassengerView, what: string, access: AccessReason): Promise<void> {
    const details = {
      what,
      projection: view.projection,
      ...(view.agreementId ? { agreementId: view.agreementId, actingCompanyId: ctx.companyId } : {}),
      ...(ctx.isSuperAdmin ? { superAdmin: true } : {}),
      ...(access.reason ? { reason: access.reason.slice(0, 300) } : {}),
    };
    const entry = { action: 'ACCESS' as const, entity: PROFILE_ENTITY, entityId: row.id, details };
    // Provider reads are logged in the data owner's (customer's) audit log, visible to its admin (doc 05 §6).
    if (row.companyId === ctx.companyId) await this.audit.record(ctx, entry);
    else await this.audit.recordSystem({ companyId: row.companyId, userId: ctx.userId, ip: ctx.ip }, entry);
  }

  private async country(companyId: string): Promise<'IN' | 'US'> {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    return phoneCountryForTimezone(c?.timezone);
  }

  /**
   * Validate and normalise a create / update body into column values (only the fields present). STANDARD (dispatcher)
   * callers cannot change the home location they cannot see.
   */
  private async prepare(ctx: AuthContext, dto: CreatePassengerDto | UpdatePassengerDto, before: PassengerRow | null, projection: PassengerView['projection']): Promise<Record<string, unknown> & { email?: string | null; mobile?: string | null; branchId?: string | null; isActive?: boolean; employeeCode?: string }> {
    const companyId = before?.companyId ?? ctx.companyId;
    const country = await this.country(companyId);
    const data: Record<string, unknown> & { email?: string | null; mobile?: string | null; branchId?: string | null; isActive?: boolean } = {};
    if (dto.displayName !== undefined) {
      const name = dto.displayName.replace(/\s+/g, ' ').trim();
      if (!name) throw invalid('Name is required');
      data.displayName = name;
    }
    if (dto.mobile !== undefined) {
      if (dto.mobile === null || dto.mobile.trim() === '') data.mobile = null;
      else {
        const m = normalisePhone(dto.mobile, country);
        if (!m) throw invalid('Mobile must be a valid number, e.g. +919876543210');
        data.mobile = m;
      }
    }
    if (dto.email !== undefined) {
      if (dto.email === null || dto.email.trim() === '') data.email = null;
      else {
        const e = normaliseEmail(dto.email);
        if (!e) throw invalid('Invalid email address');
        data.email = e;
      }
    }
    if (dto.branchId !== undefined) {
      if (dto.branchId === null) {
        if (ctx.dataScope !== 'COMPANY') throw forbidden('Only whole-company roles can make a passenger company-wide');
        data.branchId = null;
      } else {
        const ok = await this.prisma.branch.count({ where: { id: dto.branchId, companyId, isActive: true } });
        if (!ok) throw invalid('Unknown branch');
        if (ctx.dataScope !== 'COMPANY' && !ctx.branchIds.includes(dto.branchId)) throw forbidden('You can only use your own branches');
        data.branchId = dto.branchId;
      }
    }
    for (const key of ['officePoiId', 'defaultStopPoiId'] as const) {
      const v = dto[key];
      if (v === undefined) continue;
      if (v === null) data[key] = null;
      else {
        const ok = await this.prisma.poi.count({ where: { id: v, companyId, isActive: true } });
        if (!ok) throw invalid(key === 'officePoiId' ? 'Unknown office / site' : 'Unknown pickup stop');
        data[key] = v;
      }
    }
    if (dto.home !== undefined) {
      if (projection !== 'FULL') throw forbidden('Only the corporate admin can change a home location');
      Object.assign(data, await this.resolveHome(dto.home, before));
    }
    if (dto.accessibility !== undefined) {
      const a = accessibilityOf(dto.accessibility as Prisma.JsonValue);
      data.accessibility = a as Prisma.InputJsonValue;
    }
    if (dto.emergencyContacts !== undefined) {
      if (projection !== 'FULL') throw forbidden('Only the corporate admin can change emergency contacts');
      data.emergencyContacts = dto.emergencyContacts.map((c) => {
        const phone = normalisePhone(c.phone, country);
        if (!phone) throw invalid(`Emergency contact "${c.name}": invalid phone number`);
        return { name: c.name.trim(), phone, ...(c.relation?.trim() ? { relation: c.relation.trim() } : {}) };
      }) as Prisma.InputJsonValue;
    }
    if ('isActive' in dto && dto.isActive !== undefined) data.isActive = dto.isActive;
    return data;
  }

  /** Home columns for a home input: explicit point, server geocoding (Photon only), address-only, or cleared. */
  private async resolveHome(home: CreatePassengerDto['home'], before: PassengerRow | null): Promise<Record<string, unknown>> {
    const cleared = { homeAddress: null, homeLat: null, homeLng: null, homeGeocodeSource: null, homeGeocodeConfidence: null };
    if (home === null || home === undefined) return cleared;
    const address = home.address === undefined ? (before?.homeAddress ?? null) : home.address?.replace(/\s+/g, ' ').trim() || null;
    const hasLat = home.lat !== undefined && home.lat !== null;
    const hasLng = home.lng !== undefined && home.lng !== null;
    if (hasLat !== hasLng) throw invalid('Give both latitude and longitude');
    if (hasLat) {
      if (!validHomePoint(home.lat, home.lng)) throw invalid('The home point must be a valid coordinate (not 0,0)');
      const source = home.source ?? 'PIN';
      return {
        homeAddress: address,
        homeLat: Number((home.lat as number).toFixed(6)),
        homeLng: Number((home.lng as number).toFixed(6)),
        homeGeocodeSource: source,
        homeGeocodeConfidence: source === 'PHOTON' ? (home.confidence ?? null) : null,
      };
    }
    if (home.geocode && address) {
      const [hit] = await this.geocoding.search(address);
      if (hit && validHomePoint(hit.lat, hit.lng)) {
        return { homeAddress: address, homeLat: Number(hit.lat.toFixed(6)), homeLng: Number(hit.lng.toFixed(6)), homeGeocodeSource: 'PHOTON', homeGeocodeConfidence: hit.confidence };
      }
    }
    // Address only: a new address makes the old pin stale ("Needs location"); the same address keeps it.
    if (before && address === before.homeAddress) return { homeAddress: address };
    return { ...cleared, homeAddress: address };
  }

  private async assertUnique(companyId: string, selfId: string | null, employeeCode: string, email: string | null, mobile: string | null): Promise<void> {
    const notSelf = selfId ? { NOT: { id: selfId } } : {};
    if (await this.prisma.employeeTransportProfile.count({ where: { companyId, employeeCode, ...notSelf } })) throw duplicate(`Employee code ${employeeCode} already exists`);
    const contact: Prisma.EmployeeTransportProfileWhereInput[] = [];
    if (email) contact.push({ email });
    if (mobile) contact.push({ mobile });
    if (!contact.length) return;
    const clash = await this.prisma.employeeTransportProfile.findFirst({ where: { companyId, isActive: true, OR: contact, ...notSelf }, select: { employeeCode: true, email: true } });
    if (clash) throw duplicate(`${clash.email && clash.email === email ? 'Email' : 'Mobile'} already used by employee ${clash.employeeCode}`);
  }

  private duplicateOr(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return duplicate('Employee code already exists');
    return e;
  }
}
