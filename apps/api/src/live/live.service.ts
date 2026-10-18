import { Injectable } from '@nestjs/common';
import { DashboardSummary, LiveObject, MOVEMENT_STATUSES } from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveSpeedLimit, noDataLive, ObjectMeta } from '../tracking/live-object';
import { LiveStateService } from './live-state.service';

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liveState: LiveStateService,
  ) {}

  /** Every active object in scope; DB metadata wins over the cached copy inside the live state. */
  async snapshot(ctx: AuthContext): Promise<LiveObject[]> {
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), { isActive: true }] },
      select: {
        id: true,
        companyId: true,
        branchId: true,
        name: true,
        plateNumber: true,
        type: true,
        vehicleType: true,
        speedLimitKph: true,
        assignments: { where: { toTime: null }, select: { device: { select: { id: true, uniqueId: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    const live = await this.liveState.read(objects.map((o) => o.id));
    return objects.map((o) => {
      const device = o.assignments[0]?.device ?? null;
      const meta: ObjectMeta = {
        objectId: o.id,
        companyId: o.companyId,
        branchId: o.branchId,
        name: o.name,
        plateNumber: o.plateNumber,
        type: o.type,
        vehicleType: o.vehicleType,
        deviceId: device?.id ?? null,
        uniqueId: device?.uniqueId ?? null,
        speedLimitKph: effectiveSpeedLimit(o.speedLimitKph, o.type, o.vehicleType),
      };
      const state = live.get(o.id);
      return state ? { ...state, ...meta } : noDataLive(meta);
    });
  }

  async summary(ctx: AuthContext): Promise<DashboardSummary> {
    const objects = await this.snapshot(ctx);
    const byStatus: Record<string, number> = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, 0]));
    let devicesOnline = 0;
    for (const o of objects) {
      byStatus[o.status] += 1;
      if (o.deviceId && o.status !== 'OFFLINE' && o.status !== 'NO_DATA') devicesOnline += 1;
    }
    return { total: objects.length, byStatus, devicesOnline };
  }
}
