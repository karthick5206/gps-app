import { PrismaClient } from '@prisma/client';
import { StatusThresholds } from '@veetracer/shared';
import { effectiveSpeedLimit, ObjectMeta } from '../tracking/live-object';
import { companyThresholds } from '../tracking/thresholds';

const TTL_MS = 30_000;

export interface ResolvedDevice {
  deviceId: string;
  uniqueId: string;
  /** False when the device, its company or its object is inactive/suspended: positions are skipped. */
  accepted: boolean;
  thresholds: StatusThresholds;
  /** Object the device is fitted to (null = unassigned: positions are stored, no live state). */
  object: ObjectMeta | null;
}

interface Entry {
  value: ResolvedDevice | null; // null = not registered
  expiresAt: number;
}

/** uniqueId → device/object/company facts, cached for 30 s and cleared on `vt:cache:invalidate`. */
export class DeviceCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly prisma: PrismaClient) {}

  clear(): void {
    this.entries.clear();
  }

  async resolve(uniqueIds: string[]): Promise<Map<string, ResolvedDevice | null>> {
    const now = Date.now();
    const result = new Map<string, ResolvedDevice | null>();
    const missing: string[] = [];
    for (const id of new Set(uniqueIds)) {
      const entry = this.entries.get(id);
      if (entry && entry.expiresAt > now) result.set(id, entry.value);
      else missing.push(id);
    }
    if (!missing.length) return result;

    const devices = await this.prisma.device.findMany({
      where: { uniqueId: { in: missing } },
      select: {
        id: true,
        uniqueId: true,
        isActive: true,
        companyId: true,
        company: { select: { status: true, settings: true } },
        assignments: {
          where: { toTime: null },
          select: {
            object: {
              select: {
                id: true,
                companyId: true,
                branchId: true,
                name: true,
                plateNumber: true,
                type: true,
                vehicleType: true,
                speedLimitKph: true,
                isActive: true,
                maintenanceSince: true,
                drivers: { where: { toTime: null }, take: 1, select: { driverId: true, source: true, driver: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });
    const found = new Map(devices.map((d) => [d.uniqueId, d]));
    for (const uniqueId of missing) {
      const d = found.get(uniqueId);
      let value: ResolvedDevice | null = null;
      if (d) {
        const o = d.assignments[0]?.object ?? null;
        value = {
          deviceId: d.id,
          uniqueId: d.uniqueId,
          accepted: d.isActive && d.company?.status === 'ACTIVE' && (o?.isActive ?? true),
          thresholds: companyThresholds(d.company?.settings),
          object: o
            ? {
                objectId: o.id,
                companyId: o.companyId,
                branchId: o.branchId,
                name: o.name,
                plateNumber: o.plateNumber,
                type: o.type,
                vehicleType: o.vehicleType,
                deviceId: d.id,
                uniqueId: d.uniqueId,
                speedLimitKph: effectiveSpeedLimit(o.speedLimitKph, o.type, o.vehicleType),
                ownSpeedLimitKph: o.speedLimitKph,
                inMaintenance: o.maintenanceSince !== null,
                driverId: o.drivers[0]?.driverId ?? null,
                driverName: o.drivers[0]?.driver.name ?? null,
                driverSource: (o.drivers[0]?.source as 'MANUAL' | 'RFID' | undefined) ?? null,
              }
            : null,
        };
      }
      this.entries.set(uniqueId, { value, expiresAt: now + TTL_MS });
      result.set(uniqueId, value);
    }
    return result;
  }
}
