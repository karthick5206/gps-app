import { Injectable, Logger } from '@nestjs/common';
import { type PlannedTripLiveUpdate, type PlannedTripStatus, type PlannedStopStatus } from '@veetracer/shared';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';

/**
 * After an E3 write that changes planned trips: invalidate the processor's trip cache (the v1.8 tracker picks the trip
 * up, 02 §5.4) and push the existing `plannedTrip.update` socket event (05 §5.1: reused unchanged for ETMS trips) so
 * dispatcher screens refresh. Clients refetch the transport trip on any update of its plannedTripId (passenger names
 * never travel on the socket). Best effort: a failed push never fails the committed write.
 */
@Injectable()
export class TripLiveService {
  private readonly logger = new Logger('EtmsTripLive');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly plannedTrips: PlannedTripsService,
  ) {}

  async changed(companyId: string, plannedTripIds: (string | null | undefined)[]): Promise<void> {
    const ids = [...new Set(plannedTripIds.filter((x): x is string => !!x))];
    try {
      await this.plannedTrips.invalidate(companyId);
      if (!ids.length) return;
      const rows = await this.prisma.plannedTrip.findMany({ where: { id: { in: ids }, companyId }, include: { stops: { orderBy: { seq: 'asc' } } } });
      for (const t of rows) {
        const update: PlannedTripLiveUpdate = {
          id: t.id,
          status: t.status as PlannedTripStatus,
          nextStopSeq: t.nextStopSeq,
          etaNextStop: t.etaNextStop?.toISOString() ?? null,
          delaySec: t.delaySec,
          actualStart: t.actualStart?.toISOString() ?? null,
          actualEnd: t.actualEnd?.toISOString() ?? null,
          deviationCount: t.deviationCount,
          maxDeviationM: t.maxDeviationM,
          stops: t.stops.map((s) => ({ seq: s.seq, status: s.status as PlannedStopStatus, actualArrival: s.actualArrival?.toISOString() ?? null, actualDeparture: s.actualDeparture?.toISOString() ?? null, delaySec: s.delaySec })),
        };
        await this.redis.client.publish(RedisKeys.plannedTripUpdates, JSON.stringify({ companyId, objectId: t.objectId, update }));
      }
    } catch (error) {
      this.logger.warn(`Live update failed: ${(error as Error).message}`);
    }
  }
}
