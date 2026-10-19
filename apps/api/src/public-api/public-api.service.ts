import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { asRecord, isoOrNull } from '../common/dto';
import { odometers } from '../documents/reminder-logic';
import { addressKey } from '../geocoding/geocoding.service';
import { LiveStateService } from '../live/live-state.service';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { vehicleState } from '../webhooks/events';
import {
  afterCursor,
  AlertsQueryDto,
  clampLimit,
  decodeCursor,

  idList,
  LIST_MAX_DAYS,
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  page,
  PageQueryDto,
  parseRange,
  POSITIONS_MAX_DAYS,
  POSITIONS_PAGE_DEFAULT,
  POSITIONS_PAGE_MAX,
  RangeQueryDto,
  TripsQueryDto,
} from './v1-query';

export interface Paged<T> {
  data: T[];
  meta: { count: number; nextCursor: string | null; [k: string]: unknown };
}

const r6 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);

/** Read side of the public API (v1). Every query is limited to the key's company (and branch, if set). */
@Injectable()
export class PublicApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveStateService,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  /** Vehicles locked by an expired licence: no positions, trips or events through the API either. */
  private viewable(ctx: AuthContext) {
    return this.licences ? this.licences.viewableWhere(ctx) : Promise.resolve({});
  }

  async vehicles(ctx: AuthContext, q: PageQueryDto): Promise<Paged<unknown>> {
    const limit = clampLimit(q.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
    const c = decodeCursor(q.cursor);
    const rows = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), c ? { id: { gt: c.id } } : {}] },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: {
        id: true, name: true, plateNumber: true, type: true, vehicleType: true, make: true, model: true, color: true, isActive: true, createdAt: true,
        branch: { select: { id: true, name: true } },
        assignments: { where: { toTime: null }, select: { device: { select: { uniqueId: true, simNumber: true, model: { select: { brand: true, model: true, protocol: true } } } } } },
      },
    });
    const p = page(rows, limit, (r) => ({ t: 0, id: r.id }));
    return {
      data: p.data.map((r) => {
        const d = r.assignments[0]?.device;
        return {
          id: r.id,
          name: r.name,
          plateNumber: r.plateNumber,
          type: r.type,
          vehicleType: r.vehicleType,
          make: r.make,
          model: r.model,
          color: r.color,
          isActive: r.isActive,
          branch: r.branch ? { id: r.branch.id, name: r.branch.name } : null,
          device: d ? { imei: d.uniqueId, simNumber: d.simNumber, model: `${d.model.brand} ${d.model.model}`, protocol: d.model.protocol } : null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      meta: { count: p.data.length, nextCursor: p.nextCursor },
    };
  }

  async liveAll(ctx: AuthContext, vehicleIds: string | undefined): Promise<Paged<unknown>> {
    const ids = idList(vehicleIds);
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), await this.viewable(ctx), { isActive: true }, ids.length ? { id: { in: ids } } : {}] },
      select: { id: true, name: true, plateNumber: true },
      orderBy: { name: 'asc' },
    });
    const ids2 = objects.map((o) => o.id);
    const [lives, odo] = await Promise.all([this.live.read(ids2), odometers(this.prisma, ids2)]);
    const keys = [...lives.values()].filter((l) => l.lat !== null && l.lng !== null).map((l) => addressKey(l.lat!, l.lng!));
    const cached = keys.length ? await this.prisma.addressCache.findMany({ where: { key: { in: [...new Set(keys)] } } }) : [];
    const addr = new Map(cached.map((a) => [a.key, a.address]));
    return {
      data: objects.map((o) => {
        const l = lives.get(o.id);
        const hasFix = l && l.lat !== null && l.lng !== null;
        return {
          vehicleId: o.id,
          name: o.name,
          plateNumber: o.plateNumber,
          status: l?.status ?? 'NO_DATA',
          state: vehicleState(l?.status) ?? 'no_data',
          statusSince: l?.statusSince ?? null,
          lat: hasFix ? r6(l.lat) : null,
          lng: hasFix ? r6(l.lng) : null,
          speedKph: l?.speedKph ?? 0,
          course: l?.course ?? 0,
          ignition: l?.ignition ?? null,
          satellites: l?.satellites ?? null,
          address: hasFix ? (addr.get(addressKey(l.lat!, l.lng!)) ?? null) : null,
          odometerKm: odo.get(o.id) ?? null,
          fuelL: l?.fuelL ?? null,
          fuelPct: l?.fuelPct ?? null,
          batteryLevel: l?.batteryLevel ?? null,
          extVoltage: l?.extVoltage ?? null,
          driverName: l?.driverName ?? null,
          fixTime: l?.fixTime ?? null,
          serverTime: l?.serverTime ?? null,
        };
      }),
      meta: { count: objects.length, nextCursor: null },
    };
  }

  /** Vehicle in the key's scope with its company's retention (positions older than that are gone anyway). */
  private async vehicle(ctx: AuthContext, id: string) {
    const o = await this.prisma.trackedObject.findFirst({
      where: { AND: [objectScopeWhere(ctx), await this.viewable(ctx), { id }] },
      select: { id: true, name: true, company: { select: { retentionDays: true } } },
    });
    if (!o) throw new NotFoundException('Vehicle not found');
    return o;
  }

  async positions(ctx: AuthContext, vehicleId: string, q: RangeQueryDto): Promise<Paged<unknown>> {
    await this.vehicle(ctx, vehicleId);
    const { from, to } = parseRange(q.from, q.to, POSITIONS_MAX_DAYS);
    const limit = clampLimit(q.limit, POSITIONS_PAGE_DEFAULT, POSITIONS_PAGE_MAX);
    const c = decodeCursor(q.cursor);
    const rows = await this.prisma.position.findMany({
      where: { AND: [{ objectId: vehicleId, fixTime: { gte: from, lte: to } }, afterCursor(c, 'fixTime', 'deviceId') as Prisma.PositionWhereInput] },
      orderBy: [{ fixTime: 'asc' }, { deviceId: 'asc' }],
      take: limit + 1,
    });
    const p = page(rows, limit, (r) => ({ t: r.fixTime.getTime(), id: r.deviceId }));
    return {
      data: p.data.map((r) => {
        const a = asRecord(r.attributes);
        const num = (k: string) => (typeof a[k] === 'number' ? (a[k] as number) : null);
        return {
          time: r.fixTime.toISOString(),
          serverTime: r.serverTime.toISOString(),
          lat: r6(r.lat),
          lng: r6(r.lng),
          speedKph: Math.round(r.speedKph * 10) / 10,
          course: r.course,
          altitude: r.altitude,
          satellites: r.satellites,
          valid: r.valid,
          ignition: r.ignition,
          odometerKm: num('odometerM') !== null ? Math.round(num('odometerM')! / 100) / 10 : null,
          fuelL: num('fuelL'),
          fuelPct: num('fuelPct'),
          batteryLevel: num('batteryLevel'),
          extVoltage: num('extVoltage'),
        };
      }),
      meta: { count: p.data.length, nextCursor: p.nextCursor, vehicleId, from: from.toISOString(), to: to.toISOString() },
    };
  }

  /** Vehicle ids the key may see (optionally just one), with names for the rows. */
  private async scope(ctx: AuthContext, vehicleId: string | undefined) {
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), await this.viewable(ctx), vehicleId ? { id: vehicleId } : {}] },
      select: { id: true, name: true, plateNumber: true },
    });
    if (vehicleId && !objects.length) throw new NotFoundException('Vehicle not found');
    return new Map(objects.map((o) => [o.id, o]));
  }

  async trips(ctx: AuthContext, q: TripsQueryDto): Promise<Paged<unknown>> {
    const { from, to } = parseRange(q.from, q.to, LIST_MAX_DAYS);
    const limit = clampLimit(q.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
    const objects = await this.scope(ctx, q.vehicleId);
    const rows = await this.prisma.trip.findMany({
      where: { AND: [{ companyId: ctx.companyId, objectId: { in: [...objects.keys()] }, startTime: { gte: from, lt: to } }, afterCursor(decodeCursor(q.cursor), 'startTime', 'id') as Prisma.TripWhereInput] },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const p = page(rows, limit, (r) => ({ t: r.startTime.getTime(), id: r.id }));
    return {
      data: p.data.map((t) => ({
        id: t.id,
        vehicleId: t.objectId,
        vehicleName: objects.get(t.objectId)?.name ?? null,
        plateNumber: objects.get(t.objectId)?.plateNumber ?? null,
        startTime: t.startTime.toISOString(),
        endTime: t.endTime.toISOString(),
        start: { lat: t.startLat, lng: t.startLng, address: t.startAddress },
        end: { lat: t.endLat, lng: t.endLng, address: t.endAddress },
        distanceKm: t.distanceKm,
        durationSec: t.durationSec,
        idleSec: t.idleSec,
        maxSpeedKph: t.maxSpeedKph,
        avgSpeedKph: t.avgSpeedKph,
      })),
      meta: { count: p.data.length, nextCursor: p.nextCursor },
    };
  }

  async stops(ctx: AuthContext, q: TripsQueryDto): Promise<Paged<unknown>> {
    const { from, to } = parseRange(q.from, q.to, LIST_MAX_DAYS);
    const limit = clampLimit(q.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
    const objects = await this.scope(ctx, q.vehicleId);
    const rows = await this.prisma.stop.findMany({
      where: { AND: [{ companyId: ctx.companyId, objectId: { in: [...objects.keys()] }, startTime: { gte: from, lt: to } }, afterCursor(decodeCursor(q.cursor), 'startTime', 'id') as Prisma.StopWhereInput] },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const p = page(rows, limit, (r) => ({ t: r.startTime.getTime(), id: r.id }));
    return {
      data: p.data.map((s) => ({
        id: s.id,
        vehicleId: s.objectId,
        vehicleName: objects.get(s.objectId)?.name ?? null,
        plateNumber: objects.get(s.objectId)?.plateNumber ?? null,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        lat: s.lat,
        lng: s.lng,
        address: s.address,
        durationSec: s.durationSec,
        ignitionOn: s.ignitionOn,
      })),
      meta: { count: p.data.length, nextCursor: p.nextCursor },
    };
  }

  async alerts(ctx: AuthContext, q: AlertsQueryDto): Promise<Paged<unknown>> {
    const { from, to } = parseRange(q.from, q.to, LIST_MAX_DAYS);
    const limit = clampLimit(q.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
    const objects = await this.scope(ctx, q.vehicleId);
    const types = (q.type ?? '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    const rows = await this.prisma.alert.findMany({
      where: {
        AND: [
          { companyId: ctx.companyId, objectId: { in: [...objects.keys()] }, occurredAt: { gte: from, lt: to }, ...(types.length ? { type: { in: types } } : {}) },
          afterCursor(decodeCursor(q.cursor), 'occurredAt', 'id') as Prisma.AlertWhereInput,
        ],
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const p = page(rows, limit, (r) => ({ t: r.occurredAt.getTime(), id: r.id }));
    return {
      data: p.data.map((a) => ({
        id: a.id,
        vehicleId: a.objectId,
        vehicleName: objects.get(a.objectId)?.name ?? null,
        plateNumber: objects.get(a.objectId)?.plateNumber ?? null,
        type: a.type,
        severity: a.severity,
        message: a.message,
        occurredAt: a.occurredAt.toISOString(),
        lat: a.lat,
        lng: a.lng,
        address: a.address,
        geofenceId: a.geofenceId,
        status: a.status,
        acknowledgedAt: isoOrNull(a.ackAt),
        details: asRecord(a.data),
      })),
      meta: { count: p.data.length, nextCursor: p.nextCursor },
    };
  }
}

