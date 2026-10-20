import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MOBILE_TRACKER_PROTOCOL, normalizeMobile } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { randomToken } from '../common/secrets';
import { SeatsService } from '../licences/seats.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BYOD_SEEN_WITHIN_MS, formatClaimCode, newClaimCode, normalizeClaimCode } from './claim-logic';

export interface ShipBody {
  name: string;
  email?: string | null;
  mobile?: string | null;
  note?: string | null;
}

export interface ShipmentRow {
  deviceId: string;
  uniqueId: string;
  modelName: string;
  protocol: string;
  claimCode: string | null;
  reservedName: string | null;
  reservedEmail: string | null;
  reservedMobile: string | null;
  shipmentNote: string | null;
  shippedAt: string | null;
  claimedAt: string | null;
  companyName: string | null;
  lastSeenAt: string | null;
}

const ROW_SELECT = {
  id: true,
  uniqueId: true,
  claimCode: true,
  reservedName: true,
  reservedEmail: true,
  reservedMobile: true,
  shipmentNote: true,
  shippedAt: true,
  claimedAt: true,
  lastSeenAt: true,
  company: { select: { name: true } },
  model: { select: { brand: true, model: true, protocol: true } },
} as const;

type Row = { id: string; uniqueId: string; claimCode: string | null; reservedName: string | null; reservedEmail: string | null; reservedMobile: string | null; shipmentNote: string | null; shippedAt: Date | null; claimedAt: Date | null; lastSeenAt: Date | null; company: { name: string } | null; model: { brand: string; model: string; protocol: string } };

const toRow = (d: Row): ShipmentRow => ({
  deviceId: d.id,
  uniqueId: d.uniqueId,
  modelName: `${d.model.brand} ${d.model.model}`,
  protocol: d.model.protocol,
  claimCode: d.claimCode ? formatClaimCode(d.claimCode) : null,
  reservedName: d.reservedName,
  reservedEmail: d.reservedEmail,
  reservedMobile: d.reservedMobile,
  shipmentNote: d.shipmentNote,
  shippedAt: d.shippedAt?.toISOString() ?? null,
  claimedAt: d.claimedAt?.toISOString() ?? null,
  companyName: d.company?.name ?? null,
  lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
});

/**
 * Customers adding their own trackers:
 * - shipped by VeeTrax (Super Admin "Ship to customer"): IMEI + claim code from the help sheet, only by the reserved customer;
 * - bought elsewhere: an IMEI that connected to our server in the last 24 h and isn't registered.
 * The device then takes a licence seat in the customer's account (pay first: refused without one).
 */
@Injectable()
export class DeviceClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  /** Unknown trackers seen recently whose IMEI the customer typed (helps them pick the model). */
  async lookup(ctx: AuthContext, uniqueId: string) {
    const id = uniqueId.trim();
    const device = await this.prisma.device.findUnique({ where: { uniqueId: id }, select: { companyId: true, claimCode: true, shippedAt: true, model: { select: { id: true, brand: true, model: true } } } });
    if (device) {
      if (device.companyId === ctx.companyId) return { status: 'MINE' as const };
      if (device.companyId) return { status: 'TAKEN' as const };
      return { status: device.claimCode ? ('NEEDS_CODE' as const) : ('STOCK' as const), model: `${device.model.brand} ${device.model.model}` };
    }
    const seen = await this.prisma.unknownDevice.findUnique({ where: { uniqueId: id } });
    if (seen && Date.now() - seen.lastSeenAt.getTime() <= BYOD_SEEN_WITHIN_MS) return { status: 'SEEN' as const, protocol: seen.protocol, lastSeenAt: seen.lastSeenAt.toISOString() };
    return { status: 'NOT_SEEN' as const };
  }

  async claim(ctx: AuthContext, body: { uniqueId: string; claimCode?: string; modelId?: string }) {
    const uniqueId = body.uniqueId.trim();
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(uniqueId)) throw new BadRequestException('Enter the IMEI printed on the tracker');
    const me = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true, mobile: true } });
    const existing = await this.prisma.device.findUnique({ where: { uniqueId }, select: { id: true, companyId: true, claimCode: true, reservedEmail: true, reservedMobile: true } });

    let deviceId: string;
    if (existing) {
      if (existing.companyId === ctx.companyId) throw new ConflictException('This tracker is already in your account');
      if (existing.companyId) throw new ConflictException('This tracker is registered to another account. Contact VeeTrax support.');
      // Platform stock: needs the claim code from the help sheet, and the customer it was reserved for.
      const code = normalizeClaimCode(body.claimCode);
      if (!existing.claimCode || !code || code !== existing.claimCode) throw new BadRequestException('Enter the claim code printed on the help sheet in the box');
      const reserved = [existing.reservedEmail?.toLowerCase(), existing.reservedMobile].filter(Boolean);
      const mine = [me?.email?.toLowerCase(), me?.mobile].filter(Boolean);
      if (reserved.length && !reserved.some((r) => mine.includes(r))) throw new ConflictException('This tracker was sent to a different customer. Sign in with the email or mobile on the help sheet, or contact support.');
      deviceId = existing.id;
      await this.prisma.$transaction(async (tx) => {
        await tx.device.update({ where: { id: deviceId }, data: { companyId: ctx.companyId, claimedAt: new Date(), isActive: true } });
        await this.seats.ensureDevice(tx, ctx, ctx.companyId, deviceId);
      });
    } else {
      const seen = await this.prisma.unknownDevice.findUnique({ where: { uniqueId } });
      if (!seen || Date.now() - seen.lastSeenAt.getTime() > BYOD_SEEN_WITHIN_MS) {
        throw new BadRequestException('We have not heard from this tracker yet. Set its server (see the setup steps), power it on, wait a few minutes and try again.');
      }
      if (!body.modelId) throw new BadRequestException('Choose the tracker model');
      const model = await this.prisma.deviceModel.findUnique({ where: { id: body.modelId }, select: { id: true, protocol: true } });
      if (!model || model.protocol === MOBILE_TRACKER_PROTOCOL) throw new BadRequestException('Choose the tracker model');
      deviceId = await this.prisma.$transaction(async (tx) => {
        const d = await tx.device.create({ data: { companyId: ctx.companyId, modelId: model.id, uniqueId, ingestToken: randomToken(24), claimedAt: new Date() } });
        await this.seats.ensureDevice(tx, ctx, ctx.companyId, d.id);
        await tx.unknownDevice.delete({ where: { uniqueId } }).catch(() => undefined);
        return d.id;
      });
    }
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'device', entityId: deviceId, details: { claimed: uniqueId } });
    await this.redis.invalidateCache('device');
    return { deviceId, uniqueId };
  }

  // ───────────── Super Admin: shipping to customers ─────────────

  async ship(ctx: AuthContext, deviceId: string, body: ShipBody): Promise<ShipmentRow> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { companyId: true } });
    if (!device) throw new NotFoundException('Device not found');
    if (device.companyId) throw new ConflictException('Only stock devices (no company) can be shipped to a customer');
    const email = body.email?.trim().toLowerCase() || null;
    const mobileDigits = body.mobile?.trim() ? normalizeMobile(body.mobile) : null;
    if (body.mobile?.trim() && !mobileDigits) throw new BadRequestException('Enter a valid mobile number');
    if (!email && !mobileDigits) throw new BadRequestException("Enter the customer's email or mobile");
    let claimCode = newClaimCode();
    while (await this.prisma.device.count({ where: { claimCode } })) claimCode = newClaimCode();
    const row = await this.prisma.device.update({
      where: { id: deviceId },
      data: { claimCode, reservedName: body.name.trim(), reservedEmail: email, reservedMobile: mobileDigits ? `+${mobileDigits}` : null, shipmentNote: body.note?.trim() || null, shippedAt: new Date(), claimedAt: null },
      select: ROW_SELECT,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'device', entityId: deviceId, details: { shippedTo: body.name, email, mobile: mobileDigits } });
    return toRow(row);
  }

  async unship(ctx: AuthContext, deviceId: string): Promise<void> {
    const d = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { companyId: true } });
    if (!d) throw new NotFoundException('Device not found');
    if (d.companyId) throw new ConflictException('Already claimed by a customer');
    await this.prisma.device.update({ where: { id: deviceId }, data: { claimCode: null, reservedName: null, reservedEmail: null, reservedMobile: null, shipmentNote: null, shippedAt: null } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'device', entityId: deviceId, details: { unshipped: true } });
  }

  async shipments(): Promise<ShipmentRow[]> {
    const rows = await this.prisma.device.findMany({ where: { shippedAt: { not: null } }, orderBy: { shippedAt: 'desc' }, take: 500, select: ROW_SELECT });
    return rows.map(toRow);
  }

  async shipment(deviceId: string): Promise<ShipmentRow> {
    const row = await this.prisma.device.findUnique({ where: { id: deviceId }, select: ROW_SELECT });
    if (!row?.shippedAt) throw new NotFoundException('This device has not been shipped to a customer');
    return toRow(row);
  }
}
