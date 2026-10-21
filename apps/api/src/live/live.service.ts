import { Injectable, Optional } from '@nestjs/common';
import { DashboardSummary, LiveObject, MOVEMENT_STATUSES } from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveSpeedLimit, noDataLive, ObjectMeta } from '../tracking/live-object';
import { LiveStateService } from './live-state.service';

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liveState: LiveStateService,
    @Optional() private readonly licences?: LicencePolicyService,
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
        maintenanceSince: true,
        assignments: { where: { toTime: null }, select: { device: { select: { id: true, uniqueId: true, simNumber: true } } } },
        drivers: { where: { toTime: null }, take: 1, select: { driverId: true, source: true, driver: { select: { name: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    const live = await this.liveState.read(objects.map((o) => o.id));
    const locked = (await this.licences?.lockedObjectIds(ctx)) ?? new Set<string>();
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
        simNumber: device?.simNumber ?? null,
        speedLimitKph: effectiveSpeedLimit(o.speedLimitKph, o.type, o.vehicleType),
        inMaintenance: o.maintenanceSince !== null,
        driverId: o.drivers[0]?.driverId ?? null,
        driverName: o.drivers[0]?.driver.name ?? null,
        driverSource: (o.drivers[0]?.source as 'MANUAL' | 'RFID' | undefined) ?? null,
      };
      // Licence expired past grace: listed (so it can be renewed) but without position or telemetry.
      if (locked.has(o.id)) return { ...noDataLive(meta), licenceLocked: true };
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
