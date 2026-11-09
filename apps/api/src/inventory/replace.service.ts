import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InventoryStatus, ReplaceDeviceResult } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { ObjectsService } from '../masters/objects/objects.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryCatalogService } from './catalog.service';
import { ReplaceDto } from './inventory.dto';
import { InventoryStockService } from './stock.service';

/** Stock statuses a replacement unit cannot have (it must be a working unit). */
const UNUSABLE: InventoryStatus[] = ['FAULTY', 'UNDER_REPAIR', 'RETURNED', 'RETIRED'];

/**
 * Replace a faulty device on a vehicle.
 *
 * 1. Checks, read-only: the vehicle has a fitted unit; the replacement unit is a working, active device that is
 *    already in the vehicle's customer account (put there through Device Inventory, which applies the existing licence
 *    rules) and not fitted elsewhere.
 * 2. Fits the replacement through the EXISTING vehicle assignment flow (ObjectsService.update → assignDevice, acting
 *    in the vehicle's company): it closes the old DeviceAssignment and opens the new one, with its own audit entry and
 *    cache invalidation. That flow does not touch licence seats.
 * 3. Records the inventory side (InventoryStockService.recordReplace): REPLACE movements for both units, the removed
 *    unit's status / return location, and the fitted unit's status.
 *
 * Licence seats: unchanged by this operation. Each device keeps the seat the existing rules gave it while it is in the
 * customer account (QI-13: moving a seat between devices is a separate, explicit licence action that does not exist
 * yet). This service never writes Device.companyId / isActive and never calls the seat services.
 */
@Injectable()
export class InventoryReplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: InventoryCatalogService,
    private readonly objects: ObjectsService,
    private readonly stock: InventoryStockService,
  ) {}

  /** Working, unfitted devices already in the vehicle's customer account (read-only list for the replace dialog). */
  async candidates(objectId: string) {
    const object = await this.prisma.trackedObject.findUnique({ where: { id: objectId }, select: { companyId: true } });
    if (!object) throw new NotFoundException('Vehicle not found');
    const rows = await this.prisma.device.findMany({
      where: {
        companyId: object.companyId,
        isActive: true,
        assignments: { none: { toTime: null } },
        OR: [{ stock: null }, { stock: { status: { notIn: UNUSABLE } } }],
      },
      select: { id: true, uniqueId: true, model: { select: { brand: true, model: true } }, stock: { select: { status: true } } },
      orderBy: { uniqueId: 'asc' },
      take: 200,
    });
    return rows.map((d) => ({ id: d.id, uniqueId: d.uniqueId, modelName: `${d.model.brand} ${d.model.model}`, stockStatus: (d.stock?.status as InventoryStatus | undefined) ?? null }));
  }

  async replace(ctx: AuthContext, dto: ReplaceDto): Promise<ReplaceDeviceResult> {
    const object = await this.prisma.trackedObject.findUnique({
      where: { id: dto.objectId },
      select: {
        id: true,
        name: true,
        companyId: true,
        assignments: { where: { toTime: null }, select: { deviceId: true, device: { select: { id: true, uniqueId: true } } }, take: 1 },
      },
    });
    if (!object) throw new NotFoundException('Vehicle not found');
    const old = object.assignments[0]?.device;
    if (!old) throw new BadRequestException('No device is fitted to this vehicle; fit one on the vehicle form instead');
    if (old.id === dto.newDeviceId) throw new BadRequestException('The replacement is the device already fitted');

    const next = await this.prisma.device.findUnique({
      where: { id: dto.newDeviceId },
      select: {
        id: true,
        uniqueId: true,
        companyId: true,
        isActive: true,
        company: { select: { name: true } },
        stock: { select: { status: true } },
        assignments: { where: { toTime: null }, select: { objectId: true }, take: 1 },
      },
    });
    if (!next) throw new NotFoundException('Replacement device not found');
    if (next.companyId !== object.companyId) {
      throw new BadRequestException(
        next.companyId
          ? `The replacement device belongs to another customer (${next.company?.name ?? 'company'})`
          : "Assign the replacement device to the vehicle's customer in Device Inventory first (that existing step applies the licence rules)",
      );
    }
    if (!next.isActive) throw new BadRequestException('The replacement device is deactivated');
    if (next.assignments[0]) throw new BadRequestException('The replacement device is fitted to another vehicle');
    if (next.stock && UNUSABLE.includes(next.stock.status as InventoryStatus)) {
      throw new BadRequestException(`The replacement device is marked ${next.stock.status.toLowerCase().replace('_', ' ')} in inventory`);
    }
    if (dto.returnLocationId) await this.catalog.assertUsableLocation(dto.returnLocationId);

    // Existing vehicle assignment flow, in the vehicle's company (as the Super Admin acting in that company).
    const asCompany: AuthContext = { ...ctx, companyId: object.companyId, allCompanies: false, dataScope: 'COMPANY' };
    await this.objects.update(asCompany, object.id, { deviceId: next.id });

    let recorded: { oldStatus: InventoryStatus | null; newStatus: InventoryStatus | null };
    try {
      recorded = await this.stock.recordReplace(ctx, {
        objectId: object.id,
        companyId: object.companyId,
        oldDeviceId: old.id,
        newDeviceId: next.id,
        oldStatus: dto.oldStatus ?? 'FAULTY',
        returnLocationId: dto.returnLocationId,
        reason: dto.reason,
        reference: dto.reference,
        note: dto.note,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      throw new ConflictException(`The new device is fitted to ${object.name}, but the inventory record failed (${msg}). Use Sync / Adjust on both devices.`);
    }
    return {
      objectId: object.id,
      objectName: object.name,
      companyId: object.companyId,
      oldDevice: { id: old.id, uniqueId: old.uniqueId, status: recorded.oldStatus },
      newDevice: { id: next.id, uniqueId: next.uniqueId, status: recorded.newStatus },
      seatsChanged: false,
    };
  }
}
