import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  normalizeIccid,
  normalizeMsisdn,
  SIM_ASSIGNABLE,
  SIM_STATUSES,
  SIM_STATUS_LABELS,
  SimCardDto,
  SimEventKind,
  SimImportReport,
  SimStatus,
  SimSummaryDto,
  validateSimStatusChange,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { ListSpec, listResult, planList } from '../common/list-query';
import { IN_USE_MESSAGE } from '../common/prisma-errors';
import { InventoryCatalogService } from '../inventory/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseSimCsv, SimCsvFormatError } from './sim-csv';
import {
  CreatePlanDto,
  CreateProviderDto,
  CreateSimDto,
  PlanListQuery,
  ProviderListQuery,
  RenewalQuery,
  SimAssignDto,
  SimEventListQuery,
  SimImportDto,
  SimListQuery,
  SimRenewDto,
  SimStatusDto,
  SimUnassignDto,
  SimUsageDto,
  UpdatePlanDto,
  UpdateProviderDto,
  UpdateSimDto,
} from './sims.dto';
import {
  EVENT_CSV,
  PLAN_CSV,
  PLAN_INCLUDE,
  PROVIDER_CSV,
  PROVIDER_INCLUDE,
  RENEWAL_WINDOW_DAYS,
  SIM_CSV,
  SIM_INCLUDE,
  SimRow,
  toEventDto,
  toPlanDto,
  toProviderDto,
  toSimDto,
  toUsageDto,
} from './sims.mapper';

type Tx = Prisma.TransactionClient;
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

const PROVIDER_LIST: ListSpec = { search: ['name'], sort: { name: 'name', kind: 'kind', createdAt: 'createdAt' }, defaultSort: 'name' };
const PLAN_LIST: ListSpec = {
  search: ['name', 'provider.name'],
  sort: { name: 'name', providerName: 'provider.name', validityDays: 'validityDays', costPaise: 'costPaise', createdAt: 'createdAt' },
  defaultSort: 'name',
};
const SIM_LIST: ListSpec = {
  search: (q) => ({
    OR: [
      { iccid: { contains: q.replace(/\s/g, '') } },
      { msisdn: { contains: q.replace(/[\s+]/g, '') } },
      { imsi: { contains: q } },
      { note: { contains: q, mode: 'insensitive' } },
      { assignments: { some: { toTime: null, device: { uniqueId: { contains: q } } } } },
    ],
  }),
  sort: { iccid: 'iccid', msisdn: 'msisdn', status: 'status', renewalDueAt: 'renewalDueAt', statusChangedAt: 'statusChangedAt', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'iccid',
  status: null,
};
const EVENT_LIST: ListSpec = {
  search: ['iccidRef', 'deviceRef', 'reason', 'note'],
  sort: { at: 'at', kind: 'kind' },
  defaultSort: 'at',
  defaultOrder: 'desc',
  status: null,
};

/** Statuses whose renewal date matters for reminders. */
const RENEWABLE: SimStatus[] = ['AVAILABLE', 'RESERVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED'];

function todayUtc(offsetDays = 0): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offsetDays));
}
const dateOnly = (v: string | null | undefined): Date | null | undefined => (v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00Z`));

/**
 * SIM management (Super Admin): providers, plans, SIM cards, status machine, SIM ↔ device assignment, renewals,
 * manual usage / cost entries, CSV import and history.
 *
 * Isolation: never writes Device (Device.iccid / simNumber / simOperator are read for reconciliation only), never
 * touches DeviceAssignment, licence seats or invoices. Every SIM change writes its SimEvent in the same transaction.
 */
@Injectable()
export class SimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: InventoryCatalogService,
  ) {}

  // ───────────── Providers ─────────────

  async listProviders(query: ProviderListQuery) {
    const plan = planList<Prisma.SimProviderWhereInput, Prisma.SimProviderOrderByWithRelationInput>(query, PROVIDER_LIST);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.simProvider.findMany({ where: plan.where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: PROVIDER_INCLUDE }),
      this.prisma.simProvider.count({ where: plan.where }),
    ]);
    return listResult(plan, rows.map(toProviderDto), total, PROVIDER_CSV);
  }

  async getProvider(id: string) {
    const row = await this.prisma.simProvider.findUnique({ where: { id }, include: PROVIDER_INCLUDE });
    if (!row) throw new NotFoundException('SIM provider not found');
    return toProviderDto(row);
  }

  async createProvider(ctx: AuthContext, dto: CreateProviderDto) {
    await this.assertProviderNameFree(dto.name);
    const row = await this.prisma.simProvider.create({ data: { ...dto, supportContact: (dto.supportContact ?? {}) as Prisma.InputJsonValue }, include: PROVIDER_INCLUDE });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'sim_provider', entityId: row.id, after: { name: row.name, kind: row.kind } });
    return toProviderDto(row);
  }

  async updateProvider(ctx: AuthContext, id: string, dto: UpdateProviderDto) {
    const before = await this.getProvider(id);
    if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) await this.assertProviderNameFree(dto.name);
    const row = await this.prisma.simProvider.update({
      where: { id },
      data: { ...dto, supportContact: dto.supportContact === undefined ? undefined : (dto.supportContact as Prisma.InputJsonValue) },
      include: PROVIDER_INCLUDE,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'sim_provider', entityId: id, before: { name: before.name, kind: before.kind, isActive: before.isActive }, after: { name: row.name, kind: row.kind, isActive: row.isActive } });
    return toProviderDto(row);
  }

  async removeProvider(ctx: AuthContext, id: string) {
    const before = await this.getProvider(id);
    const [sims, plans] = await this.prisma.$transaction([this.prisma.simCard.count({ where: { providerId: id } }), this.prisma.simPlan.count({ where: { providerId: id } })]);
    if (sims + plans) throw new ConflictException(IN_USE_MESSAGE);
    await this.prisma.simProvider.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'sim_provider', entityId: id, before: { name: before.name } });
  }

  private async assertProviderNameFree(name: string) {
    if (await this.prisma.simProvider.count({ where: { name: { equals: name.trim(), mode: 'insensitive' } } })) throw new ConflictException(`Provider "${name}" already exists`);
  }

  // ───────────── Plans ─────────────

  async listPlans(query: PlanListQuery) {
    const plan = planList<Prisma.SimPlanWhereInput, Prisma.SimPlanOrderByWithRelationInput>(query, PLAN_LIST);
    const where: Prisma.SimPlanWhereInput = { AND: [plan.where, query.providerId ? { providerId: query.providerId } : {}] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.simPlan.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: PLAN_INCLUDE }),
      this.prisma.simPlan.count({ where }),
    ]);
    return listResult(plan, rows.map(toPlanDto), total, PLAN_CSV);
  }

  async getPlan(id: string) {
    const row = await this.prisma.simPlan.findUnique({ where: { id }, include: PLAN_INCLUDE });
    if (!row) throw new NotFoundException('SIM plan not found');
    return toPlanDto(row);
  }

  async createPlan(ctx: AuthContext, dto: CreatePlanDto) {
    await this.getProvider(dto.providerId);
    await this.assertPlanNameFree(dto.providerId, dto.name);
    const row = await this.prisma.simPlan.create({ data: dto, include: PLAN_INCLUDE });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'sim_plan', entityId: row.id, after: { ...dto } });
    return toPlanDto(row);
  }

  async updatePlan(ctx: AuthContext, id: string, dto: UpdatePlanDto) {
    const before = await this.getPlan(id);
    const providerId = dto.providerId ?? before.providerId;
    if (dto.providerId) await this.getProvider(dto.providerId);
    if ((dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) || providerId !== before.providerId) await this.assertPlanNameFree(providerId, dto.name ?? before.name);
    const row = await this.prisma.simPlan.update({ where: { id }, data: dto, include: PLAN_INCLUDE });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'sim_plan', entityId: id, before: { ...before }, after: { ...toPlanDto(row) } });
    return toPlanDto(row);
  }

  async removePlan(ctx: AuthContext, id: string) {
    const before = await this.getPlan(id);
    if (await this.prisma.simCard.count({ where: { planId: id } })) throw new ConflictException(IN_USE_MESSAGE);
    await this.prisma.simPlan.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'sim_plan', entityId: id, before: { name: before.name } });
  }

  private async assertPlanNameFree(providerId: string, name: string) {
    if (await this.prisma.simPlan.count({ where: { providerId, name: { equals: name.trim(), mode: 'insensitive' } } })) throw new ConflictException(`Plan "${name}" already exists for this provider`);
  }

  // ───────────── SIM cards: read ─────────────

  async list(query: SimListQuery) {
    const plan = planList<Prisma.SimCardWhereInput, Prisma.SimCardOrderByWithRelationInput>(query, SIM_LIST);
    const filters: Prisma.SimCardWhereInput[] = [plan.where];
    if (query.simStatus) filters.push({ status: query.simStatus });
    if (query.providerId) filters.push({ providerId: query.providerId });
    if (query.planId) filters.push({ planId: query.planId });
    if (query.assigned === 'true') filters.push({ assignments: { some: { toTime: null, deviceId: { not: null } } } });
    if (query.assigned === 'false') filters.push({ assignments: { none: { toTime: null, deviceId: { not: null } } } });
    if (query.renewalWithin !== undefined) filters.push({ status: { in: RENEWABLE }, renewalDueAt: { lte: todayUtc(query.renewalWithin) } });
    if (query.reconcile) filters.push({ id: { in: await this.reconcileIds() } });
    const where: Prisma.SimCardWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.simCard.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: SIM_INCLUDE }),
      this.prisma.simCard.count({ where }),
    ]);
    return listResult(plan, rows.map((r) => toSimDto(r)), total, SIM_CSV);
  }

  async get(id: string): Promise<SimCardDto> {
    return toSimDto(await this.find(id));
  }

  /** Expiry reminders as a report (no outbound messages): renewable SIMs due within N days, overdue first. */
  async renewals(query: RenewalQuery) {
    const within = query.withinDays ?? RENEWAL_WINDOW_DAYS;
    const rows = await this.prisma.simCard.findMany({
      where: { status: { in: RENEWABLE }, renewalDueAt: { not: null, lte: todayUtc(within) } },
      orderBy: [{ renewalDueAt: 'asc' }, { iccid: 'asc' }],
      take: 1000,
      include: SIM_INCLUDE,
    });
    return { withinDays: within, items: rows.map((r) => toSimDto(r)) };
  }

  async summary(): Promise<SimSummaryDto> {
    const [byStatus, byProvider, assigned, due, overdue, reconcile, cost] = await Promise.all([
      this.prisma.simCard.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: { _all: true } }),
      this.prisma.simCard.groupBy({ by: ['providerId'], orderBy: { providerId: 'asc' }, _count: { _all: true } }),
      this.prisma.simAssignment.count({ where: { toTime: null, deviceId: { not: null } } }),
      this.prisma.simCard.count({ where: { status: { in: RENEWABLE }, renewalDueAt: { gte: todayUtc(), lte: todayUtc(RENEWAL_WINDOW_DAYS) } } }),
      this.prisma.simCard.count({ where: { status: { in: RENEWABLE }, renewalDueAt: { lt: todayUtc() } } }),
      this.reconcileIds(),
      this.prisma.$queryRaw<{ total: bigint | null }[]>(Prisma.sql`
        SELECT sum(p."costPaise") AS total FROM "SimCard" s JOIN "SimPlan" p ON p."id" = s."planId" WHERE s."status" IN ('ACTIVE', 'SUSPENDED')`),
    ]);
    const providers = new Map((await this.prisma.simProvider.findMany({ select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    const counts = Object.fromEntries(SIM_STATUSES.map((s) => [s, 0])) as Record<SimStatus, number>;
    for (const g of byStatus) if (g.status in counts) counts[g.status as SimStatus] = (g._count as { _all: number })._all;
    return {
      byStatus: counts,
      byProvider: byProvider.map((g) => ({ providerId: g.providerId, name: providers.get(g.providerId) ?? '—', count: (g._count as { _all: number })._all })).sort((a, b) => b.count - a.count),
      assigned,
      renewalsDue: due,
      renewalsOverdue: overdue,
      reconcileIssues: reconcile.length,
      activePlanCostPaise: Number(cost[0]?.total ?? 0),
    };
  }

  /** SIMs whose current device reports another ICCID or carries another SIM number (report only). */
  private async reconcileIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s."id" FROM "SimCard" s
      JOIN "SimAssignment" a ON a."simId" = s."id" AND a."toTime" IS NULL
      JOIN "Device" d ON d."id" = a."deviceId"
      WHERE (d."iccid" IS NOT NULL AND regexp_replace(d."iccid", '[^0-9]', '', 'g') <> '' AND regexp_replace(d."iccid", '[^0-9]', '', 'g') <> s."iccid")
         OR (d."simNumber" IS NOT NULL AND s."msisdn" IS NOT NULL AND length(regexp_replace(d."simNumber", '[^0-9]', '', 'g')) >= 8
             AND right(regexp_replace(d."simNumber", '[^0-9]', '', 'g'), 10) <> right(s."msisdn", 10))`);
    return rows.map((r) => r.id);
  }

  async events(query: SimEventListQuery) {
    const plan = planList<Prisma.SimEventWhereInput, Prisma.SimEventOrderByWithRelationInput>(query, EVENT_LIST);
    const where: Prisma.SimEventWhereInput = { AND: [plan.where, query.simId ? { simId: query.simId } : {}] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.simEvent.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.simEvent.count({ where }),
    ]);
    const users = await this.userNames(rows.map((r) => r.createdById));
    return listResult(plan, rows.map((r) => toEventDto(r, users)), total, EVENT_CSV);
  }

  async assignments(simId: string) {
    await this.find(simId);
    const rows = await this.prisma.simAssignment.findMany({ where: { simId }, orderBy: { fromTime: 'desc' }, take: 200 });
    return rows.map((a) => ({ id: a.id, deviceId: a.deviceId, deviceRef: a.deviceRef, fromTime: a.fromTime.toISOString(), toTime: a.toTime?.toISOString() ?? null }));
  }

  async usage(simId: string) {
    await this.find(simId);
    const rows = await this.prisma.simUsage.findMany({ where: { simId }, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }], take: 500 });
    const users = await this.userNames(rows.map((r) => r.createdById));
    return rows.map((u) => toUsageDto(u, users));
  }

  // ───────────── SIM cards: register / edit ─────────────

  async create(ctx: AuthContext, dto: CreateSimDto): Promise<SimCardDto> {
    const iccid = normalizeIccid(dto.iccid);
    if (!iccid) throw new BadRequestException('ICCID must be 18-22 digits');
    const msisdn = this.msisdnOrThrow(dto.msisdn);
    await this.assertRefs(dto.providerId, dto.planId, dto.locationId);
    await this.assertUnique(iccid, msisdn);
    const id = await this.prisma.$transaction(async (tx) => {
      const row = await tx.simCard.create({
        data: {
          iccid,
          msisdn: msisdn ?? null,
          imsi: dto.imsi ?? null,
          providerId: dto.providerId,
          planId: dto.planId ?? null,
          ownership: dto.ownership ?? 'PLATFORM',
          locationId: dto.locationId ?? null,
          renewalDueAt: dateOnly(dto.renewalDueAt) ?? null,
          note: dto.note ?? null,
        },
      });
      await this.event(tx, ctx, { simId: row.id, iccidRef: iccid, kind: 'REGISTER', toStatus: 'AVAILABLE' });
      return row.id;
    }, TX_OPTIONS);
    await this.audit.record(ctx, { action: 'CREATE', entity: 'sim_card', entityId: id, after: { iccid, msisdn, providerId: dto.providerId } });
    return this.get(id);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateSimDto): Promise<SimCardDto> {
    await this.mutate(id, async (tx, sim) => {
      const msisdn = dto.msisdn === undefined ? undefined : this.msisdnOrThrow(dto.msisdn);
      if (msisdn && msisdn !== sim.msisdn && (await tx.simCard.count({ where: { msisdn, id: { not: id } } }))) throw new ConflictException(`MSISDN ${msisdn} is already on another SIM`);
      if (dto.planId) await this.planOf(dto.planId, sim.providerId, tx);
      if (dto.locationId) await this.catalog.assertUsableLocation(dto.locationId, tx);
      const next = {
        msisdn: msisdn === undefined ? sim.msisdn : msisdn,
        imsi: dto.imsi === undefined ? sim.imsi : dto.imsi,
        planId: dto.planId === undefined ? sim.planId : dto.planId,
        ownership: dto.ownership ?? sim.ownership,
        locationId: dto.locationId === undefined ? sim.locationId : dto.locationId,
        note: dto.note === undefined ? sim.note : dto.note,
      };
      const changes = diff(sim, next);
      if (!Object.keys(changes).length) throw new BadRequestException('Nothing to change');
      await this.guardedUpdate(tx, sim, next);
      await this.event(tx, ctx, { simId: id, iccidRef: sim.iccid, kind: 'EDIT', changes });
    });
    return this.get(id);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const sim = await this.find(id);
    const [assignments, usage] = await this.prisma.$transaction([this.prisma.simAssignment.count({ where: { simId: id } }), this.prisma.simUsage.count({ where: { simId: id } })]);
    if (assignments + usage) throw new ConflictException('This SIM has assignment or usage history; deactivate it instead');
    await this.prisma.simCard.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'sim_card', entityId: id, before: { iccid: sim.iccid, msisdn: sim.msisdn } });
  }

  // ───────────── Status / assignment / renewal / usage ─────────────

  async changeStatus(ctx: AuthContext, id: string, dto: SimStatusDto): Promise<SimCardDto> {
    await this.mutate(id, async (tx, sim) => {
      const from = sim.status as SimStatus;
      const open = await this.openAssignment(tx, id);
      const error = validateSimStatusChange({ from, to: dto.status, assigned: !!open, reason: dto.reason });
      if (error) throw new BadRequestException(error);
      await this.guardedUpdate(tx, sim, {
        status: dto.status,
        statusChangedAt: new Date(),
        ...(dto.status === 'ACTIVE' && !sim.activatedAt ? { activatedAt: new Date() } : {}),
      });
      await this.event(tx, ctx, {
        simId: id,
        iccidRef: sim.iccid,
        kind: 'STATUS',
        fromStatus: from,
        toStatus: dto.status,
        deviceId: open?.deviceId ?? null,
        deviceRef: open?.deviceRef ?? null,
        reason: dto.reason?.trim() || null,
        note: dto.note ?? null,
      });
    });
    return this.get(id);
  }

  /** Fit the SIM to a device. A SIM in another device is moved; a SIM already in the target device is taken out. */
  async assign(ctx: AuthContext, id: string, dto: SimAssignDto): Promise<SimCardDto> {
    await this.mutate(id, async (tx, sim) => {
      if (!SIM_ASSIGNABLE.includes(sim.status as SimStatus)) throw new BadRequestException(`A ${SIM_STATUS_LABELS[sim.status as SimStatus].toLowerCase()} SIM cannot be fitted to a device`);
      // Read-only device lookup: the Device row is never written by SIM code.
      const device = await tx.device.findUnique({ where: { id: dto.deviceId }, select: { id: true, uniqueId: true } });
      if (!device) throw new NotFoundException('Device not found');
      const now = new Date();
      const current = await this.openAssignment(tx, id);
      if (current?.deviceId === device.id) throw new BadRequestException('The SIM is already in this device');
      if (current) {
        await tx.simAssignment.update({ where: { id: current.id }, data: { toTime: now } });
        await this.event(tx, ctx, { simId: id, iccidRef: sim.iccid, kind: 'UNASSIGN', deviceId: current.deviceId, deviceRef: current.deviceRef, reason: `Moved to ${device.uniqueId}` });
      }
      const displaced = await tx.simAssignment.findFirst({ where: { deviceId: device.id, toTime: null }, include: { sim: { select: { id: true, iccid: true } } } });
      if (displaced) {
        await tx.simAssignment.update({ where: { id: displaced.id }, data: { toTime: now } });
        await this.event(tx, ctx, { simId: displaced.sim.id, iccidRef: displaced.sim.iccid, kind: 'UNASSIGN', deviceId: device.id, deviceRef: device.uniqueId, reason: `Replaced by SIM ${sim.iccid}` });
      }
      await tx.simAssignment.create({ data: { simId: id, deviceId: device.id, deviceRef: device.uniqueId, fromTime: now, createdById: ctx.userId } });
      await this.guardedUpdate(tx, sim, {});
      await this.event(tx, ctx, { simId: id, iccidRef: sim.iccid, kind: 'ASSIGN', deviceId: device.id, deviceRef: device.uniqueId, reason: dto.reason?.trim() || null });
    });
    return this.get(id);
  }

  async unassign(ctx: AuthContext, id: string, dto: SimUnassignDto): Promise<SimCardDto> {
    await this.mutate(id, async (tx, sim) => {
      const current = await this.openAssignment(tx, id);
      if (!current) throw new BadRequestException('The SIM is not in a device');
      await tx.simAssignment.update({ where: { id: current.id }, data: { toTime: new Date() } });
      await this.guardedUpdate(tx, sim, {});
      await this.event(tx, ctx, { simId: id, iccidRef: sim.iccid, kind: 'UNASSIGN', deviceId: current.deviceId, deviceRef: current.deviceRef, reason: dto.reason?.trim() || null });
    });
    return this.get(id);
  }

  /** Record a renewal: new due date (and plan); an expired SIM becomes active again. */
  async renew(ctx: AuthContext, id: string, dto: SimRenewDto): Promise<SimCardDto> {
    await this.mutate(id, async (tx, sim) => {
      const from = sim.status as SimStatus;
      if (from === 'DEACTIVATED' || from === 'DAMAGED') throw new BadRequestException(`A ${SIM_STATUS_LABELS[from].toLowerCase()} SIM cannot be renewed`);
      if (dto.planId) await this.planOf(dto.planId, sim.providerId, tx);
      const next = {
        renewalDueAt: dateOnly(dto.renewalDueAt)!,
        planId: dto.planId ?? sim.planId,
        ...(from === 'EXPIRED' ? { status: 'ACTIVE', statusChangedAt: new Date() } : {}),
      };
      const changes = diff(sim, { renewalDueAt: next.renewalDueAt, planId: next.planId });
      await this.guardedUpdate(tx, sim, next);
      await this.event(tx, ctx, { simId: id, iccidRef: sim.iccid, kind: 'RENEW', fromStatus: from, toStatus: (next.status as SimStatus | undefined) ?? from, changes, note: dto.note ?? null });
    });
    return this.get(id);
  }

  /** Manual usage / cost entry (append-only; corrections are new entries). */
  async addUsage(ctx: AuthContext, id: string, dto: SimUsageDto) {
    if (dto.periodEnd < dto.periodStart) throw new BadRequestException('The period ends before it starts');
    await this.mutate(id, async (tx, sim) => {
      const row = await tx.simUsage.create({
        data: {
          simId: id,
          periodStart: dateOnly(dto.periodStart)!,
          periodEnd: dateOnly(dto.periodEnd)!,
          dataMb: dto.dataMb ?? null,
          smsCount: dto.smsCount ?? null,
          costPaise: dto.costPaise ?? null,
          note: dto.note ?? null,
          createdById: ctx.userId,
        },
      });
      await this.event(tx, ctx, {
        simId: id,
        iccidRef: sim.iccid,
        kind: 'USAGE',
        note: `${dto.periodStart}..${dto.periodEnd}`,
        changes: { usageId: { from: null, to: row.id }, dataMb: { from: null, to: dto.dataMb ?? null }, costPaise: { from: null, to: dto.costPaise ?? null } },
      });
    });
    return this.usage(id);
  }

  // ───────────── CSV import ─────────────

  async importCsv(ctx: AuthContext, dto: SimImportDto): Promise<SimImportReport> {
    const dryRun = dto.dryRun !== false;
    let parsed;
    try {
      parsed = parseSimCsv(dto.csv);
    } catch (e) {
      if (e instanceof SimCsvFormatError) throw new BadRequestException(e.message);
      throw e;
    }
    if (dto.providerId) await this.getProvider(dto.providerId);
    if (dto.locationId) await this.catalog.assertUsableLocation(dto.locationId);
    const providers = await this.prisma.simProvider.findMany({ select: { id: true, name: true, isActive: true } });
    const plans = await this.prisma.simPlan.findMany({ select: { id: true, name: true, providerId: true } });
    const byName = new Map(providers.map((p) => [p.name.toLowerCase(), p]));
    const iccids = parsed.map((r) => r.iccid).filter((v): v is string => !!v);
    const msisdns = parsed.map((r) => r.msisdn).filter((v): v is string => !!v);
    const [existingIccid, existingMsisdn] = await Promise.all([
      this.prisma.simCard.findMany({ where: { iccid: { in: iccids } }, select: { iccid: true } }),
      this.prisma.simCard.findMany({ where: { msisdn: { in: msisdns } }, select: { msisdn: true } }),
    ]);
    const takenIccid = new Set(existingIccid.map((r) => r.iccid));
    const takenMsisdn = new Set(existingMsisdn.map((r) => r.msisdn));

    const planned = parsed.map((r) => {
      const errors = [...r.errors];
      let providerId = dto.providerId ?? null;
      if (r.provider) {
        const p = byName.get(r.provider.toLowerCase());
        if (!p) errors.push(`Unknown provider "${r.provider}"`);
        else providerId = p.id;
      }
      if (!providerId) errors.push('Provider is required (column or default)');
      let planId: string | null = null;
      if (r.plan && providerId) {
        planId = plans.find((p) => p.providerId === providerId && p.name.toLowerCase() === r.plan!.toLowerCase())?.id ?? null;
        if (!planId) errors.push(`Unknown plan "${r.plan}" for this provider`);
      }
      if (r.iccid && takenIccid.has(r.iccid)) errors.push('ICCID already registered');
      if (r.msisdn && takenMsisdn.has(r.msisdn)) errors.push('MSISDN already on another SIM');
      return { row: r, providerId, planId, errors: [...new Set(errors)] };
    });
    const rows = planned.map((p) => ({ line: p.row.line, iccid: p.row.iccid, action: (p.errors.length ? 'ERROR' : 'CREATE') as 'ERROR' | 'CREATE', errors: p.errors }));
    const summary = { rows: rows.length, create: rows.filter((r) => r.action === 'CREATE').length, errors: rows.filter((r) => r.action === 'ERROR').length };
    if (dryRun || summary.errors) return { dryRun, applied: false, summary, rows };

    await this.prisma.$transaction(async (tx) => {
      for (const p of planned) {
        const sim = await tx.simCard.create({
          data: {
            iccid: p.row.iccid!,
            msisdn: p.row.msisdn,
            imsi: p.row.imsi,
            providerId: p.providerId!,
            planId: p.planId,
            ownership: p.row.ownership ?? 'PLATFORM',
            locationId: dto.locationId ?? null,
            renewalDueAt: dateOnly(p.row.renewalDueAt) ?? null,
            note: p.row.note,
          },
        });
        await this.event(tx, ctx, { simId: sim.id, iccidRef: sim.iccid, kind: 'REGISTER', toStatus: 'AVAILABLE', note: 'CSV import' });
      }
      await this.audit.record(ctx, { action: 'CREATE', entity: 'sim_import', entityId: null, details: { rows: planned.length, locationId: dto.locationId ?? null } }, tx);
    }, { timeout: 120_000, maxWait: 10_000 });
    return { dryRun, applied: true, summary, rows };
  }

  // ───────────── Internals ─────────────

  private msisdnOrThrow(raw: string | null | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || !raw.trim()) return null;
    const v = normalizeMsisdn(raw);
    if (!v) throw new BadRequestException('MSISDN must be 8-15 digits');
    return v;
  }

  private async assertRefs(providerId: string, planId?: string | null, locationId?: string | null) {
    await this.getProvider(providerId);
    if (planId) await this.planOf(planId, providerId);
    if (locationId) await this.catalog.assertUsableLocation(locationId);
  }

  private async planOf(planId: string, providerId: string, db: Tx | PrismaService = this.prisma) {
    const plan = await db.simPlan.findUnique({ where: { id: planId }, select: { providerId: true } });
    if (!plan) throw new NotFoundException('SIM plan not found');
    if (plan.providerId !== providerId) throw new BadRequestException("The plan belongs to another provider than the SIM's");
  }

  private async assertUnique(iccid: string, msisdn: string | null | undefined) {
    if (await this.prisma.simCard.count({ where: { iccid } })) throw new ConflictException(`ICCID ${iccid} is already registered`);
    if (msisdn && (await this.prisma.simCard.count({ where: { msisdn } }))) throw new ConflictException(`MSISDN ${msisdn} is already on another SIM`);
  }

  private async find(id: string): Promise<SimRow> {
    const row = await this.prisma.simCard.findUnique({ where: { id }, include: SIM_INCLUDE });
    if (!row) throw new NotFoundException('SIM not found');
    return row;
  }

  /** Open assignment with a live device (a purged device leaves deviceId null: treated as closed and closed lazily). */
  private async openAssignment(tx: Tx, simId: string) {
    const open = await tx.simAssignment.findFirst({ where: { simId, toTime: null } });
    if (open && !open.deviceId) {
      await tx.simAssignment.update({ where: { id: open.id }, data: { toTime: new Date() } });
      return null;
    }
    return open;
  }

  private async mutate(id: string, fn: (tx: Tx, sim: Prisma.SimCardGetPayload<object>) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const sim = await tx.simCard.findUnique({ where: { id } });
      if (!sim) throw new NotFoundException('SIM not found');
      await fn(tx, sim);
    }, TX_OPTIONS);
  }

  /** Optimistic update: refused when the SIM changed since it was read. Always bumps updatedAt. */
  private async guardedUpdate(tx: Tx, sim: { id: string; updatedAt: Date }, data: Prisma.SimCardUncheckedUpdateManyInput): Promise<void> {
    const res = await tx.simCard.updateMany({ where: { id: sim.id, updatedAt: sim.updatedAt }, data: { ...data, updatedAt: new Date() } });
    if (res.count !== 1) throw new ConflictException('The SIM changed meanwhile; reload and try again');
  }

  /** Append-only history; always inside the caller's transaction. */
  private async event(
    tx: Tx,
    ctx: AuthContext,
    e: {
      simId: string;
      iccidRef: string;
      kind: SimEventKind;
      fromStatus?: SimStatus | null;
      toStatus?: SimStatus | null;
      deviceId?: string | null;
      deviceRef?: string | null;
      reason?: string | null;
      note?: string | null;
      changes?: Record<string, { from: unknown; to: unknown }>;
    },
  ): Promise<void> {
    await tx.simEvent.create({ data: { ...e, changes: e.changes as Prisma.InputJsonValue | undefined, createdById: ctx.userId, at: new Date() } });
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }
}

function norm(v: unknown): unknown {
  return v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null);
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    const a = norm(before[k]);
    const b = norm(v);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}
