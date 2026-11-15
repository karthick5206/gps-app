import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addDaysYmd,
  daysBetweenInclusive,
  isYmd,
  periodBounds,
  pricePeriod,
  type AvailabilityCloseResponse,
  type AvailabilityFrequency,
  type AvailabilityListQuery,
  type AvailabilityPeriodDto,
  type AvailabilityPeriodStatus,
  type PeriodFacts,
  type PricingIssue,
  type PricingPage,
  type PricingPolicies,
  type RoundingMode,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingRunsService, runDto } from './billing-runs.service';
import { engineComponents, PricingContractsService } from './contracts.service';
import { asJson, branchWhere, conflict, contractVisible, invalid, isoOf, jsonLines, jsonTaxLines, lineDto, localMinuteOfDay, notFound, pageOf, paging, taxLineDto, ymd, type Db } from './pricing-common';
import { PricingSettingsService } from './settings.service';

type PeriodRow = Prisma.AvailabilityBillingPeriodGetPayload<object>;
export const periodSourceKey = (periodId: string) => `PERIOD:${periodId}`;

export function periodDto(p: PeriodRow, objectName: string | null = null): AvailabilityPeriodDto {
  return {
    id: p.id,
    contractId: p.contractId,
    versionId: p.versionId,
    assignmentId: p.assignmentId,
    objectId: p.objectId,
    objectName,
    branchId: p.branchId,
    periodStart: ymd(p.periodStart),
    periodEnd: ymd(p.periodEnd),
    frequency: p.frequency as AvailabilityFrequency,
    currency: p.currency,
    attachedDays: p.attachedDays,
    billableDays: p.billableDays,
    downtimeDays: p.downtimeDays,
    suspensionDays: p.suspensionDays,
    usedDistanceM: p.usedDistanceM,
    usedSeconds: p.usedSeconds,
    tripCount: p.tripCount,
    lines: jsonLines(p.lines),
    subtotalMinor: p.subtotalMinor.toString(),
    discountMinor: p.discountMinor.toString(),
    taxLines: jsonTaxLines(p.taxLines),
    taxMinor: p.taxMinor.toString(),
    totalMinor: p.totalMinor.toString(),
    issues: (Array.isArray(p.issues) ? p.issues : []) as unknown as PricingIssue[],
    status: p.status as AvailabilityPeriodStatus,
    calculatedAt: p.calculatedAt.toISOString(),
    closedAt: isoOf(p.closedAt),
  };
}

/** Days of [aStart, aEnd] ∩ [bStart, bEnd] (inclusive ymd strings); 0 when disjoint. */
function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return s > e ? 0 : daysBetweenInclusive(s, e);
}

/**
 * Doc 19 §3.2 / §5.5 availability billing, independent of trips: one period per dedicated vehicle and billing period,
 * charged even with zero trips when the contract says so; downtime / suspension prorate it, a replacement billed under
 * the original keeps the original's days, km come from the GPS day summaries, excess km is billed once here (never per
 * trip). Close = BillingRun claim (unique per contract + period) → periods CLOSED (immutable, trigger).
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contracts: PricingContractsService,
    private readonly settings: PricingSettingsService,
    private readonly runs: BillingRunsService,
  ) {}

  async list(ctx: AuthContext, q: AvailabilityListQuery): Promise<PricingPage<AvailabilityPeriodDto>> {
    const p = paging(q);
    const where: Prisma.AvailabilityBillingPeriodWhereInput = {
      companyId: ctx.companyId,
      ...branchWhere(ctx),
      ...(q.contractId ? { contractId: q.contractId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from ? { periodEnd: { gte: new Date(`${q.from}T00:00:00Z`) } } : {}),
      ...(q.to ? { periodStart: { lte: new Date(`${q.to}T00:00:00Z`) } } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.availabilityBillingPeriod.findMany({ where, orderBy: [{ periodStart: 'desc' }], skip: p.skip, take: p.pageSize }), this.prisma.availabilityBillingPeriod.count({ where })]);
    const names = await this.objectNames(rows.map((r) => r.assignmentId));
    return pageOf(rows.map((r) => periodDto(r, names.get(r.assignmentId) ?? null)), total, p);
  }

  private async objectNames(assignmentIds: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.pricingVehicleAssignment.findMany({ where: { id: { in: [...new Set(assignmentIds)] } }, select: { id: true, objectName: true } });
    return new Map(rows.map((r) => [r.id, r.objectName]));
  }

  /** Bounds of the billing period containing `date` for the contract (fee frequency for WEEKLY / MONTHLY fees). */
  async boundsFor(db: Db | PrismaService, contract: { id: string; billingFrequency: string }, date: string) {
    const version = await this.contracts.versionFor(db, contract.id, date);
    if (!version) throw conflict('CONTRACT_NOT_ACTIVE', 'No approved version covers this date');
    const fee = version.components.find((c) => c.kind === 'AVAILABILITY_FEE');
    if (!fee) throw conflict('NO_APPLICABLE_PRICING', 'This contract version has no availability fee');
    const feeFreq = ((fee.params ?? {}) as { frequency?: AvailabilityFrequency }).frequency ?? 'MONTHLY';
    const frequency: AvailabilityFrequency = feeFreq !== 'DAILY' ? feeFreq : contract.billingFrequency === 'TRIP' ? 'DAILY' : (contract.billingFrequency as AvailabilityFrequency);
    const { start, end } = periodBounds(frequency, date);
    return { version, frequency, start, end };
  }

  /** Recompute the OPEN / NEEDS_REVIEW periods of (contract, period); CLOSED / INVOICED ones are left as they are. */
  async computeInTx(tx: Db, ctx: AuthContext, contractId: string, date: string): Promise<PeriodRow[]> {
    if (!isYmd(date)) throw invalid('periodDate must be a date YYYY-MM-DD');
    const contract = await tx.pricingContract.findFirst({ where: { id: contractId, companyId: ctx.companyId } });
    if (!contract || !contractVisible(ctx, contract)) throw notFound();
    const { version, frequency, start, end } = await this.boundsFor(tx, contract, date);
    const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const policies = (version.policies ?? {}) as PricingPolicies;
    const calendar = policies.calendarId ? await tx.pricingCalendar.findFirst({ where: { id: policies.calendarId, companyId: ctx.companyId } }) : null;
    const startD = new Date(`${start}T00:00:00Z`);
    const endD = new Date(`${end}T00:00:00Z`);
    const assignments = await tx.pricingVehicleAssignment.findMany({
      where: { contractId, companyId: ctx.companyId, validFrom: { lte: endD }, OR: [{ validTo: null }, { validTo: { gt: startD } }] },
      include: { downtimes: true },
    });
    const tax = await this.settings.taxConfigFor(tx, ctx.companyId, contract, end);
    const out: PeriodRow[] = [];
    for (const a of assignments) {
      const aStart = ymd(a.validFrom);
      const aEnd = a.validTo ? addDaysYmd(ymd(a.validTo), -1) : end; // validTo exclusive
      const attachedDays = overlapDays(aStart, aEnd, start, end);
      if (attachedDays <= 0) continue;
      const winStart = aStart > start ? aStart : start;
      const winEnd = aEnd < end ? aEnd : end;
      let downtimeDays = 0;
      let suspensionDays = 0;
      for (const d of a.downtimes.filter((x) => !x.billable)) {
        const n = overlapDays(ymd(d.fromDate), ymd(d.toDate), winStart, winEnd);
        if (d.kind === 'SUSPENSION') suspensionDays += n;
        else downtimeDays += n;
      }
      // Replacement (§3.2 replacementBilling ORIGINAL): its days count for the original, which keeps them billable.
      const replacements = assignments.filter((r) => r.replacesAssignmentId === a.id && r.replacementBilling === 'ORIGINAL');
      const replacementCoveredDays = Math.min(downtimeDays, replacements.reduce((n, r) => n + overlapDays(ymd(r.validFrom), r.validTo ? addDaysYmd(ymd(r.validTo), -1) : end, winStart, winEnd), 0));
      const billedUnderOriginal = !!a.replacesAssignmentId && a.replacementBilling === 'ORIGINAL';
      const summaries = await tx.dailySummary.findMany({ where: { objectId: a.objectId, day: { gte: new Date(`${winStart}T00:00:00Z`), lte: new Date(`${winEnd}T00:00:00Z`) } }, select: { day: true, distanceKm: true, runningSec: true, idleSec: true } });
      const usedDistanceM = summaries.reduce((n, s) => n + Math.round(s.distanceKm * 1000), 0);
      const usedDurationS = summaries.reduce((n, s) => n + s.runningSec + s.idleSec, 0);
      const trips = await tx.plannedTrip.findMany({
        where: { companyId: ctx.companyId, objectId: a.objectId, status: { in: ['COMPLETED', 'INCOMPLETE', 'STARTED', 'IN_PROGRESS'] }, plannedStart: { gte: new Date(`${winStart}T00:00:00Z`), lt: new Date(`${addDaysYmd(winEnd, 1)}T00:00:00Z`) } },
        select: { actualStart: true, actualEnd: true, plannedStart: true },
      });
      const hours = (a.operatingHours ?? {}) as { from?: string; to?: string };
      let overtimeS = 0;
      if (hours.from && hours.to) {
        const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
        const f = toMin(hours.from);
        const t = toMin(hours.to);
        for (const tr of trips) {
          if (!tr.actualStart || !tr.actualEnd) continue;
          const m = localMinuteOfDay(tr.actualStart, company.timezone);
          const inside = f <= t ? m >= f && m < t : m >= f || m < t;
          if (!inside) overtimeS += Math.max(0, Math.round((tr.actualEnd.getTime() - tr.actualStart.getTime()) / 1000));
        }
      }
      const holidays = new Set(calendar?.holidays ?? []);
      const holidayDaysWorked = summaries.filter((s) => s.distanceKm > 0 && holidays.has(ymd(s.day))).length;
      const facts: PeriodFacts = { frequency, periodStart: start, periodEnd: end, attachedDays, downtimeDays, suspensionDays, replacementCoveredDays, holidayDaysWorked, usedDistanceM, usedDurationS, overtimeS, tripCount: trips.length, billedUnderOriginal, branchId: a.branchId };
      const result = pricePeriod({ currency: contract.currency, roundingMode: contract.roundingMode as RoundingMode, components: engineComponents(version.components), policies, facts, tax });
      const status = result.status === 'PRICED' ? 'OPEN' : 'NEEDS_REVIEW';
      const billableDays = Math.max(0, Math.min(attachedDays, attachedDays - downtimeDays - suspensionDays + replacementCoveredDays));
      const data = {
        versionId: version.id,
        objectId: a.objectId,
        branchId: a.branchId,
        periodEnd: endD,
        currency: contract.currency,
        attachedDays,
        billableDays,
        downtimeDays,
        suspensionDays,
        usedDistanceM,
        usedSeconds: usedDurationS,
        tripCount: trips.length,
        lines: asJson(result.lines.map(lineDto)),
        subtotalMinor: result.subtotalMinor,
        discountMinor: result.discountMinor,
        taxLines: asJson(result.taxLines.map(taxLineDto)),
        taxMinor: result.taxMinor,
        totalMinor: result.totalMinor,
        issues: asJson(result.issues),
        status,
        calculatedAt: new Date(),
      };
      const existing = await tx.availabilityBillingPeriod.findUnique({ where: { assignmentId_periodStart_frequency: { assignmentId: a.id, periodStart: startD, frequency } } });
      if (existing && !['OPEN', 'NEEDS_REVIEW'].includes(existing.status)) {
        out.push(existing);
        continue;
      }
      const row = existing
        ? await tx.availabilityBillingPeriod.update({ where: { id: existing.id }, data })
        : await tx.availabilityBillingPeriod.create({ data: { ...data, companyId: ctx.companyId, contractId, assignmentId: a.id, periodStart: startD, frequency } });
      out.push(row);
    }
    return out;
  }

  async compute(ctx: AuthContext, contractId: string, date: string): Promise<AvailabilityPeriodDto[]> {
    const rows = await this.prisma.$transaction((tx) => this.computeInTx(tx, ctx, contractId, date), { timeout: 60_000 });
    const names = await this.objectNames(rows.map((r) => r.assignmentId));
    return rows.map((r) => periodDto(r, names.get(r.assignmentId) ?? null));
  }

  /** Close the period (idempotent: one AVAILABILITY_CLOSE run per contract + periodStart; same key + body replays). */
  async close(ctx: AuthContext, contractId: string, date: string, key: string | null): Promise<AvailabilityCloseResponse> {
    const contract = await this.prisma.pricingContract.findFirst({ where: { id: contractId, companyId: ctx.companyId } });
    if (!contract || !contractVisible(ctx, contract)) throw notFound();
    const { start, end } = await this.boundsFor(this.prisma, contract, date);
    const claim = await this.runs.claim(ctx, { contractId, kind: 'AVAILABILITY_CLOSE', periodStart: start, periodEnd: end, key, body: { contractId, periodStart: start } });
    if (claim.replay) {
      const periods = await this.prisma.availabilityBillingPeriod.findMany({ where: { contractId, periodStart: new Date(`${start}T00:00:00Z`) } });
      const names = await this.objectNames(periods.map((r) => r.assignmentId));
      return { run: runDto(claim.run), periods: periods.map((p) => periodDto(p, names.get(p.assignmentId) ?? null)) };
    }
    try {
      const rows = await this.prisma.$transaction(
        async (tx) => {
          const computed = await this.computeInTx(tx, ctx, contractId, date);
          const closed: PeriodRow[] = [];
          for (const r of computed) {
            if (r.status !== 'OPEN') {
              closed.push(r);
              continue;
            }
            const c = await tx.availabilityBillingPeriod.update({ where: { id: r.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: ctx.userId ?? null } });
            await this.audit.record(ctx, { action: 'UPDATE', entity: 'availability_period', entityId: c.id, details: { event: 'CLOSED', contractId, periodStart: start, totalMinor: c.totalMinor.toString(), currency: c.currency } }, tx);
            closed.push(c);
          }
          return closed;
        },
        { timeout: 60_000 },
      );
      const run = await this.runs.finish(claim.run.id, 'DONE', { periods: rows.length, closed: rows.filter((r) => r.status === 'CLOSED').length, needsReview: rows.filter((r) => r.status === 'NEEDS_REVIEW').length });
      const names = await this.objectNames(rows.map((r) => r.assignmentId));
      return { run: runDto(run), periods: rows.map((r) => periodDto(r, names.get(r.assignmentId) ?? null)) };
    } catch (e) {
      await this.runs.finish(claim.run.id, 'FAILED', {}, (e as Error).message);
      throw e;
    }
  }
}

export { overlapDays };
