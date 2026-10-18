import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { NormalizedPosition, normalizeRfidTag } from '@veetracer/shared';
import { endRfidSession, switchDriver } from '../drivers/driver-sessions';
import { ObjectMeta } from '../tracking/live-object';

const TAG_TTL_MS = 60_000;

interface TagEntry {
  driver: { id: string; name: string; isActive: boolean } | null;
  expiresAt: number;
}

/**
 * Driver identification from tracker data:
 * - an RFID / iButton id in `attributes.driverId` puts the matching driver on the vehicle (RFID session);
 * - ignition off ends an RFID session (manual assignments stay until changed in the app).
 * Updates the cached ObjectMeta in place so live state shows the driver without waiting for a cache refresh.
 */
export class DriverIdentification {
  private readonly logger = new Logger('Drivers');
  private readonly tags = new Map<string, TagEntry>();
  private readonly warned = new Set<string>();

  constructor(private readonly prisma: PrismaClient) {}

  async apply(object: ObjectMeta, position: NormalizedPosition): Promise<void> {
    const at = new Date(position.fixTime);
    const raw = position.attributes.driverId;
    const tag = typeof raw === 'string' || typeof raw === 'number' ? normalizeRfidTag(String(raw)) : '';
    try {
      if (tag && tag !== '0') {
        const driver = await this.lookup(object.companyId, tag);
        if (!driver) {
          this.warnOnce(`${object.companyId}|${tag}`, `Unknown RFID tag ${tag} on ${object.name}: add it to a driver in Masters → Drivers`);
          return;
        }
        if (!driver.isActive || driver.id === object.driverId) return;
        await switchDriver(this.prisma, { companyId: object.companyId, objectId: object.objectId, driverId: driver.id, at, source: 'RFID' });
        object.driverId = driver.id;
        object.driverName = driver.name;
        object.driverSource = 'RFID';
        return;
      }
      if (position.ignition === false && object.driverId && object.driverSource === 'RFID') {
        await endRfidSession(this.prisma, object.objectId, at);
        object.driverId = null;
        object.driverName = null;
        object.driverSource = null;
      }
    } catch (error) {
      // Never block positions on driver bookkeeping (e.g. a concurrent manual assignment hit the unique index).
      this.logger.warn(`Driver session update failed for ${object.name}: ${(error as Error).message}`);
    }
  }

  /** Forget cached RFID → driver lookups (drivers edited in the app). */
  clear(): void {
    this.tags.clear();
  }

  private async lookup(companyId: string, tag: string): Promise<TagEntry['driver']> {
    const key = `${companyId}|${tag}`;
    const hit = this.tags.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.driver;
    const driver = await this.prisma.driver.findUnique({ where: { companyId_rfidTag: { companyId, rfidTag: tag } }, select: { id: true, name: true, isActive: true } });
    this.tags.set(key, { driver, expiresAt: Date.now() + TAG_TTL_MS });
    return driver;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
