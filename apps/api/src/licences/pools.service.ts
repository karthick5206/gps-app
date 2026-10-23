import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ApiPlan,
  can,
  deviceLicenceType,
  LICENCE_EXPIRING_DAYS,
  isApiPlan,
  LicenceBannerDto,
  LicenceType,
  seatLocked,
  seatGraceDays,
  seatStatus,
  SEAT_LICENCE_TYPES,
  SeatDto,
  SeatSource,
  SeatSummaryDto,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { LicencePolicyService } from './licence-policy.service';
import { LicenceSettingsService } from './licence-settings.service';
import { summarise } from './seat-logic';

const DAY_MS = 86_400_000;
type Tx = Prisma.TransactionClient;

export const SEAT_INCLUDE = {
  company: { select: { name: true } },
  partner: { select: { name: true } },
  user: { select: { id: true, name: true } },
  device: { select: { id: true, uniqueId: true, assignments: { where: { toTime: null }, take: 1, select: { object: { select: { name: true } } } } } },
  fuelConfig: { select: { objectId: true, object: { select: { name: true } } } },
} satisfies Prisma.LicenceSeatInclude;
type SeatRow = Prisma.LicenceSeatGetPayload<{ include: typeof SEAT_INCLUDE }>;

export function seatDto(s: SeatRow, now: number, graceDays: number): SeatDto {
  const subject = s.user
    ? { kind: 'USER' as const, id: s.user.id, name: s.user.name }
    : s.device
      ? { kind: 'DEVICE' as const, id: s.device.id, name: `${s.device.uniqueId}${s.device.assignments[0] ? ` · ${s.device.assignments[0].object.name}` : ''}` }
      : s.fuelConfig
        ? { kind: 'FUEL' as const, id: s.fuelConfig.objectId, name: s.fuelConfig.object.name }
        : s.type === 'API_ACCESS' && s.companyId
          ? { kind: 'COMPANY' as const, id: s.companyId, name: s.company?.name ?? '' }
          : null;
  return {
    id: s.id,
    type: s.type as LicenceType,
    companyId: s.companyId,
    companyName: s.company?.name ?? null,
    partnerId: s.partnerId,
    partnerName: s.partner?.name ?? null,
    source: s.source as SeatSource,
    activatedAt: s.activatedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    status: seatStatus(s.expiresAt, now, seatGraceDays(s.source, graceDays)),
    locked: seatLocked(s.expiresAt, now, seatGraceDays(s.source, graceDays)),
    subject,
    note: s.note,
    apiPlan: isApiPlan(s.apiPlan) ? s.apiPlan : null,
  };
}

/** Licence pools: seat lists and summaries, rebalancing, partner allocation, complimentary grants, banners. */
@Injectable()
export class PoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly policy: LicencePolicyService,
    private readonly audit: AuditService,
  ) {}

  async seats(where: Prisma.LicenceSeatWhereInput, now = Date.now()): Promise<{ seats: SeatDto[]; summary: SeatSummaryDto[] }> {
    const rows = await this.prisma.licenceSeat.findMany({ where, include: SEAT_INCLUDE, orderBy: [{ type: 'asc' }, { expiresAt: 'asc' }], take: 5000 });
    const grace = await this.settings.graceDays();
    return { seats: rows.map((r) => seatDto(r, now, grace)), summary: summarise(rows.map((r) => ({ ...r, type: r.type as LicenceType })), now, grace) };
  }

  /**
   * Put free, unexpired seats to work: active users / devices / fuel sensors without a seat, or whose seat has expired,
   * move onto a free seat of their type (the expired seat stays in the pool, unassigned). Runs after each purchase
   * and with the hourly licence job.
   */
  async rebalance(tx: Tx, companyId: string, now = Date.now()): Promise<number> {
    if (await this.policy.isExempt(companyId)) return 0;
    const at = new Date(now);
    const needsSeat = { OR: [{ licenceSeat: { is: null } }, { licenceSeat: { is: { expiresAt: { lte: at } } } }] };
    let moved = 0;
    for (const type of SEAT_LICENCE_TYPES) {
      const free = await tx.licenceSeat.findMany({
        where: { companyId, type, userId: null, deviceId: null, fuelObjectId: null, expiresAt: { gt: at } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (!free.length) continue;
      let subjects: { id: string; seatId: string | null }[] = [];
      if (type === 'USER') {
        const rows = await tx.user.findMany({ where: { companyId, isActive: true, isSuperAdmin: false, ...needsSeat }, select: { id: true, licenceSeat: { select: { id: true } } }, orderBy: { createdAt: 'asc' } });
        subjects = rows.map((r) => ({ id: r.id, seatId: r.licenceSeat?.id ?? null }));
      } else if (type === 'FUEL_SENSOR') {
        const rows = await tx.fuelConfig.findMany({ where: { companyId, source: { not: 'none' }, ...needsSeat }, select: { objectId: true, licenceSeat: { select: { id: true } } } });
        subjects = rows.map((r) => ({ id: r.objectId, seatId: r.licenceSeat?.id ?? null }));
      } else {
        const rows = await tx.device.findMany({
          where: { companyId, isActive: true, ...needsSeat },
          select: { id: true, model: { select: { capabilities: true } }, licenceSeat: { select: { id: true } } },
          orderBy: { createdAt: 'asc' },
        });
        subjects = rows.filter((r) => deviceLicenceType(r.model.capabilities) === type).map((r) => ({ id: r.id, seatId: r.licenceSeat?.id ?? null }));
      }
      const column = type === 'USER' ? 'userId' : type === 'FUEL_SENSOR' ? 'fuelObjectId' : 'deviceId';
      for (let i = 0; i < Math.min(free.length, subjects.length); i++) {
        const s = subjects[i];
        if (s.seatId) await tx.licenceSeat.update({ where: { id: s.seatId }, data: { [column]: null, assignedAt: null } });
        await tx.licenceSeat.update({ where: { id: free[i].id }, data: { [column]: s.id, assignedAt: at } });
        moved++;
      }
    }
    if (moved) this.policy.invalidate(companyId);
    return moved;
  }

  /** Partner → customer: moves free seats from the partner pool into the company pool (each keeps its own expiry). */
  async allocate(ctx: AuthContext, partnerId: string, companyId: string, type: LicenceType, quantity: number): Promise<number> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { partnerId: true, isPlatform: true } });
    if (!company || company.isPlatform) throw new NotFoundException('Company not found');
    if (company.partnerId !== partnerId) throw new ForbiddenException('This company is not a customer of the partner');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new BadRequestException('Quantity must be 1–1000');
    if (type === 'API_ACCESS') {
      // One account-level Developer API seat per company.
      if (quantity !== 1) throw new BadRequestException('A company gets one Developer API licence');
      if (await this.prisma.licenceSeat.count({ where: { companyId, type: 'API_ACCESS', expiresAt: { gt: new Date() } } })) {
        throw new BadRequestException('This company already has a running Developer API licence');
      }
    }
    const now = new Date();
    const moved = await this.prisma.$transaction(async (tx) => {
      const free = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "LicenceSeat"
        WHERE "partnerId" = ${partnerId}::uuid AND "companyId" IS NULL AND "type" = ${type}::"LicenceType" AND "expiresAt" > now()
        ORDER BY "expiresAt" ASC, "id" ASC
        LIMIT ${quantity}
        FOR UPDATE SKIP LOCKED`;
      if (free.length < quantity) throw new BadRequestException(`Only ${free.length} free seat(s) of this type in the partner pool`);
      await tx.licenceSeat.updateMany({ where: { id: { in: free.map((f) => f.id) } }, data: { companyId, source: 'ALLOCATION', notifiedState: null } });
      await this.rebalance(tx, companyId, now.getTime());
      await this.audit.record({ ...ctx, companyId }, { action: 'UPDATE', entity: 'licence_allocation', entityId: companyId, details: { partnerId, type, quantity, seatIds: free.map((f) => f.id) } }, tx);
      return free.length;
    });
    this.policy.invalidate(companyId);
    return moved;
  }

  /** Super Admin: complimentary seats (no invoice) for a company or partner pool, audited with the reason. */
  async grant(ctx: AuthContext, owner: { companyId?: string; partnerId?: string }, type: LicenceType, quantity: number, days: number, reason: string, plan?: ApiPlan): Promise<number> {
    if (!reason.trim()) throw new BadRequestException('A reason is required');
    if (type === 'API_ACCESS' && owner.companyId && quantity !== 1) throw new BadRequestException('A company gets one Developer API licence');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * DAY_MS);
    const data = Array.from({ length: quantity }, () => ({
      type,
      companyId: owner.companyId ?? null,
      partnerId: owner.partnerId ?? null,
      source: 'OVERRIDE',
      activatedAt: now,
      expiresAt,
      note: `Complimentary: ${reason.trim().slice(0, 200)}`,
      apiPlan: type === 'API_ACCESS' ? (plan ?? 'BASIC') : null,
    }));
    await this.prisma.$transaction(async (tx) => {
      // A new Developer API seat replaces the company's running one (one per company).
      if (type === 'API_ACCESS' && owner.companyId) await expireApiSeats(tx, owner.companyId, now, 'Replaced by a complimentary licence');
      await tx.licenceSeat.createMany({ data });
      if (owner.companyId) await this.rebalance(tx, owner.companyId, now.getTime());
      await this.audit.record({ ...ctx, companyId: owner.companyId ?? ctx.companyId }, { action: 'CREATE', entity: 'licence_grant', details: { ...owner, type, quantity, days, reason, ...(type === 'API_ACCESS' ? { plan: plan ?? 'BASIC' } : {}) } }, tx);
    });
    if (owner.companyId) this.policy.invalidate(owner.companyId);
    return quantity;
  }

  async banner(ctx: AuthContext, now = Date.now()): Promise<LicenceBannerDto> {
    const canManage = can(ctx.permissions, 'billing', 'create');
    if (await this.policy.isExempt(ctx.companyId)) return { exempt: true, expiringSoon: 0, inGrace: 0, lockedVehicles: [], canManage };
    const grace = await this.settings.graceDays();
    const assigned = { OR: [{ userId: { not: null } }, { deviceId: { not: null } }, { fuelObjectId: { not: null } }] };
    const [expiringSoon, inGrace, lockedIds] = await Promise.all([
      this.prisma.licenceSeat.count({ where: { companyId: ctx.companyId, ...assigned, expiresAt: { gt: new Date(now), lte: new Date(now + LICENCE_EXPIRING_DAYS * DAY_MS) } } }),
      this.prisma.licenceSeat.count({ where: { companyId: ctx.companyId, ...assigned, expiresAt: { lte: new Date(now), gt: new Date(now - grace * DAY_MS) } } }),
      this.policy.lockedObjectIds(ctx),
    ]);
    const lockedVehicles = lockedIds.size
      ? await this.prisma.trackedObject.findMany({ where: { id: { in: [...lockedIds].slice(0, 50) } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
      : [];
    return { exempt: false, expiringSoon, inGrace, lockedVehicles, canManage };
  }
}

/** Expire the company's running Developer API seats (a new plan was bought / granted); the new seat is the effective one. */
export async function expireApiSeats(tx: Tx, companyId: string, at: Date, note: string): Promise<number> {
  const r = await tx.licenceSeat.updateMany({ where: { companyId, type: 'API_ACCESS', expiresAt: { gt: at } }, data: { expiresAt: at, notifiedState: 'REPLACED', note } });
  return r.count;
}
