import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IO_SENSOR_DEFAULTS, IO_SENSOR_KINDS, IoSensorConfigDto, IoSensorKind, IoSensorsDto, IoSensorSource, RecentAttributesDto } from '@veetracer/shared';
import { deviceScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { iso } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { IoSensorBody, IoSensorsBody } from './io-sensors.dto';
import { recentAttributes } from './recent-attributes';

const RECENT_POSITIONS = 200;
const RECENT_DAYS = 7;

type ConfigRow = {
  deviceId: string; kind: string; enabled: boolean; source: string; attribute: string; invert: boolean;
  minV: number | null; maxV: number | null; hysteresisV: number; debounceSec: number; updatedAt: Date;
};

export function ioConfigDto(deviceId: string, kind: IoSensorKind, row: ConfigRow | undefined): IoSensorConfigDto {
  if (!row) return { deviceId, kind, ...IO_SENSOR_DEFAULTS[kind], updatedAt: null };
  return {
    deviceId,
    kind,
    enabled: row.enabled,
    source: row.source as IoSensorSource,
    attribute: row.attribute,
    invert: row.invert,
    minV: row.minV,
    maxV: row.maxV,
    hysteresisV: row.hysteresisV,
    debounceSec: row.debounceSec,
    updatedAt: iso(row.updatedAt),
  };
}

/** Rejects a configuration the processor could not use. */
export function validateIoSensor(s: IoSensorBody): void {
  if (s.source !== 'ANALOG') return;
  const min = s.minV ?? null;
  const max = s.maxV ?? null;
  if (s.enabled && min === null && max === null) throw new BadRequestException(`${s.kind}: enter the minimum and / or maximum voltage`);
  if (min !== null && max !== null && min >= max) throw new BadRequestException(`${s.kind}: the minimum voltage must be below the maximum`);
}

@Injectable()
export class IoSensorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  private async device(ctx: AuthContext, deviceId: string) {
    const d = await this.prisma.device.findFirst({
      where: { AND: [deviceScopeWhere(ctx), { id: deviceId }] },
      select: { id: true, companyId: true, uniqueId: true, assignments: { where: { toTime: null }, select: { objectId: true } } },
    });
    if (!d) throw new NotFoundException('Device not found');
    return { ...d, objectId: d.assignments[0]?.objectId ?? null };
  }

  async get(ctx: AuthContext, deviceId: string): Promise<IoSensorsDto> {
    const d = await this.device(ctx, deviceId);
    const rows = await this.prisma.ioSensorConfig.findMany({ where: { deviceId } });
    return { deviceId, objectId: d.objectId, sensors: IO_SENSOR_KINDS.map((k) => ioConfigDto(deviceId, k, rows.find((r) => r.kind === k))) };
  }

  async put(ctx: AuthContext, deviceId: string, body: IoSensorsBody): Promise<IoSensorsDto> {
    const d = await this.device(ctx, deviceId);
    const kinds = new Set(body.sensors.map((s) => s.kind));
    if (kinds.size !== body.sensors.length) throw new BadRequestException('Each sensor kind may appear once');
    body.sensors.forEach(validateIoSensor);
    const before = await this.prisma.ioSensorConfig.findMany({ where: { deviceId } });
    const changed: IoSensorKind[] = [];
    for (const s of body.sensors) {
      const data = {
        enabled: s.enabled,
        source: s.source,
        attribute: s.attribute,
        invert: s.invert ?? false,
        minV: s.minV ?? null,
        maxV: s.maxV ?? null,
        hysteresisV: s.hysteresisV ?? IO_SENSOR_DEFAULTS[s.kind].hysteresisV,
        debounceSec: s.debounceSec ?? IO_SENSOR_DEFAULTS[s.kind].debounceSec,
      };
      const prev = before.find((r) => r.kind === s.kind);
      const same = prev && (Object.keys(data) as (keyof typeof data)[]).every((k) => prev[k] === data[k]);
      if (same) continue;
      changed.push(s.kind);
      const row = await this.prisma.ioSensorConfig.upsert({
        where: { deviceId_kind: { deviceId, kind: s.kind } },
        create: { deviceId, kind: s.kind, companyId: d.companyId, ...data },
        update: data,
      });
      await this.audit.record(ctx, { action: prev ? 'UPDATE' : 'CREATE', entity: 'io_sensor', entityId: `${deviceId}:${s.kind}`, before: prev ?? undefined, after: row });
    }
    if (changed.length) {
      // The detector restarts with the new settings: close the open periods it was tracking.
      if (d.objectId) {
        await this.prisma.$executeRaw`
          UPDATE "IoSession" SET "endTime" = now(), "durationSec" = GREATEST(0, EXTRACT(EPOCH FROM now() - "startTime"))::int, "updatedAt" = now()
          WHERE "objectId" = ${d.objectId}::uuid AND "kind" = ANY(${changed}::text[]) AND "endTime" IS NULL`;
        await this.redis.client.del(RedisKeys.ioState(d.objectId));
      }
      // Processor (device cache) and rules (AC / door alert support) reload.
      await this.redis.invalidateCache('io_sensor');
    }
    return this.get(ctx, deviceId);
  }

  /** Attribute keys on the device's recent positions with their newest values (to pick and calibrate an input). */
  async recent(ctx: AuthContext, deviceId: string): Promise<RecentAttributesDto> {
    await this.device(ctx, deviceId);
    const rows = await this.prisma.position.findMany({
      where: { deviceId, fixTime: { gte: new Date(Date.now() - RECENT_DAYS * 86_400_000) } },
      orderBy: { fixTime: 'desc' },
      take: RECENT_POSITIONS,
      select: { fixTime: true, attributes: true },
    });
    return { deviceId, scanned: rows.length, attributes: recentAttributes(rows) };
  }
}
