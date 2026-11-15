import { BadRequestException, Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import {
  INSIGHTS_MAX_DAYS,
  ON_TIME_GRACE_MIN,
  pct,
  type TransportInsightsDay,
  type TransportInsightsDto,
  type TransportInsightsShift,
  type TransportInsightsVehicle,
} from '@veetracer/shared';
import { IsOptional, Matches } from 'class-validator';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { DispatchService } from './dispatch.service';
import { dateOnly, tripReadWhere } from './e3-common';
import { UNSEATED_STATUSES } from './booking-generator.service';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class InsightsQuery {
  @Matches(DAY_RE, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @IsOptional() @Matches(DAY_RE, { message: 'to must be YYYY-MM-DD' }) to?: string;
}

/** One trip as the aggregation needs it (pure input, testable). */
export interface InsightTrip {
  day: string;
  direction: 'IN' | 'OUT';
  shift: string | null;
  objectId: string | null;
  vehicle: string | null;
  plateNumber: string | null;
  status: string | null;
  cancelled: boolean;
  seatCapacity: number;
  occupiedSeats: number;
  km: number | null;
  passengers: { status: string; pickupSeq: number }[];
  stops: { seq: number; plannedArrival: Date; actualArrival: Date | null }[];
}

const GRACE_MS = ON_TIME_GRACE_MIN * 60_000;

/** Pickup stops reached / reached on time of one trip. */
function punctuality(t: InsightTrip): { reached: number; onTime: number } {
  const pickupSeqs = new Set(t.passengers.filter((p) => p.status !== 'CANCELLED').map((p) => p.pickupSeq));
  let reached = 0;
  let onTime = 0;
  for (const s of t.stops) {
    if (!pickupSeqs.has(s.seq) || !s.actualArrival) continue;
    reached++;
    if (s.actualArrival.getTime() <= s.plannedArrival.getTime() + GRACE_MS) onTime++;
  }
  return { reached, onTime };
}

/** Aggregates trips + booking / incident counts into the dashboard DTO (pure). */
export function aggregateInsights(from: string, to: string, trips: InsightTrip[], bookings: number, missedBookings: number, incidents: number): TransportInsightsDto {
  const live = trips.filter((t) => !t.cancelled);
  const seated = (t: InsightTrip) => t.passengers.filter((p) => p.status !== 'CANCELLED');
  const count = (t: InsightTrip, s: string) => t.passengers.filter((p) => p.status === s).length;
  const boardedOf = (t: InsightTrip) => count(t, 'BOARDED') + count(t, 'DROPPED');
  let reached = 0;
  let onTime = 0;
  for (const t of live) {
    const p = punctuality(t);
    reached += p.reached;
    onTime += p.onTime;
  }
  const boarded = live.reduce((s, t) => s + boardedOf(t), 0);
  const noShows = live.reduce((s, t) => s + count(t, 'NO_SHOW'), 0);
  const cap = live.reduce((s, t) => s + t.seatCapacity, 0);
  const occ = live.reduce((s, t) => s + t.occupiedSeats, 0);
  const km = (list: InsightTrip[]) => Math.round(list.reduce((s, t) => s + (t.km ?? 0), 0) * 10) / 10;

  const byDay = new Map<string, InsightTrip[]>();
  const byVehicle = new Map<string, InsightTrip[]>();
  const byShift = new Map<string, InsightTrip[]>();
  for (const t of live) {
    byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
    if (t.objectId) byVehicle.set(t.objectId, [...(byVehicle.get(t.objectId) ?? []), t]);
    const k = `${t.shift ?? 'One-off'}|${t.direction}`;
    byShift.set(k, [...(byShift.get(k) ?? []), t]);
  }
  const punct = (list: InsightTrip[]) => {
    const r = list.map(punctuality);
    return pct(
      r.reduce((s, x) => s + x.onTime, 0),
      r.reduce((s, x) => s + x.reached, 0),
    );
  };
  const days: TransportInsightsDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({ day, trips: list.length, passengers: list.reduce((s, t) => s + seated(t).length, 0), km: km(list), onTimePct: punct(list), noShows: list.reduce((s, t) => s + count(t, 'NO_SHOW'), 0) }));
  const vehicles: TransportInsightsVehicle[] = [...byVehicle.entries()]
    .map(([objectId, list]) => ({
      objectId,
      vehicle: list[0].vehicle ?? '—',
      plateNumber: list[0].plateNumber,
      trips: list.length,
      tripsCompleted: list.filter((t) => t.status === 'COMPLETED').length,
      km: km(list),
      passengers: list.reduce((s, t) => s + seated(t).length, 0),
      seatUsePct: pct(
        list.reduce((s, t) => s + t.occupiedSeats, 0),
        list.reduce((s, t) => s + t.seatCapacity, 0),
      ),
      onTimePct: punct(list),
    }))
    .sort((a, b) => b.trips - a.trips || a.vehicle.localeCompare(b.vehicle));
  const shifts: TransportInsightsShift[] = [...byShift.entries()]
    .map(([k, list]) => ({ shift: k.split('|')[0], direction: k.split('|')[1] as 'IN' | 'OUT', trips: list.length, passengers: list.reduce((s, t) => s + seated(t).length, 0), noShows: list.reduce((s, t) => s + count(t, 'NO_SHOW'), 0) }))
    .sort((a, b) => a.shift.localeCompare(b.shift) || a.direction.localeCompare(b.direction));

  return {
    from,
    to,
    kpis: {
      trips: trips.length,
      tripsCompleted: live.filter((t) => t.status === 'COMPLETED' || t.status === 'INCOMPLETE').length,
      tripsCancelled: trips.filter((t) => t.cancelled).length,
      tripsRunning: live.filter((t) => t.status === 'STARTED' || t.status === 'IN_PROGRESS').length,
      tripsNotStarted: live.filter((t) => t.status === 'SCHEDULED').length,
      passengers: live.reduce((s, t) => s + seated(t).length, 0),
      boarded,
      noShows,
      noShowPct: pct(noShows, boarded + noShows),
      onTimePct: pct(onTime, reached),
      seatUsePct: pct(occ, cap),
      km: km(live),
      bookings,
      missedBookings,
      incidents,
    },
    days,
    vehicles,
    shifts,
  };
}

@Injectable()
export class TransportInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: DispatchService,
  ) {}

  async get(ctx: AuthContext, q: InsightsQuery): Promise<TransportInsightsDto> {
    const from = q.from;
    const to = q.to ?? q.from;
    if (to < from) throw new BadRequestException('to must not be before from');
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 > INSIGHTS_MAX_DAYS) throw new BadRequestException(`At most ${INSIGHTS_MAX_DAYS} days at a time`);
    const range = { gte: dateOnly(from), lte: dateOnly(to) };
    const rows = await this.prisma.transportTrip.findMany({
      where: { AND: [tripReadWhere(ctx, await this.dispatch.scopedObjectIds(ctx)), { serviceDate: range }] },
      select: {
        serviceDate: true,
        direction: true,
        seatCapacity: true,
        occupiedSeats: true,
        cancelledAt: true,
        shift: { select: { name: true } },
        passengers: { select: { status: true, pickupSeq: true } },
        plannedTrip: { select: { status: true, distanceKm: true, objectId: true, stops: { select: { seq: true, plannedArrival: true, actualArrival: true } } } },
      },
      take: 20_000,
    });
    const objectIds = [...new Set(rows.flatMap((r) => (r.plannedTrip?.objectId ? [r.plannedTrip.objectId] : [])))];
    const objects = new Map((await this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true, plateNumber: true } })).map((o) => [o.id, o]));
    const trips: InsightTrip[] = rows.map((r) => ({
      day: r.serviceDate.toISOString().slice(0, 10),
      direction: r.direction as 'IN' | 'OUT',
      shift: r.shift?.name ?? null,
      objectId: r.plannedTrip?.objectId ?? null,
      vehicle: objects.get(r.plannedTrip?.objectId ?? '')?.name ?? null,
      plateNumber: objects.get(r.plannedTrip?.objectId ?? '')?.plateNumber ?? null,
      status: r.plannedTrip?.status ?? null,
      cancelled: !!r.cancelledAt || r.plannedTrip?.status === 'CANCELLED',
      seatCapacity: r.seatCapacity,
      occupiedSeats: r.occupiedSeats,
      km: r.plannedTrip?.distanceKm ?? null,
      passengers: r.passengers.map((p) => ({ status: p.status, pickupSeq: p.pickupSeq })),
      stops: r.plannedTrip?.stops ?? [],
    }));
    const [bookings, missed, incidents] = await Promise.all([
      this.prisma.transportBooking.count({ where: { OR: [{ customerCompanyId: ctx.companyId }, { providerCompanyId: ctx.companyId }], serviceDate: range } }),
      this.prisma.transportBooking.count({ where: { OR: [{ customerCompanyId: ctx.companyId }, { providerCompanyId: ctx.companyId }], serviceDate: range, status: { in: [...UNSEATED_STATUSES, 'EXPIRED'] }, windowEnd: { lt: new Date() } } }),
      this.prisma.transportIncident.count({ where: { OR: [{ customerCompanyId: ctx.companyId }, { providerCompanyId: ctx.companyId }], createdAt: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000) } } }),
    ]);
    return aggregateInsights(from, to, trips, bookings, missed, incidents);
  }
}

/** GET /api/transport/insights?from=YYYY-MM-DD&to=YYYY-MM-DD — Transport dashboard and management reports. */
@Controller('transport/insights')
@UseGuards(TransportFeatureGuard)
export class TransportInsightsController {
  constructor(private readonly insights: TransportInsightsService) {}

  @Get() @RequirePermission('etms_dashboard', 'view')
  get(@Auth() ctx: AuthContext, @Query() q: InsightsQuery): Promise<TransportInsightsDto> {
    return this.insights.get(ctx, q);
  }
}
