import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ETMS_DRIVER_ROLE_NAME,
  normaliseEmail,
  normalisePhone,
  phoneCountryForTimezone,
  type DriverLoginDto as DriverLoginResult,
  type LoginRemovalMode,
  type Paginated,
  type TransportVehicleProfileDto,
  type TransportVehicleProfileResponse,
  type TransportVehicleRowDto,
} from '@veetracer/shared';
import { ListSpec, planList } from '../../common/list-query';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { transportNotFound } from '../../access/transport-scope';
import { AuditService } from '../../audit/audit.service';
import { driverScopeWhere } from '../../drivers/drivers.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { createOrLinkLogin, disableLogin } from './identity-link';
import { DriverLoginDto, TransportVehicleListQuery, VehicleProfileDto } from './people.dto';

export const VEHICLE_PROFILE_ENTITY = 'TransportVehicleProfile';

type ProfileRow = Prisma.TransportVehicleProfileGetPayload<{ include: { object: { select: { name: true; plateNumber: true } } } }>;

function toVehicleDto(r: ProfileRow): TransportVehicleProfileDto {
  return {
    objectId: r.objectId,
    objectName: r.object.name,
    plateNumber: r.object.plateNumber,
    seats: r.seats,
    wheelchairSpaces: r.wheelchairSpaces,
    hasAc: r.hasAc,
    category: r.category,
    notes: r.notes,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const snapshot = (r: ProfileRow | null) => (r ? { seats: r.seats, wheelchairSpaces: r.wheelchairSpaces, hasAc: r.hasAc, category: r.category, notes: r.notes } : null);

/**
 * Operator-side E2 links (doc 05 §2.3): seat capacity of the company's OWN vehicles (TransportVehicleProfile; vehicles
 * shared with the company are excluded because objectScopeWhere never includes shares), and the driver login link
 * (Driver.userId, D5) with the same one-login-per-person rule as passengers (IDENTITY_IN_USE).
 */
@Injectable()
export class FleetLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Every vehicle (type VEHICLE) the company owns inside the caller's scope (objectScopeWhere: whole company, or own
   * branches + assigned objects), with its seat profile or null while seats were never set. Shared vehicles are
   * excluded (objectScopeWhere never includes shares). Paged / searched like the master lists.
   */
  async listVehicles(ctx: AuthContext, query: TransportVehicleListQuery): Promise<Paginated<TransportVehicleRowDto>> {
    const plan = planList<Prisma.TrackedObjectWhereInput, Prisma.TrackedObjectOrderByWithRelationInput>(query, {
      search: ['name', 'plateNumber'],
      sort: { name: 'name', plateNumber: 'plateNumber' },
      defaultSort: 'name',
    } satisfies ListSpec);
    const filters: Prisma.TrackedObjectWhereInput[] = [objectScopeWhere(ctx), { type: 'VEHICLE' }, plan.where];
    if (query.seats === 'set') filters.push({ transportProfile: { isNot: null } });
    if (query.seats === 'unset') filters.push({ transportProfile: { is: null } });
    const where: Prisma.TrackedObjectWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trackedObject.findMany({
        where,
        orderBy: plan.orderBy,
        skip: plan.skip,
        take: plan.take,
        select: { id: true, name: true, plateNumber: true, isActive: true, branchId: true, transportProfile: true },
      }),
      this.prisma.trackedObject.count({ where }),
    ]);
    const items = rows.map((o) => ({
      objectId: o.id,
      objectName: o.name,
      plateNumber: o.plateNumber,
      isActive: o.isActive,
      branchId: o.branchId,
      profile: o.transportProfile ? toVehicleDto({ ...o.transportProfile, object: { name: o.name, plateNumber: o.plateNumber } }) : null,
    }));
    return { items, total, page: plan.page, pageSize: plan.pageSize };
  }

  async getVehicleProfile(ctx: AuthContext, objectId: string): Promise<TransportVehicleProfileResponse> {
    await this.ownVehicle(ctx, objectId);
    const row = await this.prisma.transportVehicleProfile.findUnique({ where: { objectId }, include: { object: { select: { name: true, plateNumber: true } } } });
    return { objectId, profile: row ? toVehicleDto(row) : null };
  }

  async putVehicleProfile(ctx: AuthContext, objectId: string, dto: VehicleProfileDto): Promise<TransportVehicleProfileDto> {
    const vehicle = await this.ownVehicle(ctx, objectId);
    if ((dto.wheelchairSpaces ?? 0) > dto.seats) throw new BadRequestException({ message: 'Wheelchair spaces cannot exceed the seats', code: 'VALIDATION_FAILED' });
    const data = {
      seats: dto.seats,
      wheelchairSpaces: dto.wheelchairSpaces ?? 0,
      hasAc: dto.hasAc ?? null,
      category: dto.category ?? null,
      notes: dto.notes?.trim() || null,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.transportVehicleProfile.findUnique({ where: { objectId }, include: { object: { select: { name: true, plateNumber: true } } } });
      const after = await tx.transportVehicleProfile.upsert({
        where: { objectId },
        create: { objectId, companyId: vehicle.companyId, ...data },
        update: data,
        include: { object: { select: { name: true, plateNumber: true } } },
      });
      await this.audit.record(ctx, { action: before ? 'UPDATE' : 'CREATE', entity: VEHICLE_PROFILE_ENTITY, entityId: objectId, before: snapshot(before), after: snapshot(after) }, tx);
      return after;
    });
    return toVehicleDto(row);
  }

  /** A vehicle the company owns and the caller may edit; anything else (other tenants, shared vehicles) is 404. */
  private async ownVehicle(ctx: AuthContext, objectId: string): Promise<{ id: string; companyId: string }> {
    const v = await this.prisma.trackedObject.findFirst({ where: { AND: [{ id: objectId }, objectScopeWhere(ctx)] }, select: { id: true, companyId: true } });
    if (!v) throw transportNotFound('Vehicle not found');
    return v;
  }

  // ───────────────────────────── driver login (D5, doc 15 §7.2) ─────────────────────────────

  async getDriverLogin(ctx: AuthContext, driverId: string): Promise<DriverLoginResult> {
    const d = await this.driver(ctx, driverId);
    return this.driverLoginDto(d.id, d.userId);
  }

  async grantDriverLogin(ctx: AuthContext, driverId: string, dto: DriverLoginDto): Promise<DriverLoginResult> {
    const d = await this.driver(ctx, driverId);
    if (!d.isActive) throw new ConflictException({ message: 'Reactivate the driver first', code: 'INVALID_STATE' });
    const company = await this.prisma.company.findUnique({ where: { id: d.companyId }, select: { timezone: true } });
    const country = phoneCountryForTimezone(company?.timezone);
    const email = dto.email ? normaliseEmail(dto.email) : null;
    if (dto.email && !email) throw new BadRequestException({ message: 'Invalid email address', code: 'VALIDATION_FAILED' });
    const rawMobile = dto.mobile === undefined ? d.mobile : dto.mobile;
    const mobile = rawMobile ? normalisePhone(rawMobile, country) : null;
    if (dto.mobile && !mobile) throw new BadRequestException({ message: 'Invalid mobile number', code: 'VALIDATION_FAILED' });
    const link = await this.prisma.$transaction(async (tx) => {
      const res = await createOrLinkLogin(tx, {
        companyId: d.companyId,
        name: d.name,
        email,
        mobile,
        password: dto.password,
        roleName: ETMS_DRIVER_ROLE_NAME,
        currentUserId: d.userId,
        linkedElsewhere: async (userId) => (await tx.driver.count({ where: { userId, NOT: { id: d.id } } })) > 0,
      });
      if (d.userId !== res.userId) await tx.driver.update({ where: { id: d.id }, data: { userId: res.userId } });
      await this.audit.record(ctx, { action: res.outcome === 'CREATED' ? 'CREATE' : 'UPDATE', entity: 'User', entityId: res.userId, details: { what: 'driver-login', outcome: res.outcome, driverId: d.id, passwordChanged: !!dto.password } }, tx);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'Driver', entityId: d.id, before: { userId: d.userId }, after: { userId: res.userId } }, tx);
      return res;
    });
    await this.redis.invalidateCache('user').catch(() => undefined);
    return { ...(await this.driverLoginDto(d.id, link.userId)), outcome: link.outcome };
  }

  /** LoginRemovalMode: `disable` (default) keeps Driver.userId so the login can be enabled again; `unlink` clears it. */
  async revokeDriverLogin(ctx: AuthContext, driverId: string, mode: LoginRemovalMode = 'disable'): Promise<DriverLoginResult> {
    const d = await this.driver(ctx, driverId);
    if (!d.userId) throw new ConflictException({ message: 'This driver has no login', code: 'INVALID_STATE' });
    const userId = d.userId;
    await this.prisma.$transaction(async (tx) => {
      const outcome = await disableLogin(tx, d.companyId, userId, ETMS_DRIVER_ROLE_NAME);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'User', entityId: userId, details: { what: mode === 'unlink' ? 'driver-login-unlinked' : 'driver-login-disabled', outcome, driverId: d.id } }, tx);
      if (mode === 'unlink') {
        await tx.driver.update({ where: { id: d.id }, data: { userId: null } });
        await this.audit.record(ctx, { action: 'UPDATE', entity: 'Driver', entityId: d.id, before: { userId }, after: { userId: null } }, tx);
      }
    });
    await this.redis.invalidateCache('user').catch(() => undefined);
    return this.driverLoginDto(d.id, mode === 'unlink' ? null : userId);
  }

  private async driver(ctx: AuthContext, id: string) {
    const d = await this.prisma.driver.findFirst({ where: { AND: [{ id }, driverScopeWhere(ctx)] }, select: { id: true, companyId: true, name: true, mobile: true, isActive: true, userId: true } });
    if (!d) throw transportNotFound('Driver not found');
    return d;
  }

  private async driverLoginDto(driverId: string, userId: string | null): Promise<DriverLoginResult> {
    if (!userId) return { driverId, userId: null, active: false, email: null, mobile: null };
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, email: true, mobile: true, roles: { select: { role: { select: { name: true } } } } } });
    return {
      driverId,
      userId,
      active: !!u?.isActive && !!u.roles.some((r) => r.role.name === ETMS_DRIVER_ROLE_NAME),
      email: u?.email ?? null,
      mobile: u?.mobile ?? null,
    };
  }
}
