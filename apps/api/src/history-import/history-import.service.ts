import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { HistoryImport, Prisma } from '@prisma/client';
import {
  addDaysToDay,
  HISTORY_HOLD_SETTING,
  HISTORY_IMPORT_CHUNK,
  historyHoldOf,
  type HistoryHold,
  type HistoryImportDto,
  type HistoryImportPreview,
  type HistoryImportPreviewRequest,
  type HistoryImportRow,
  type HistoryImportStartRequest,
  type HistoryImportVehicle,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { odometers } from '../documents/reminder-logic';
import { HistoryService } from '../history/history.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RoutingService } from '../routing/routing.service';
import { metres, plausibleSnap, pointsAlong, snapCandidate, type SnapPoint } from './road-snap';
import { localDayKey, tzOffsetMs } from '../summarizer/tz';

/** Busy states: one import / removal at a time per vehicle. */
const BUSY = ['UPLOADING', 'MATCHING', 'SUMMARIZING', 'REMOVING'];
/** Routing requests in flight at once while snapping an import to the roads. */
const SNAP_CONCURRENCY = 6;
/** Positions deleted per statement when an import is removed. */
const DELETE_BATCH = 5_000;

/** "YYYY-MM-DD HH:mm:ss" in the company's time zone → epoch ms. */
export function localToUtcMs(local: string, tz: string): number {
  const asUtc = Date.parse(`${local.replace(' ', 'T')}Z`);
  if (!Number.isFinite(asUtc)) return NaN;
  const first = asUtc - tzOffsetMs(asUtc, tz);
  return asUtc - tzOffsetMs(first, tz);
}

/** Compass bearing (0–359) from one point to the next; 0 when they are the same. */
export function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  if (lat1 === lat2 && lng1 === lng2) return 0;
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return Math.round(((Math.atan2(y, x) / r) % 360) + 360) % 360;
}

/** Plate / name compared without spaces, dots or dashes, upper case. */
const nameKey = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Super Admin "Import old history" (see packages/shared/src/history-import.ts). Points go into Position for the
 * vehicle's current device, tagged attributes.importId, only before VeeTrax's own first fix. The summarizer then
 * rebuilds the vehicle (SummaryDirtyDay), and `finalize` moves the odometer base so the odometer stays as chosen.
 */
@Injectable()
export class HistoryImportService {
  private readonly logger = new Logger('HistoryImport');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly history: HistoryService,
    private readonly routing: RoutingService,
  ) {}

  private superAdmin(ctx: AuthContext) {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only the Super Admin can import old history');
  }

  private async vehicle(objectId: string) {
    const o = await this.prisma.trackedObject.findUnique({
      where: { id: objectId },
      select: {
        id: true,
        name: true,
        plateNumber: true,
        companyId: true,
        company: { select: { name: true, timezone: true, retentionDays: true, settings: true } },
        assignments: { where: { toTime: null }, take: 1, select: { device: { select: { id: true, uniqueId: true } } } },
      },
    });
    if (!o) throw new NotFoundException('Vehicle not found');
    return o;
  }

  private vehicleDto(o: Awaited<ReturnType<HistoryImportService['vehicle']>>): HistoryImportVehicle {
    return { objectId: o.id, name: o.name, plateNumber: o.plateNumber, companyId: o.companyId, companyName: o.company.name, timezone: o.company.timezone, deviceUniqueId: o.assignments[0]?.device.uniqueId ?? null };
  }

  /** VeeTrax's own first fix for the vehicle (imported points excluded). */
  private async ownDataFrom(objectId: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ t: Date | null }[]>`
      SELECT min("fixTime") AS t FROM "Position" WHERE "objectId" = ${objectId}::uuid AND NOT (attributes ? 'importId')`;
    return rows[0]?.t ?? null;
  }

  private async recordedKm(objectId: string): Promise<number> {
    const r = await this.prisma.dailySummary.aggregate({ where: { objectId }, _sum: { distanceKm: true } });
    return Math.round((r._sum.distanceKm ?? 0) * 10) / 10;
  }

  private holdAfter(o: { company: { timezone: string; retentionDays: number; settings: unknown } }, firstDay: string): HistoryHold {
    const today = localDayKey(Date.now(), o.company.timezone);
    const current = historyHoldOf(o.company.settings);
    const until = addDaysToDay(today, o.company.retentionDays);
    return { from: current && current.from < firstDay ? current.from : firstDay, until: current && current.until > until ? current.until : until };
  }

  async preview(ctx: AuthContext, req: HistoryImportPreviewRequest): Promise<HistoryImportPreview> {
    this.superAdmin(ctx);
    let objectId = req.objectId || null;
    let candidates: HistoryImportVehicle[] = [];
    if (!objectId && req.deviceName?.trim()) {
      const k = nameKey(req.deviceName);
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text FROM "TrackedObject"
        WHERE type = 'VEHICLE' AND "isActive"
          AND (upper(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) = ${k} OR upper(regexp_replace(coalesce("plateNumber", ''), '[^A-Za-z0-9]', '', 'g')) = ${k})
        LIMIT 10`;
      if (rows.length === 1) objectId = rows[0].id;
      candidates = await Promise.all(rows.map(async (r) => this.vehicleDto(await this.vehicle(r.id))));
    }
    if (!objectId) {
      return { vehicle: null, candidates, ownDataFrom: null, odometerKm: null, retentionDays: 0, hold: null, holdAfterImport: { from: '', until: '' }, imports: [] };
    }
    const o = await this.vehicle(objectId);
    const [own, odo, imports] = await Promise.all([this.ownDataFrom(o.id), odometers(this.prisma, [o.id]), this.list(ctx, o.id)]);
    const today = localDayKey(Date.now(), o.company.timezone);
    return {
      vehicle: this.vehicleDto(o),
      candidates,
      ownDataFrom: own?.toISOString() ?? null,
      odometerKm: odo.get(o.id) ?? null,
      retentionDays: o.company.retentionDays,
      hold: historyHoldOf(o.company.settings),
      holdAfterImport: this.holdAfter(o, today),
      imports,
    };
  }

  async start(ctx: AuthContext, dto: HistoryImportStartRequest): Promise<{ id: string; cutoff: string | null }> {
    this.superAdmin(ctx);
    const o = await this.vehicle(dto.objectId);
    const device = o.assignments[0]?.device;
    if (!device) throw new BadRequestException('Fit a device to this vehicle first: imported points are stored under its device');
    const busy = await this.prisma.historyImport.findFirst({ where: { objectId: o.id, status: { in: BUSY } } });
    if (busy) throw new ConflictException('Another import or removal for this vehicle is still running; wait for it to finish');
    const from = localToUtcMs(dto.firstLocal, o.company.timezone);
    const to = localToUtcMs(dto.lastLocal, o.company.timezone);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new BadRequestException('The file has no valid times');
    const own = await this.ownDataFrom(o.id);
    if (own && from >= own.getTime()) throw new BadRequestException('Everything in this file is after VeeTrax’s own data starts: nothing to import');
    const odo = (await odometers(this.prisma, [o.id])).get(o.id) ?? null;
    const row = await this.prisma.historyImport.create({
      data: {
        companyId: o.companyId,
        objectId: o.id,
        deviceId: device.id,
        fileName: dto.fileName.slice(0, 200),
        points: dto.points,
        oldKm: dto.oldKm ?? null,
        baseKm: await this.recordedKm(o.id),
        odometerKm: dto.odometerKm ?? odo,
        odometerAt: new Date(),
        createdById: ctx.userId,
      },
    });
    return { id: row.id, cutoff: own?.toISOString() ?? null };
  }

  /** One chunk of points. Points at / after VeeTrax's own first fix, in the future or already stored are skipped. */
  async addPoints(ctx: AuthContext, id: string, rows: HistoryImportRow[]): Promise<{ inserted: number }> {
    this.superAdmin(ctx);
    if (rows.length > HISTORY_IMPORT_CHUNK) throw new BadRequestException(`At most ${HISTORY_IMPORT_CHUNK} points per request`);
    const imp = await this.prisma.historyImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.status !== 'UPLOADING') throw new BadRequestException('This import is no longer uploading');
    const o = await this.vehicle(imp.objectId);
    const own = await this.ownDataFrom(imp.objectId);
    const limit = Math.min(own?.getTime() ?? Infinity, Date.now());
    const pts: { t: number; lat: number; lng: number; speed: number; ign: boolean | null }[] = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 4) continue;
      const t = localToUtcMs(String(r[0]), o.company.timezone);
      const [lat, lng, speed] = [Number(r[1]), Number(r[2]), Number(r[3])];
      if (!Number.isFinite(t) || t >= limit || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !Number.isFinite(speed) || speed < 0 || speed > 300) continue;
      pts.push({ t, lat, lng, speed, ign: r[4] === 1 ? true : r[4] === 0 ? false : null });
    }
    if (!pts.length) return { inserted: 0 };
    pts.sort((a, b) => a.t - b.t);
    const course = pts.map((p, i) => (i === 0 ? 0 : bearing(pts[i - 1].lat, pts[i - 1].lng, p.lat, p.lng)));
    const now = new Date().toISOString();
    const attrs = JSON.stringify({ imported: 'old-platform', importId: id });
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "Position" ("objectId", "deviceId", "fixTime", "serverTime", "lat", "lng", "speedKph", "course",
                              "altitude", "satellites", "valid", "ignition", "flags", "attributes")
      SELECT ${imp.objectId}::uuid, ${imp.deviceId}::uuid, u.t, ${now}::timestamptz, u.lat, u.lng, u.spd, u.crs, NULL, NULL, true, u.ign, 0, ${attrs}::jsonb
      FROM unnest(
        ${pts.map((p) => new Date(p.t).toISOString())}::text[]::timestamptz[],
        ${pts.map((p) => String(p.lat))}::text[]::float8[],
        ${pts.map((p) => String(p.lng))}::text[]::float8[],
        ${pts.map((p) => String(p.speed))}::text[]::real[],
        ${course.map(String)}::text[]::smallint[],
        ${pts.map((p) => (p.ign === null ? null : String(p.ign)))}::text[]::boolean[]
      ) AS u(t, lat, lng, spd, crs, ign)
      ON CONFLICT DO NOTHING`;
    const first = new Date(pts[0].t);
    const last = new Date(pts[pts.length - 1].t);
    await this.prisma.historyImport.update({
      where: { id },
      data: {
        inserted: { increment: inserted },
        ...(!imp.fromTime || first < imp.fromTime ? { fromTime: first } : {}),
        ...(!imp.toTime || last > imp.toTime ? { toTime: last } : {}),
      },
    });
    return { inserted };
  }

  /** All chunks sent: set the migration hold, ask the summarizer to rebuild, wait for it (finalize). */
  async finish(ctx: AuthContext, id: string): Promise<HistoryImportDto> {
    this.superAdmin(ctx);
    const imp = await this.prisma.historyImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.status !== 'UPLOADING') throw new BadRequestException('This import is already finished');
    const o = await this.vehicle(imp.objectId);
    if (!imp.inserted || !imp.fromTime) {
      await this.prisma.historyImport.update({ where: { id }, data: { status: 'DONE', importedKm: 0, finishedAt: new Date(), error: 'No new points (all were already in VeeTrax or after its own data)' } });
      return this.dto(id);
    }
    const firstDay = localDayKey(imp.fromTime.getTime(), o.company.timezone);
    const hold = this.holdAfter(o, firstDay);
    const settings = { ...((o.company.settings as Record<string, unknown>) ?? {}), [HISTORY_HOLD_SETTING]: { from: hold.from, until: hold.until } };
    // With a routing engine the points are first snapped to the roads (MATCHING, in the background); the summarizer
    // rebuild is requested when that is done.
    const snap = this.routing.enabled;
    await this.prisma.$transaction([
      this.prisma.company.update({ where: { id: o.companyId }, data: { settings: settings as Prisma.InputJsonValue } }),
      ...(snap
        ? []
        : [
            this.prisma.$executeRaw`
              INSERT INTO "SummaryDirtyDay" ("objectId", day, "createdAt") VALUES (${o.id}::uuid, ${firstDay}::date, now() AT TIME ZONE 'UTC')
              ON CONFLICT DO NOTHING`,
          ]),
      this.prisma.historyImport.update({ where: { id }, data: { status: snap ? 'MATCHING' : 'SUMMARIZING' } }),
    ]);
    await this.audit.recordFor(ctx, o.companyId, {
      action: 'CREATE',
      entity: 'history_import',
      entityId: id,
      details: { vehicle: o.name, file: imp.fileName, points: imp.points, inserted: imp.inserted, from: imp.fromTime.toISOString(), to: imp.toTime?.toISOString() ?? null, oldKm: imp.oldKm, hold: { from: hold.from, until: hold.until }, odometerKm: imp.odometerKm },
    });
    await this.redis.invalidateCache('object').catch(() => undefined);
    return this.dto(id);
  }

  /** Deletes exactly the imported points (never VeeTrax's own) and rebuilds the vehicle; the odometer stays. */
  async remove(ctx: AuthContext, id: string): Promise<HistoryImportDto> {
    this.superAdmin(ctx);
    const imp = await this.prisma.historyImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found');
    if (!['DONE', 'FAILED', 'UPLOADING'].includes(imp.status)) throw new BadRequestException('Wait until the import has finished');
    const o = await this.vehicle(imp.objectId);
    const odo = (await odometers(this.prisma, [o.id])).get(o.id) ?? imp.odometerKm;
    await this.prisma.historyImport.update({ where: { id }, data: { status: 'REMOVING', odometerKm: odo, odometerAt: new Date(), baseKm: await this.recordedKm(o.id) } });
    if (imp.fromTime && imp.toTime) {
      for (;;) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM "Position" WHERE ("deviceId", "fixTime") IN (
            SELECT "deviceId", "fixTime" FROM "Position"
            WHERE "deviceId" = ${imp.deviceId}::uuid AND "fixTime" >= ${imp.fromTime} AND "fixTime" <= ${imp.toTime} AND attributes->>'importId' = ${id}
            LIMIT ${DELETE_BATCH})`;
        if (n < DELETE_BATCH) break;
      }
      const firstDay = localDayKey(imp.fromTime.getTime(), o.company.timezone);
      await this.prisma.$executeRaw`
        INSERT INTO "SummaryDirtyDay" ("objectId", day, "createdAt") VALUES (${o.id}::uuid, ${firstDay}::date, now() AT TIME ZONE 'UTC')
        ON CONFLICT DO NOTHING`;
    }
    await this.audit.recordFor(ctx, o.companyId, { action: 'DELETE', entity: 'history_import', entityId: id, details: { vehicle: o.name, file: imp.fileName, points: imp.inserted } });
    return this.dto(id);
  }

  /**
   * Once the summarizer has rebuilt the vehicle after an import / removal: the odometer base moves so the odometer
   * stays at odometerKm (+ km driven since it was read), and the import is DONE / REMOVED.
   */
  @Interval(60_000)
  async finalizePending(): Promise<void> {
    const pending = await this.prisma.historyImport.findMany({ where: { status: { in: ['MATCHING', 'SUMMARIZING', 'REMOVING'] } } });
    for (const imp of pending) {
      try {
        if (imp.status === 'MATCHING') await this.runSnap(imp);
        else await this.finalize(imp);
      } catch (e) {
        this.logger.error(`Finalize ${imp.id} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Super Admin: snap a finished import to the roads (again). Earlier snapped points of the import are replaced; the
   * odometer stays as it is now. Runs in the background (MATCHING → SUMMARIZING → DONE).
   */
  async roadSnap(ctx: AuthContext, id: string): Promise<HistoryImportDto> {
    this.superAdmin(ctx);
    if (!this.routing.enabled) throw new BadRequestException('No routing engine is configured on this server');
    const imp = await this.prisma.historyImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.status !== 'DONE' || !imp.fromTime || !imp.toTime) throw new BadRequestException('Only a finished import can be snapped to the roads');
    const odo = (await odometers(this.prisma, [imp.objectId])).get(imp.objectId) ?? imp.odometerKm;
    const total = await this.recordedKm(imp.objectId);
    await this.deleteSnapped(imp);
    await this.prisma.historyImport.update({
      where: { id },
      // baseKm such that (total after − baseKm) is the import's km again once rebuilt.
      data: { status: 'MATCHING', snappedPoints: 0, odometerKm: odo, odometerAt: new Date(), baseKm: Math.round((total - (imp.importedKm ?? 0)) * 10) / 10, error: null },
    });
    await this.audit.recordFor(ctx, imp.companyId, { action: 'UPDATE', entity: 'history_import', entityId: id, details: { roadSnap: true, file: imp.fileName } });
    return this.dto(id);
  }

  private async deleteSnapped(imp: HistoryImport): Promise<void> {
    if (!imp.fromTime || !imp.toTime) return;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM "Position" WHERE ("deviceId", "fixTime") IN (
          SELECT "deviceId", "fixTime" FROM "Position"
          WHERE "deviceId" = ${imp.deviceId}::uuid AND "fixTime" >= ${imp.fromTime} AND "fixTime" <= ${imp.toTime}
            AND attributes->>'importId' = ${imp.id} AND attributes ? 'roadSnapped'
          LIMIT ${DELETE_BATCH})`;
      if (n < DELETE_BATCH) break;
    }
  }

  private readonly snapping = new Set<string>();

  /** MATCHING: road points between the import's moving pairs, then the summarizer rebuild (SUMMARIZING). */
  private async runSnap(imp: HistoryImport): Promise<void> {
    if (this.snapping.has(imp.id) || !imp.fromTime || !imp.toTime) return;
    this.snapping.add(imp.id);
    try {
      const rows = await this.prisma.$queryRaw<{ t: Date; lat: number; lng: number; spd: number }[]>`
        SELECT "fixTime" AS t, lat, lng, "speedKph"::float8 AS spd FROM "Position"
        WHERE "deviceId" = ${imp.deviceId}::uuid AND "fixTime" >= ${imp.fromTime} AND "fixTime" <= ${imp.toTime}
          AND attributes->>'importId' = ${imp.id} AND NOT (attributes ? 'roadSnapped')
        ORDER BY "fixTime"`;
      const pts: SnapPoint[] = rows.map((r) => ({ t: r.t.getTime(), lat: r.lat, lng: r.lng, speedKph: r.spd }));
      const pairs: [SnapPoint, SnapPoint][] = [];
      for (let i = 1; i < pts.length; i++) if (snapCandidate(pts[i - 1], pts[i])) pairs.push([pts[i - 1], pts[i]]);
      const added: (SnapPoint & { course: number })[] = [];
      let used = 0;
      let failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < pairs.length) {
          const [a, b] = pairs[next++];
          try {
            const road = await this.routing.roadPath(a, b);
            if (!road) continue;
            if (!plausibleSnap(metres(a.lat, a.lng, b.lat, b.lng), road.m, (b.t - a.t) / 1000)) continue;
            added.push(...pointsAlong(a, b, road.shape, road.m));
            used++;
          } catch {
            failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: SNAP_CONCURRENCY }, worker));
      const attrs = JSON.stringify({ imported: 'old-platform', importId: imp.id, roadSnapped: true });
      const now = new Date().toISOString();
      let inserted = 0;
      for (let i = 0; i < added.length; i += 2000) {
        const b = added.slice(i, i + 2000);
        inserted += await this.prisma.$executeRaw`
          INSERT INTO "Position" ("objectId", "deviceId", "fixTime", "serverTime", "lat", "lng", "speedKph", "course",
                                  "altitude", "satellites", "valid", "ignition", "flags", "attributes")
          SELECT ${imp.objectId}::uuid, ${imp.deviceId}::uuid, u.t, ${now}::timestamptz, u.lat, u.lng, u.spd, u.crs, NULL, NULL, true, true, 0, ${attrs}::jsonb
          FROM unnest(
            ${b.map((p) => new Date(p.t).toISOString())}::text[]::timestamptz[],
            ${b.map((p) => String(p.lat))}::text[]::float8[],
            ${b.map((p) => String(p.lng))}::text[]::float8[],
            ${b.map((p) => String(p.speedKph))}::text[]::real[],
            ${b.map((p) => String(p.course))}::text[]::smallint[]
          ) AS u(t, lat, lng, spd, crs)
          ON CONFLICT DO NOTHING`;
      }
      const o = await this.vehicle(imp.objectId);
      const firstDay = localDayKey(imp.fromTime.getTime(), o.company.timezone);
      await this.prisma.$transaction([
        this.prisma.$executeRaw`
          INSERT INTO "SummaryDirtyDay" ("objectId", day, "createdAt") VALUES (${imp.objectId}::uuid, ${firstDay}::date, now() AT TIME ZONE 'UTC')
          ON CONFLICT DO NOTHING`,
        this.prisma.historyImport.update({
          where: { id: imp.id },
          data: { status: 'SUMMARIZING', snappedPoints: inserted, error: failed && !used ? 'Routing engine did not answer: kept straight lines' : null },
        }),
      ]);
      this.logger.log(`Import ${imp.id}: ${used}/${pairs.length} pairs snapped to roads, ${inserted} points added, ${failed} engine errors`);
    } finally {
      this.snapping.delete(imp.id);
    }
  }

  private async finalize(imp: HistoryImport): Promise<void> {
    const dirty = await this.prisma.summaryDirtyDay.count({ where: { objectId: imp.objectId } });
    if (dirty) return;
    const cursor = await this.prisma.summaryCursor.findUnique({ where: { objectId: imp.objectId }, select: { updatedAt: true } });
    if (!cursor || cursor.updatedAt <= imp.updatedAt) return; // not rebuilt since we asked
    const total = await this.recordedKm(imp.objectId);
    const removing = imp.status === 'REMOVING';
    const data: Prisma.HistoryImportUpdateInput = {
      status: removing ? 'REMOVED' : 'DONE',
      finishedAt: new Date(),
      ...(removing ? {} : { importedKm: Math.max(0, Math.round((total - (imp.baseKm ?? 0)) * 10) / 10) }),
    };
    const target = imp.odometerKm;
    if (target !== null && imp.odometerAt) {
      const since = await this.history.distanceSinceKmFor(imp.objectId, imp.odometerAt.getTime());
      const o = await this.prisma.trackedObject.findUniqueOrThrow({ where: { id: imp.objectId }, select: { odometerOffsetKm: true, companyId: true } });
      const offset = Math.round((target + since - total) * 10) / 10;
      await this.prisma.$transaction(async (tx) => {
        await tx.trackedObject.update({ where: { id: imp.objectId }, data: { odometerOffsetKm: offset } });
        await tx.historyImport.update({ where: { id: imp.id }, data });
        await tx.auditLog.create({
          data: {
            companyId: o.companyId,
            userId: imp.createdById,
            action: 'UPDATE',
            entity: 'OdometerReset',
            entityId: imp.objectId,
            changes: { before: { offsetKm: o.odometerOffsetKm }, after: { offsetKm: offset, odometerKm: target + since }, reason: removing ? 'history import removed' : 'history import', importId: imp.id },
          },
        });
      });
      await this.redis.invalidateCache('object').catch(() => undefined);
    } else {
      await this.prisma.historyImport.update({ where: { id: imp.id }, data });
    }
    this.logger.log(`Import ${imp.id} ${removing ? 'removed' : 'done'}: recorded ${total} km`);
  }

  async list(ctx: AuthContext, objectId?: string): Promise<HistoryImportDto[]> {
    this.superAdmin(ctx);
    const rows = await this.prisma.historyImport.findMany({ where: objectId ? { objectId } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
    const names = new Map(
      (await this.prisma.trackedObject.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.objectId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]),
    );
    return rows.map((r) => toDto(r, names.get(r.objectId) ?? ''));
  }

  private async dto(id: string): Promise<HistoryImportDto> {
    const r = await this.prisma.historyImport.findUniqueOrThrow({ where: { id } });
    const o = await this.prisma.trackedObject.findUnique({ where: { id: r.objectId }, select: { name: true } });
    return toDto(r, o?.name ?? '');
  }
}

function toDto(r: HistoryImport, objectName: string): HistoryImportDto {
  return {
    id: r.id,
    objectId: r.objectId,
    objectName,
    fileName: r.fileName,
    from: r.fromTime?.toISOString() ?? null,
    to: r.toTime?.toISOString() ?? null,
    points: r.points,
    inserted: r.inserted,
    oldKm: r.oldKm,
    importedKm: r.importedKm,
    odometerKm: r.odometerKm,
    status: r.status as HistoryImportDto['status'],
    snappedPoints: r.snappedPoints,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}
