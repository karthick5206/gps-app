import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AssetDeviceView, AssetLinksDto, SimStatus } from '@veetracer/shared';
import { allCompaniesOr, deviceScopeWhere, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { iso } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnlyIso } from './sims.mapper';

/**
 * QI-21 (open): tenants see SIM number, status and renewal date of their own devices' managed SIM only when the
 * platform enables it (recommended default A, shipped off). Cost, plan, provider contract data and ICCID are never
 * part of the tenant view.
 */
export function tenantSimViewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INVENTORY_TENANT_SIM_VIEW === 'true';
}

const DEVICE_SELECT = {
  id: true,
  uniqueId: true,
  simNumber: true,
  companyId: true,
  model: { select: { brand: true, model: true } },
  licenceSeat: { select: { expiresAt: true } },
  simAssignments: { where: { toTime: null }, take: 1, select: { sim: { select: { msisdn: true, status: true, renewalDueAt: true } } } },
} satisfies Prisma.DeviceSelect;
type DeviceRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_SELECT }>;

/**
 * Customer portal, read-only "Devices & SIMs" of a vehicle / device. Strictly tenant-scoped through the existing
 * scope rules (objectScopeWhere / deviceScopeWhere: own company, and own branches / objects for ASSIGNED roles).
 * Shared vehicles are deliberately excluded (the device belongs to another company).
 */
@Injectable()
export class AssetLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async forObject(ctx: AuthContext, objectId: string): Promise<AssetLinksDto> {
    const object = await this.prisma.trackedObject.findFirst({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] },
      select: {
        id: true,
        name: true,
        companyId: true,
        assignments: { where: { toTime: null }, select: { fromTime: true, device: { select: DEVICE_SELECT } } },
      },
    });
    if (!object) throw new NotFoundException('Object not found');
    const simVisible = tenantSimViewEnabled();
    return {
      objectId: object.id,
      objectName: object.name,
      // A fitted device always belongs to the vehicle's company (assignDevice rule); re-checked defensively.
      devices: object.assignments.filter((a) => a.device.companyId === object.companyId).map((a) => this.view(a.device, a.fromTime, simVisible)),
      simVisible,
    };
  }

  async forDevice(ctx: AuthContext, deviceId: string): Promise<AssetDeviceView & { simVisible: boolean }> {
    const device = await this.prisma.device.findFirst({
      where: { AND: [allCompaniesOr(ctx, deviceScopeWhere(ctx)), { id: deviceId }] },
      select: { ...DEVICE_SELECT, assignments: { where: { toTime: null }, take: 1, select: { fromTime: true } } },
    });
    if (!device) throw new NotFoundException('Device not found');
    const simVisible = tenantSimViewEnabled();
    return { ...this.view(device, device.assignments[0]?.fromTime ?? null, simVisible), simVisible };
  }

  private view(d: DeviceRow, fittedAt: Date | null, simVisible: boolean): AssetDeviceView {
    const seat = d.licenceSeat;
    const sim = d.simAssignments[0]?.sim;
    return {
      deviceId: d.id,
      uniqueId: d.uniqueId,
      modelName: `${d.model.brand} ${d.model.model}`,
      simNumber: d.simNumber,
      fittedAt: fittedAt ? iso(fittedAt) : '',
      licence: seat ? { status: seat.expiresAt > new Date() ? 'ACTIVE' : 'EXPIRED', expiresAt: iso(seat.expiresAt) } : { status: 'NO_SEAT', expiresAt: null },
      sim: simVisible && sim ? { msisdn: sim.msisdn, status: sim.status as SimStatus, renewalDueAt: dateOnlyIso(sim.renewalDueAt) } : null,
    };
  }
}
