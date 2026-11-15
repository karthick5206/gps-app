import { Controller, Get, Injectable, UseGuards } from '@nestjs/common';
import { inNightWindow, minuteOfDayIn, nightSafetyOf, type SafetyWatchDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { DispatchService } from './dispatch.service';
import { tripReadWhere } from './e3-common';

/** Drops older than this are not watched any more (the desk follows up by phone). */
const WATCH_HOURS = 6;

/**
 * Night-shift reached-home watch (v1.16.7): passengers DROPPED inside the company night window, more than
 * `reachedHomeMin` minutes ago and less than WATCH_HOURS ago, with no PASSENGER_CONFIRM (DROP) event after the drop.
 * Empty while night safety is off. Names only (no phone numbers, no points).
 */
@Injectable()
export class SafetyWatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: DispatchService,
  ) {}

  async get(ctx: AuthContext): Promise<SafetyWatchDto> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true, timezone: true } });
    const night = nightSafetyOf(company.settings);
    if (!night.on) return { nightSafety: night, reachedHomePending: [] };
    const now = Date.now();
    const rows = await this.prisma.transportTripPassenger.findMany({
      where: {
        status: 'DROPPED',
        droppedAt: { gte: new Date(now - WATCH_HOURS * 3_600_000), lte: new Date(now - night.reachedHomeMin * 60_000) },
        trip: tripReadWhere(ctx, await this.dispatch.scopedObjectIds(ctx)),
      },
      select: {
        id: true,
        tripId: true,
        droppedAt: true,
        booking: { select: { profile: { select: { displayName: true } } } },
        trip: { select: { plannedTrip: { select: { objectId: true, routeName: true } } } },
        events: { where: { kind: 'PASSENGER_CONFIRM', reasonCode: 'DROP' }, select: { occurredAt: true } },
      },
      take: 500,
    });
    const pending = rows.filter((r) => r.droppedAt && inNightWindow(minuteOfDayIn(r.droppedAt, company.timezone), night.from, night.to) && !r.events.some((e) => e.occurredAt >= r.droppedAt!));
    const objectIds = [...new Set(pending.flatMap((r) => (r.trip.plannedTrip?.objectId ? [r.trip.plannedTrip.objectId] : [])))];
    const names = new Map((await this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return {
      nightSafety: night,
      reachedHomePending: pending
        .map((r) => ({
          passengerTripId: r.id,
          tripId: r.tripId,
          tripName: r.trip.plannedTrip?.routeName ?? '',
          vehicleName: names.get(r.trip.plannedTrip?.objectId ?? '') ?? null,
          passenger: r.booking.profile.displayName,
          droppedAt: r.droppedAt!.toISOString(),
          minutesAgo: Math.round((now - r.droppedAt!.getTime()) / 60_000),
        }))
        .sort((a, b) => b.minutesAgo - a.minutesAgo),
    };
  }
}

/** GET /api/transport/safety-watch (Daily transport → Needs attention). */
@Controller('transport/safety-watch')
@UseGuards(TransportFeatureGuard)
export class SafetyWatchController {
  constructor(private readonly watch: SafetyWatchService) {}

  @Get() @RequirePermission('etms_dispatch', 'view')
  get(@Auth() ctx: AuthContext): Promise<SafetyWatchDto> {
    return this.watch.get(ctx);
  }
}
