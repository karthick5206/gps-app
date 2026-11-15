import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  kmToMetres,
  mergeVehicleOverrides,
  PRICING_ENGINE_VERSION,
  priceTrip,
  resolveBillableDistance,
  selectContract,
  type BillingAdjustmentDto,
  type ContractCandidate,
  type DistanceSource,
  type GpsQuality,
  type MissingGpsPolicy,
  type PriceResult,
  type PricingIssue,
  type PricingPolicies,
  type RidePreference,
  type RoundingMode,
  type TripChargeDetailResponse,
  type TripChargeListQuery,
  type TripChargeListResponse,
  type TripOverrideResponse,
  type TripPriceSnapshotDto,
  type TripPriceStatus,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { csvFile } from '../common/csv';
import { PrismaService } from '../prisma/prisma.service';
import { engineComponents, PricingContractsService, sanitizeComponents } from './contracts.service';
import {
  asJson,
  branchVisible,
  branchWhere,
  conflict,
  invalid,
  isoOf,
  jsonLines,
  jsonTaxLines,
  lineDto,
  localMinuteOfDay,
  majorToMinor,
  notFound,
  paging,
  reasonOf,
  taxLineDto,
  ymd,
  type Db,
} from './pricing-common';
import { PricingSettingsService } from './settings.service';

type SnapshotRow = Prisma.TripPriceSnapshotGetPayload<object>;
const FINAL_TRIP = ['COMPLETED', 'INCOMPLETE', 'CANCELLED'];
/** Per-trip transaction lock shared by re-pricing and invoice generation / issue (QA 6). */
export async function lockTrip(tx: Db, tripId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pricing:trip:${tripId}`}, 0))`;
}
export const tripSourceKey = (tripId: string, passengerId: string | null = null) => `TRIP:${tripId}:${passengerId ?? ''}`;
/** Snapshots an invoice may take. */
export const INVOICEABLE_TRIP_STATUSES = ['PRICED'];

export interface PriceOptions {
  reason?: string | null;
  manualDistanceM?: number | null;
  override?: { minor: bigint; reason: string; byId: string; approvedById: string | null } | null;
  /** Job: do not fail on an invoiced trip, skip it. */
  skipInvoiced?: boolean;
}

export function snapshotDto(s: SnapshotRow, extra: { contractName?: string | null; invoiceId?: string | null } = {}): TripPriceSnapshotDto {
  return {
    id: s.id,
    transportTripId: s.transportTripId,
    bookingId: s.bookingId,
    passengerId: s.passengerId,
    contractId: s.contractId,
    contractName: extra.contractName ?? null,
    contractVersionId: s.contractVersionId,
    vehicleRateId: s.vehicleRateId,
    customerCompanyId: s.customerCompanyId,
    branchId: s.branchId,
    objectId: s.objectId,
    serviceDate: ymd(s.serviceDate),
    currency: s.currency,
    pricingModel: s.pricingModel,
    ridePreference: s.ridePreference as RidePreference | null,
    distances: { plannedM: s.plannedDistanceM, gpsM: s.gpsDistanceM, agreedM: s.agreedDistanceM, manualM: s.manualDistanceM, billableM: s.billableDistanceM },
    distanceSource: s.distanceSource as DistanceSource | null,
    gpsQuality: s.gpsQuality as GpsQuality,
    plannedDurationS: s.plannedDurationS,
    actualDurationS: s.actualDurationS,
    waitingS: s.waitingS,
    extraStops: s.extraStops,
    lines: jsonLines(s.lines),
    subtotalMinor: s.subtotalMinor.toString(),
    discountMinor: s.discountMinor.toString(),
    taxLines: jsonTaxLines(s.taxLines),
    taxMinor: s.taxMinor.toString(),
    totalMinor: s.totalMinor.toString(),
    issues: (Array.isArray(s.issues) ? s.issues : []) as unknown as PricingIssue[],
    status: s.status as TripPriceStatus,
    isCurrent: s.isCurrent,
    supersedesId: s.supersedesId,
    reason: s.reason,
    override: s.overrideAt ? { byId: s.overrideById, at: isoOf(s.overrideAt), reason: s.overrideReason, approvedById: s.overrideApprovedById } : null,
    calculatedById: s.calculatedById,
    calculatedAt: s.calculatedAt.toISOString(),
    engineVersion: s.engineVersion,
    invoiceId: extra.invoiceId ?? null,
  };
}

/** Agreed route distance from a FIXED_TRIP component (params.agreedKm), if configured. */
function agreedMetres(components: { kind: string; params: Record<string, unknown> }[]): number | null {
  const fixed = components.find((c) => c.kind === 'FIXED_TRIP' && typeof c.params.agreedKm === 'string');
  if (!fixed) return null;
  try {
    return kmToMetres(fixed.params.agreedKm as string);
  } catch {
    return null;
  }
}

/**
 * Doc 19 §5.4 / §5.7 / §5.8 trip pricing: resolves the applicable contract (precedence 1–4, explicit
 * NO_APPLICABLE_PRICING, never another customer's rate), the vehicle override (only when permitted), the billable distance
 * (separate sources, GPS quality, review policy), runs the engine and appends an immutable snapshot. Re-pricing creates a
 * new snapshot; an invoiced trip is frozen (adjustments only).
 */
@Injectable()
export class TripPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contracts: PricingContractsService,
    private readonly settings: PricingSettingsService,
  ) {}

  private async loadTrip(db: Db | PrismaService, ctx: AuthContext, tripId: string) {
    const trip = await db.transportTrip.findFirst({
      where: { id: tripId, providerCompanyId: ctx.companyId },
      include: {
        plannedTrip: { include: { stops: { select: { status: true } } } },
        routeAssignment: { select: { distanceM: true, durationS: true } },
        passengers: { select: { status: true, seats: true } },
      },
    });
    if (!trip || !branchVisible(ctx, trip.plannedTrip?.branchId ?? null)) throw notFound();
    return trip;
  }

  async invoiceOfTrip(db: Db | PrismaService, tripId: string): Promise<string | null> {
    const line = await db.customerInvoiceLine.findFirst({ where: { sourceKey: tripSourceKey(tripId) }, select: { invoiceId: true } });
    return line?.invoiceId ?? null;
  }

  /** Price one trip and append the snapshot (inside `tx`, under a per-trip advisory lock). */
  async priceInTx(tx: Db, ctx: AuthContext, tripId: string, opts: PriceOptions = {}): Promise<SnapshotRow | null> {
    await lockTrip(tx, tripId);
    const trip = await this.loadTrip(tx, ctx, tripId);
    if (await this.invoiceOfTrip(tx, tripId)) {
      if (opts.skipInvoiced) return null;
      throw conflict('ALREADY_INVOICED', 'This trip is on an invoice; its price is frozen. Use an adjustment or a credit note');
    }
    const current = await tx.tripPriceSnapshot.findFirst({ where: { transportTripId: tripId, passengerId: null, isCurrent: true } });
    const pt = trip.plannedTrip;
    const serviceDate = ymd(trip.serviceDate);
    const customer = trip.customerCompanyId && trip.customerCompanyId !== trip.providerCompanyId ? trip.customerCompanyId : null;
    const objectId = pt?.objectId ?? null;
    const branchId = pt?.branchId ?? null;
    const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const profile = objectId ? await tx.transportVehicleProfile.findUnique({ where: { objectId }, select: { category: true, seats: true } }) : null;

    // Precedence 1 / 4 (§5.7): ACTIVE contracts with a version covering the service date are priceable. QA 4: a
    // SUSPENDED contract, a version gap or an inactive agreement is still the customer's contract and is passed with a
    // non-ACTIVE status, so the company default is never used instead (explicit NO_APPLICABLE_PRICING).
    const all = await tx.pricingContract.findMany({ where: { companyId: ctx.companyId, status: { in: ['ACTIVE', 'SUSPENDED'] } } });
    const active = all.filter((c) => c.status === 'ACTIVE');
    const candidates: ContractCandidate[] = [];
    const versions = new Map<string, NonNullable<Awaited<ReturnType<PricingContractsService['versionFor']>>>>();
    for (const c of all) {
      const base = { id: c.id, customerCompanyId: c.customerCompanyId, isDefault: c.isDefault, branchIds: c.branchIds, validFrom: serviceDate, validTo: null, defaultCovers: c.defaultCovers as ('INTERNAL' | 'EXTERNAL')[] };
      if (c.status !== 'ACTIVE') {
        candidates.push({ ...base, status: 'SUSPENDED' });
        continue;
      }
      if (c.agreementId) {
        const a = await tx.transportServiceAgreement.findUnique({ where: { id: c.agreementId }, select: { status: true } });
        if (a?.status !== 'ACTIVE') {
          candidates.push({ ...base, status: 'AGREEMENT_INACTIVE' }); // §3.1: a suspended / ended agreement suspends billing
          continue;
        }
      }
      const v = await this.contracts.versionFor(tx, c.id, serviceDate);
      if (!v) {
        candidates.push({ ...base, status: 'NO_VERSION' });
        continue;
      }
      versions.set(c.id, v);
      candidates.push({ ...base, status: 'ACTIVE', validFrom: ymd(v.validFrom), validTo: v.validTo ? ymd(v.validTo) : null });
    }
    const sel = selectContract(candidates, { customerCompanyId: customer, branchId, vehicleCategory: profile?.category ?? null, serviceDate });

    const plannedM = trip.routeAssignment?.distanceM ?? null;
    const gpsM = pt?.distanceKm !== null && pt?.distanceKm !== undefined ? Math.round(pt.distanceKm * 1000) : null;
    const plannedDurationS = pt ? Math.max(0, Math.round((pt.plannedEnd.getTime() - pt.plannedStart.getTime()) / 1000)) : null;
    const actualDurationS = pt?.actualStart && pt.actualEnd ? Math.max(0, Math.round((pt.actualEnd.getTime() - pt.actualStart.getTime()) / 1000)) : null;
    const waitingS = actualDurationS !== null && plannedDurationS !== null ? Math.max(0, actualDurationS - plannedDurationS) : null;
    const manualM = opts.manualDistanceM !== undefined ? opts.manualDistanceM : (current?.manualDistanceM ?? null);
    const base = {
      companyId: ctx.companyId,
      transportTripId: tripId,
      customerCompanyId: customer,
      branchId,
      objectId,
      serviceDate: trip.serviceDate,
      plannedDistanceM: plannedM,
      gpsDistanceM: gpsM,
      manualDistanceM: manualM,
      plannedDurationS,
      actualDurationS,
      waitingS,
      reason: opts.reason ?? null,
      calculatedById: ctx.userId ?? null,
      engineVersion: PRICING_ENGINE_VERSION,
      supersedesId: current?.id ?? null,
    };

    let data: Prisma.TripPriceSnapshotUncheckedCreateInput;
    if (!sel.ok) {
      data = { ...base, currency: 'XXX', status: 'NO_APPLICABLE_PRICING', gpsQuality: gpsM === null ? 'MISSING' : 'OK', issues: asJson([{ code: 'NO_APPLICABLE_PRICING', message: sel.reason }]) };
    } else {
      const contract = active.find((c) => c.id === sel.contractId)!;
      const version = versions.get(contract.id)!;
      let components = engineComponents(version.components);
      const issues: PricingIssue[] = [];
      const { rate, permitted } = await this.contracts.vehicleRateFor(tx, contract, objectId, serviceDate);
      if (rate && permitted) components = mergeVehicleOverrides(components, sanitizeComponents(rate.componentOverrides));
      if (rate && !permitted) issues.push({ code: 'VEHICLE_OVERRIDE_NOT_PERMITTED', message: 'A vehicle rate exists but the contract does not permit vehicle overrides; the contract rate was used' });
      const policies = (version.policies ?? {}) as PricingPolicies;
      const agreedM = agreedMetres(components);
      const dist = resolveBillableDistance({
        source: contract.distanceSource as DistanceSource,
        onMissingGps: contract.onMissingGps as MissingGpsPolicy,
        plannedM,
        gpsM,
        agreedM,
        manualM,
        gpsMinPctOfPlanned: policies.gpsMinPctOfPlanned,
        gpsMaxPctOfPlanned: policies.gpsMaxPctOfPlanned,
      });
      const assignment = objectId
        ? await tx.pricingVehicleAssignment.findFirst({ where: { contractId: contract.id, objectId, status: 'ACTIVE', validFrom: { lte: trip.serviceDate }, OR: [{ validTo: null }, { validTo: { gt: trip.serviceDate } }] } })
        : null;
      const start = pt?.actualStart ?? pt?.plannedStart ?? null;
      const minute = start ? localMinuteOfDay(start, company.timezone) : null;
      const hours = (assignment?.operatingHours ?? {}) as { from?: string; to?: string };
      const inHours = (() => {
        if (!assignment) return false;
        if (!hours.from || !hours.to || minute === null) return true;
        const [fh, fm] = hours.from.split(':').map(Number);
        const [th, tm] = hours.to.split(':').map(Number);
        const f = fh * 60 + fm;
        const t = th * 60 + tm;
        return f <= t ? minute >= f && minute < t : minute >= f || minute < t;
      })();
      // QA 11: the cancellation time is the trip's cancellation event (cancelledAt), never a later row update. A trip
      // cancelled on the vehicle side without that time cannot be judged against the free-cancellation window: review.
      const cancelledAt = trip.cancelledAt;
      const cancelledUnknown = !cancelledAt && pt?.status === 'CANCELLED';
      if (cancelledUnknown) issues.push({ code: 'MISSING_FACT', message: 'The trip was cancelled but the cancellation time is unknown; review the cancellation charge' });
      const tax = await this.settings.taxConfigFor(tx, ctx.companyId, contract, serviceDate);
      const estimate = !pt || !FINAL_TRIP.includes(pt.status);
      const result: PriceResult = priceTrip({
        currency: contract.currency,
        roundingMode: contract.roundingMode as RoundingMode,
        components,
        policies,
        tax,
        estimate,
        overrideMinor: opts.override?.minor ?? null,
        overrideReason: opts.override?.reason ?? null,
        facts: {
          serviceDate,
          startMinuteOfDay: minute,
          billableDistanceM: dist.billableM,
          actualDurationS,
          reservedDurationS: plannedDurationS,
          waitingS,
          stops: pt ? pt.stops.filter((s) => s.status === 'ARRIVED' || s.status === 'DEPARTED').length || pt.stops.length : null,
          passengers: trip.passengers.filter((p) => p.status === 'BOARDED' || p.status === 'DROPPED').reduce((n, p) => n + (p.seats ?? 1), 0),
          tollsMinor: null,
          cancelledMinutesBefore: cancelledAt && pt ? Math.max(0, Math.round((pt.plannedStart.getTime() - cancelledAt.getTime()) / 60_000)) : null,
          ridePreference: null,
          onDedicatedVehicle: !!assignment && inHours,
          vehicleCategory: profile?.category ?? null,
          seats: profile?.seats ?? trip.seatCapacity,
          branchId,
        },
      });
      data = {
        ...base,
        contractId: contract.id,
        contractVersionId: version.id,
        vehicleRateId: rate && permitted ? rate.id : null,
        currency: contract.currency,
        pricingModel: components.find((c) => ['FIXED_TRIP', 'HOURLY', 'PER_KM', 'SLAB_KM', 'BASE_FARE'].includes(c.kind))?.kind ?? null,
        agreedDistanceM: agreedM,
        billableDistanceM: dist.billableM,
        distanceSource: dist.usedSource,
        gpsQuality: dist.gpsQuality,
        extraStops: 0,
        lines: asJson(result.lines.map(lineDto)),
        subtotalMinor: result.subtotalMinor,
        discountMinor: result.discountMinor,
        taxLines: asJson(result.taxLines.map(taxLineDto)),
        taxMinor: result.taxMinor,
        totalMinor: result.totalMinor,
        issues: asJson([...issues, ...result.issues]),
        status: cancelledUnknown && result.status !== 'COVERED' ? 'NEEDS_REVIEW' : result.status,
        ...(opts.override ? { overrideById: opts.override.byId, overrideAt: new Date(), overrideReason: opts.override.reason, overrideApprovedById: opts.override.approvedById } : {}),
      };
    }
    if (current) await tx.tripPriceSnapshot.update({ where: { id: current.id }, data: { isCurrent: false } });
    const row = await tx.tripPriceSnapshot.create({ data });
    await this.audit.record(ctx, { action: current ? 'UPDATE' : 'CREATE', entity: 'trip_price_snapshot', entityId: tripId, details: { snapshotId: row.id, supersedesId: current?.id ?? null, status: row.status, totalMinor: row.totalMinor.toString(), previousTotalMinor: current?.totalMinor.toString() ?? null, currency: row.currency, reason: opts.reason ?? null, manualDistanceM: opts.manualDistanceM ?? null, override: opts.override ? { amountMinor: opts.override.minor.toString(), reason: opts.override.reason, approvedById: opts.override.approvedById } : null } }, tx);
    return row;
  }

  // ───────────── API ─────────────

  async list(ctx: AuthContext, q: TripChargeListQuery): Promise<TripChargeListResponse | StreamableFile> {
    const where: Prisma.TripPriceSnapshotWhereInput = {
      companyId: ctx.companyId,
      isCurrent: true,
      ...branchWhere(ctx),
      ...(q.status ? { status: q.status } : {}),
      ...(q.branchId ? { branchId: q.branchId } : {}),
      ...(q.customerCompanyId ? { customerCompanyId: q.customerCompanyId } : {}),
      ...(q.contractId ? { contractId: q.contractId } : {}),
      ...(q.from || q.to ? { serviceDate: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}) } } : {}),
    };
    const csv = q.format === 'csv';
    const p = csv ? { page: 1, pageSize: 50_000, skip: 0 } : paging(q);
    const [rows, total, sums] = await Promise.all([
      this.prisma.tripPriceSnapshot.findMany({ where, orderBy: [{ serviceDate: 'desc' }, { calculatedAt: 'desc' }], skip: p.skip, take: p.pageSize }),
      this.prisma.tripPriceSnapshot.count({ where }),
      this.prisma.tripPriceSnapshot.groupBy({ by: ['currency'], where, _sum: { totalMinor: true }, _count: { _all: true } }),
    ]);
    const names = new Map((await this.prisma.pricingContract.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contractId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const lines = await this.prisma.customerInvoiceLine.findMany({ where: { sourceKey: { in: rows.map((r) => tripSourceKey(r.transportTripId, r.passengerId)) } }, select: { sourceKey: true, invoiceId: true } });
    const inv = new Map(lines.map((l) => [l.sourceKey, l.invoiceId]));
    const items = rows.map((r) => snapshotDto(r, { contractName: r.contractId ? (names.get(r.contractId) ?? null) : null, invoiceId: inv.get(tripSourceKey(r.transportTripId, r.passengerId)) ?? null }));
    if (csv) {
      return csvFile('trip-charges', items, [
        { header: 'Service date', value: (r) => r.serviceDate },
        { header: 'Trip', value: (r) => r.transportTripId },
        { header: 'Contract', value: (r) => r.contractName },
        { header: 'Status', value: (r) => r.status },
        { header: 'Billable km', value: (r) => (r.distances.billableM === null ? '' : (r.distances.billableM / 1000).toFixed(3)) },
        { header: 'Distance source', value: (r) => r.distanceSource },
        { header: 'GPS quality', value: (r) => r.gpsQuality },
        { header: 'Currency', value: (r) => r.currency },
        { header: 'Subtotal (minor)', value: (r) => r.subtotalMinor },
        { header: 'Tax (minor)', value: (r) => r.taxMinor },
        { header: 'Total (minor)', value: (r) => r.totalMinor },
        { header: 'Invoice', value: (r) => r.invoiceId },
      ]);
    }
    return { items, total, page: p.page, pageSize: p.pageSize, totals: sums.map((s) => ({ currency: s.currency, totalMinor: (s._sum.totalMinor ?? 0n).toString(), count: s._count._all })) };
  }

  async detail(ctx: AuthContext, tripId: string): Promise<TripChargeDetailResponse> {
    await this.loadTrip(this.prisma, ctx, tripId);
    const rows = await this.prisma.tripPriceSnapshot.findMany({ where: { companyId: ctx.companyId, transportTripId: tripId }, orderBy: { calculatedAt: 'desc' } });
    const invoiceId = await this.invoiceOfTrip(this.prisma, tripId);
    const names = new Map((await this.prisma.pricingContract.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contractId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const dtos = rows.map((r) => snapshotDto(r, { contractName: r.contractId ? (names.get(r.contractId) ?? null) : null, invoiceId: r.isCurrent ? invoiceId : null }));
    return { current: dtos.find((d) => d.isCurrent) ?? null, history: dtos.filter((d) => !d.isCurrent), audit: await this.audit.history(ctx, 'trip_price_snapshot', tripId) };
  }

  async recalculate(ctx: AuthContext, tripId: string, reason?: string | null): Promise<TripPriceSnapshotDto> {
    const row = await this.prisma.$transaction((tx) => this.priceInTx(tx, ctx, tripId, { reason: reason?.trim() || 'recalculated' }));
    return snapshotDto(row!);
  }

  /**
   * Manual billable distance (QA 10): a manual value always wins the distance resolution, so it is a price change like
   * an override. Allowed when the contract permits trip overrides or prices on MANUAL_APPROVED distances; when the
   * version policy requires approval it becomes a DISTANCE_CORRECTION adjustment for a second user.
   */
  async setBillableDistance(ctx: AuthContext, tripId: string, distanceKm: string, reason: string): Promise<TripOverrideResponse> {
    const why = reasonOf(reason);
    let m: number;
    try {
      m = kmToMetres(distanceKm);
    } catch {
      throw invalid('distanceKm must be a decimal km value such as "25.4"');
    }
    if (m <= 0 || m > 5_000_000) throw invalid('distanceKm must be between 0 and 5000');
    return this.prisma.$transaction(async (tx) => {
      await this.loadTrip(tx, ctx, tripId);
      const current = await tx.tripPriceSnapshot.findFirst({ where: { transportTripId: tripId, passengerId: null, isCurrent: true } });
      if (!current?.contractId) throw conflict('NO_APPLICABLE_PRICING', 'Price the trip with a contract first (recalculate)');
      const contract = await tx.pricingContract.findFirstOrThrow({ where: { id: current.contractId, companyId: ctx.companyId } });
      if (!contract.allowTripOverrides && contract.distanceSource !== 'MANUAL_APPROVED') throw conflict('TRIP_OVERRIDE_NOT_PERMITTED', 'This contract does not permit manual billable distances');
      if (await this.invoiceOfTrip(tx, tripId)) throw conflict('ALREADY_INVOICED', 'This trip is on an invoice; use an adjustment or a credit note');
      const version = current.contractVersionId ? await tx.pricingContractVersion.findUnique({ where: { id: current.contractVersionId } }) : null;
      if (((version?.policies ?? {}) as PricingPolicies).tripOverrideNeedsApproval) {
        const adj = await tx.billingAdjustment.create({
          data: { companyId: ctx.companyId, contractId: contract.id, transportTripId: tripId, kind: 'DISTANCE_CORRECTION', amountMinor: 0n, currency: contract.currency, data: asJson({ manualDistanceM: m, snapshotId: current.id, previousBillableM: current.billableDistanceM }), reason: why, requestedById: ctx.userId },
        });
        await this.audit.record(ctx, { action: 'CREATE', entity: 'billing_adjustment', entityId: adj.id, after: adj }, tx);
        return { snapshot: null, adjustment: adjustmentDto(adj) };
      }
      const row = await this.priceInTx(tx, ctx, tripId, { reason: `manual distance: ${why}`, manualDistanceM: m });
      return { snapshot: snapshotDto(row!), adjustment: null };
    });
  }

  /**
   * Precedence 3 (§5.7): a negotiated trip price. Needs pricing_trip_charges:command (route guard), a reason, a contract
   * that allows trip overrides and, when its policy says so, a second user's approval (a PRICE_OVERRIDE adjustment).
   */
  async override(ctx: AuthContext, tripId: string, amount: string, reason: string): Promise<TripOverrideResponse> {
    const why = reasonOf(reason);
    return this.prisma.$transaction(async (tx) => {
      await this.loadTrip(tx, ctx, tripId);
      const current = await tx.tripPriceSnapshot.findFirst({ where: { transportTripId: tripId, passengerId: null, isCurrent: true } });
      if (!current?.contractId) throw conflict('NO_APPLICABLE_PRICING', 'Price the trip with a contract first (recalculate)');
      const contract = await tx.pricingContract.findFirstOrThrow({ where: { id: current.contractId, companyId: ctx.companyId } });
      if (!contract.allowTripOverrides) throw conflict('TRIP_OVERRIDE_NOT_PERMITTED', 'This contract does not permit trip price overrides');
      if (await this.invoiceOfTrip(tx, tripId)) throw conflict('ALREADY_INVOICED', 'This trip is on an invoice; use an adjustment or a credit note');
      const minor = majorToMinor(amount, contract.currency, 'amount', { positive: true, allowZero: true });
      const version = current.contractVersionId ? await tx.pricingContractVersion.findUnique({ where: { id: current.contractVersionId } }) : null;
      const policies = (version?.policies ?? {}) as PricingPolicies;
      if (policies.tripOverrideNeedsApproval) {
        const adj = await tx.billingAdjustment.create({
          data: { companyId: ctx.companyId, contractId: contract.id, transportTripId: tripId, kind: 'PRICE_OVERRIDE', amountMinor: minor - current.subtotalMinor, currency: contract.currency, data: asJson({ overrideMinor: minor.toString(), snapshotId: current.id, previousSubtotalMinor: current.subtotalMinor.toString() }), reason: why, requestedById: ctx.userId },
        });
        await this.audit.record(ctx, { action: 'CREATE', entity: 'billing_adjustment', entityId: adj.id, after: adj }, tx);
        return { snapshot: null, adjustment: adjustmentDto(adj) };
      }
      const row = await this.priceInTx(tx, ctx, tripId, { reason: `override: ${why}`, override: { minor, reason: why, byId: ctx.userId, approvedById: null } });
      return { snapshot: snapshotDto(row!), adjustment: null };
    });
  }

  /** Job: price settled trips without a final snapshot (batch-limited, idempotent through the current-snapshot index). */
  async pricePending(ctx: AuthContext, limit = 200, sinceDays = 62): Promise<number> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t."id" FROM "TransportTrip" t JOIN "PlannedTrip" p ON p."id" = t."plannedTripId"
      WHERE t."providerCompanyId" = ${ctx.companyId}::uuid AND p."status"::text IN ('COMPLETED','INCOMPLETE','CANCELLED') AND t."serviceDate" >= ${since}::date
        AND NOT EXISTS (SELECT 1 FROM "TripPriceSnapshot" s WHERE s."transportTripId" = t."id" AND s."isCurrent" AND s."status" <> 'ESTIMATE')
        AND NOT EXISTS (SELECT 1 FROM "CustomerInvoiceLine" l WHERE l."sourceKey" = 'TRIP:' || t."id"::text || ':')
      ORDER BY t."serviceDate" LIMIT ${limit}`;
    let n = 0;
    for (const { id } of ids) {
      const row = await this.prisma.$transaction((tx) => this.priceInTx(tx, ctx, id, { reason: 'trip settled', skipInvoiced: true }));
      if (row) n++;
    }
    return n;
  }
}

export function adjustmentDto(a: Prisma.BillingAdjustmentGetPayload<object>): BillingAdjustmentDto {
  return {
    id: a.id,
    contractId: a.contractId,
    invoiceId: a.invoiceId,
    transportTripId: a.transportTripId,
    kind: a.kind as BillingAdjustmentDto['kind'],
    amountMinor: a.amountMinor.toString(),
    currency: a.currency,
    data: (a.data ?? {}) as Record<string, unknown>,
    reason: a.reason,
    status: a.status as BillingAdjustmentDto['status'],
    requestedById: a.requestedById,
    requestedAt: a.requestedAt.toISOString(),
    decidedById: a.decidedById,
    decidedAt: isoOf(a.decidedAt),
    decisionNote: a.decisionNote,
    appliedAt: isoOf(a.appliedAt),
    version: a.version,
  };
}
