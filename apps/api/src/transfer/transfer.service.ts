import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransferResult } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

type Tx = Prisma.TransactionClient;

/**
 * Rows of a vehicle that are its own history (they carry the company): re-labelled to the new company when a vehicle
 * moves "with history". Positions have no company column and always belong to the vehicle. Left with the old company
 * on purpose: GeofenceVisit (its geofences stay there) and past DriverAssignment rows (its drivers stay there).
 * Keep in step with the schema when a table with objectId + companyId is added.
 */
const OBJECT_HISTORY_TABLES = ['Alert', 'DailySummary', 'DeviceCommand', 'Document', 'DriverEvent', 'FuelEvent', 'IoSession', 'ObjectRemark', 'ParkingSchedule', 'ServiceRecord', 'ServiceReminder', 'Stop', 'Trip'] as const;
/** Vehicle fields copied to the new vehicle when it moves "start fresh". */
const OBJECT_COPY_FIELDS = ['type', 'vehicleType', 'name', 'plateNumber', 'make', 'model', 'color', 'icon', 'speedLimitKph', 'odometerOffsetKm', 'customFields'] as const;

/**
 * Super Admin: move a vehicle, a device or a driver to another company.
 *  - Vehicle "with history": the vehicle itself moves; its trips, alerts, summaries, documents… are re-labelled.
 *  - Vehicle "start fresh": a copy is created in the new company and its devices move to it; the old vehicle is
 *    archived (inactive) in the old company with all its history.
 *  - Its devices move with it, each with its paid licence seat (and expiry), sensor settings and phone codes.
 *  - Links to the old company's own setup are dropped: groups, branch, user access, current driver.
 * Everything runs in one transaction; live state and caches are refreshed afterwards.
 */
@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async moveObject(ctx: AuthContext, objectId: string, targetCompanyId: string, withHistory: boolean): Promise<TransferResult> {
    const target = await this.target(ctx, targetCompanyId);
    const obj = await this.prisma.trackedObject.findUnique({ where: { id: objectId } });
    if (!obj) throw new NotFoundException('Vehicle not found');
    if (obj.companyId === target.id) throw new BadRequestException('The vehicle already belongs to that company');
    const source = obj.companyId;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.deviceAssignment.findMany({ where: { objectId, toTime: null }, select: { deviceId: true } });
      const deviceIds = current.map((a) => a.deviceId);
      await tx.driverAssignment.updateMany({ where: { objectId, toTime: null }, data: { toTime: now } });
      let movedId = objectId;

      if (withHistory) {
        await tx.trackedObject.update({ where: { id: objectId }, data: { companyId: target.id, branchId: null } });
        await tx.userObject.deleteMany({ where: { objectId } });
        await tx.vehicleGroupMember.deleteMany({ where: { objectId } });
        for (const table of OBJECT_HISTORY_TABLES) {
          await tx.$executeRawUnsafe(`UPDATE "${table}" SET "companyId" = $1::uuid WHERE "objectId" = $2::uuid AND "companyId" = $3::uuid`, target.id, objectId, source);
        }
        // A document of this vehicle that also names a driver of the old company keeps the vehicle, not the driver.
        await tx.$executeRaw`UPDATE "Document" SET "driverId" = NULL WHERE "objectId" = ${objectId}::uuid AND "driverId" IS NOT NULL
          AND "driverId" NOT IN (SELECT id FROM "Driver" WHERE "companyId" = ${target.id}::uuid)`;
        await tx.fuelConfig.updateMany({ where: { objectId }, data: { companyId: target.id } });
      } else {
        const copy: Record<string, unknown> = {};
        for (const f of OBJECT_COPY_FIELDS) copy[f] = obj[f] ?? undefined;
        const fresh = await tx.trackedObject.create({
          data: { ...(copy as Prisma.TrackedObjectUncheckedCreateInput), companyId: target.id, branchId: null, isActive: true },
        });
        movedId = fresh.id;
        await tx.deviceAssignment.updateMany({ where: { objectId, toTime: null }, data: { toTime: now } });
        for (const deviceId of deviceIds) await tx.deviceAssignment.create({ data: { deviceId, objectId: fresh.id, fromTime: now } });
        // Fuel calibration belongs to the tank: copied to the new vehicle, with its fuel sensor licence.
        await tx.$executeRaw`INSERT INTO "FuelConfig" ("objectId", "companyId", source, "tankCapacityL", calibration, "refillMinL", "drainMinL", "drainWindowMin", "smoothingWindow", "createdAt", "updatedAt")
          SELECT ${fresh.id}::uuid, ${target.id}::uuid, source, "tankCapacityL", calibration, "refillMinL", "drainMinL", "drainWindowMin", "smoothingWindow", now(), now()
          FROM "FuelConfig" WHERE "objectId" = ${objectId}::uuid`;
        await tx.trackedObject.update({ where: { id: objectId }, data: { isActive: false } });
      }
      await tx.licenceSeat.updateMany({ where: { fuelObjectId: objectId }, data: { fuelObjectId: movedId, companyId: target.id } });
      await tx.$executeRaw`UPDATE "LicenceSeat" SET "partnerId" = ${target.partnerId}::uuid WHERE "fuelObjectId" = ${movedId}::uuid AND "partnerId" IS NOT NULL`;
      await this.moveDeviceRows(tx, deviceIds, source, target);
      return { objectId: movedId, deviceIds };
    });

    await this.refreshLive(withHistory ? [] : [objectId], withHistory ? [objectId] : [result.objectId], source, target.id);
    await this.audit.record(ctx, {
      action: 'UPDATE',
      entity: 'TrackedObject',
      entityId: objectId,
      before: { companyId: source },
      after: { companyId: target.id, withHistory, newObjectId: withHistory ? undefined : result.objectId, deviceIds: result.deviceIds },
    });
    return { id: result.objectId, companyId: target.id, companyName: target.name };
  }

  async moveDevice(ctx: AuthContext, deviceId: string, targetCompanyId: string): Promise<TransferResult> {
    const target = await this.target(ctx, targetCompanyId);
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { id: true, companyId: true } });
    if (!device) throw new NotFoundException('Device not found');
    if (device.companyId === target.id) throw new BadRequestException('The device already belongs to that company');
    const source = device.companyId;
    const detached = await this.prisma.$transaction(async (tx) => {
      // Moving on its own: it leaves the vehicle it is fitted to (the vehicle stays in the old company).
      const current = await tx.deviceAssignment.findMany({ where: { deviceId, toTime: null }, select: { objectId: true } });
      await tx.deviceAssignment.updateMany({ where: { deviceId, toTime: null }, data: { toTime: new Date() } });
      await this.moveDeviceRows(tx, [deviceId], source, target);
      return current.map((a) => a.objectId);
    });
    if (source) await this.refreshLive(detached, [], source, target.id);
    else await this.redis.invalidateCache('device');
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'Device', entityId: deviceId, before: { companyId: source }, after: { companyId: target.id, detachedFrom: detached } });
    return { id: deviceId, companyId: target.id, companyName: target.name };
  }

  async moveDriver(ctx: AuthContext, driverId: string, targetCompanyId: string): Promise<TransferResult> {
    const target = await this.target(ctx, targetCompanyId);
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId }, select: { id: true, companyId: true } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (driver.companyId === target.id) throw new BadRequestException('The driver already belongs to that company');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.driverAssignment.updateMany({ where: { driverId, toTime: null }, data: { toTime: new Date() } });
        await tx.driver.update({ where: { id: driverId }, data: { companyId: target.id, branchId: null } });
        // The driver's own documents go along; a link to a vehicle of the old company is dropped.
        await tx.$executeRaw`UPDATE "Document" SET "companyId" = ${target.id}::uuid,
            "objectId" = CASE WHEN "objectId" IN (SELECT id FROM "TrackedObject" WHERE "companyId" = ${target.id}::uuid) THEN "objectId" ELSE NULL END
          WHERE "driverId" = ${driverId}::uuid`;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('That company already has a driver with the same RFID tag or employee ID');
      }
      throw e;
    }
    await this.redis.invalidateCache('object');
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'Driver', entityId: driverId, before: { companyId: driver.companyId }, after: { companyId: target.id } });
    return { id: driverId, companyId: target.id, companyName: target.name };
  }

  private async target(ctx: AuthContext, companyId: string) {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only Super Admin can move items between companies');
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, partnerId: true } });
    if (!c) throw new NotFoundException('Company not found');
    return c;
  }

  /** A device's own rows: company, paid licence seat (with its expiry, now under the new company's partner), sensor settings, phone codes. */
  private async moveDeviceRows(tx: Tx, deviceIds: string[], source: string | null, target: { id: string; partnerId: string }) {
    if (!deviceIds.length) return;
    await tx.device.updateMany({ where: { id: { in: deviceIds } }, data: { companyId: target.id } });
    await tx.licenceSeat.updateMany({ where: { deviceId: { in: deviceIds } }, data: { companyId: target.id } });
    await tx.licenceSeat.updateMany({ where: { deviceId: { in: deviceIds }, partnerId: { not: null } }, data: { partnerId: target.partnerId } });
    await tx.ioSensorConfig.updateMany({ where: { deviceId: { in: deviceIds } }, data: { companyId: target.id } });
    await tx.mobileTrackerCode.updateMany({ where: { deviceId: { in: deviceIds } }, data: { companyId: target.id } });
    // Forwarding set up by the old company must not keep sending this device's data.
    if (source) {
      await tx.$executeRaw`UPDATE "RelayTarget" SET "deviceIds" = (SELECT coalesce(array_agg(d), '{}') FROM unnest("deviceIds") d WHERE NOT d = ANY(${deviceIds}::uuid[]))
        WHERE "companyId" = ${source}::uuid AND "deviceIds" && ${deviceIds}::uuid[]`;
    }
  }

  /**
   * Live map: an archived / detached vehicle leaves the old company's live set; a vehicle that moved with its history
   * keeps its live state, re-labelled to the new company. Then the processor's device cache is refreshed.
   */
  private async refreshLive(removed: string[], moved: string[], source: string, target: string) {
    try {
      const pipeline = this.redis.client.pipeline();
      for (const id of removed) pipeline.del(RedisKeys.live(id), RedisKeys.track(id)).srem(RedisKeys.liveCompany(source), id);
      for (const id of moved) {
        const raw = await this.redis.client.get(RedisKeys.live(id));
        if (raw) {
          const live = JSON.parse(raw) as { companyId?: string; branchId?: string | null };
          pipeline.set(RedisKeys.live(id), JSON.stringify({ ...live, companyId: target, branchId: null }));
        }
        pipeline.srem(RedisKeys.liveCompany(source), id).sadd(RedisKeys.liveCompany(target), id);
      }
      await pipeline.exec();
      for (const reason of ['device', 'object']) await this.redis.invalidateCache(reason);
    } catch (e) {
      this.logger.warn(`Move: live state refresh failed: ${(e as Error).message}`);
    }
  }
}
