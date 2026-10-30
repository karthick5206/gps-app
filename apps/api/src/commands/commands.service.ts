import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DeviceCommand, Prisma } from '@prisma/client';
import {
  API_CRITICAL_COMMANDS,
  AvailableCommand,
  COMMAND_DEF_MAP,
  COMMAND_DEFS,
  COMMAND_TTL_HOURS,
  DEVICE_INFO_QUERIES,
  parseDeviceInfo,
  CommandDispatch,
  CommandDto,
  CommandType,
  CommandUpdate,
  ENGINE_STOP_MAX_SPEED_KPH,
  PROTOCOL_COMMANDS,
  SendCommandRequest,
} from '@veetracer/shared';
import { hasPermission, allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { verifyPassword } from '../common/secrets';
import { LiveStateService } from '../live/live-state.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

const HISTORY_LIMIT = 30;

interface Target {
  objectId: string;
  companyId: string;
  name: string;
  deviceId: string;
  uniqueId: string;
  protocol: string;
  capabilities: string[];
}

/** Custom (raw) commands are for support staff: the Super Admin or users who can edit devices. */
const canCustom = (ctx: AuthContext) => ctx.isSuperAdmin || hasPermission(ctx, 'devices', 'edit');

/**
 * Device commands. The API records the command, then hands it to the gateway holding the device's connection
 * (`vt:conn:<id>` → gateway id → pub/sub), or queues it in Valkey until the device next connects. Gateways report
 * SENT / ACKED through `vt:cmd:updates` (and `vt:cmd:state:<id>` so nothing is lost while the API restarts).
 */
@Injectable()
export class CommandsService implements OnModuleInit {
  private readonly logger = new Logger('Commands');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly liveState: LiveStateService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.redis.subscribe([RedisKeys.commandUpdates], (_channel, message) => {
      try {
        void this.apply(JSON.parse(message) as CommandUpdate);
      } catch {
        // Ignore malformed messages.
      }
    });
  }

  private async target(ctx: AuthContext, objectId: string): Promise<Target> {
    const o = await this.prisma.trackedObject.findFirst({
      // Super Admin in the All companies view acts on any company's vehicle.
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] },
      select: {
        id: true,
        companyId: true,
        name: true,
        assignments: { where: { toTime: null }, select: { device: { select: { id: true, uniqueId: true, model: { select: { protocol: true, capabilities: true } } } } } },
      },
    });
    if (!o) throw new NotFoundException('Vehicle not found');
    const d = o.assignments[0]?.device;
    if (!d) throw new BadRequestException('This vehicle has no tracker assigned');
    return { objectId: o.id, companyId: o.companyId, name: o.name, deviceId: d.id, uniqueId: d.uniqueId, protocol: d.model.protocol, capabilities: d.model.capabilities };
  }

  private catalogue(ctx: AuthContext, t: Target): AvailableCommand[] {
    const texts = PROTOCOL_COMMANDS[t.protocol];
    if (!texts) return [];
    return COMMAND_DEFS.flatMap((def) => {
      if (def.type === 'custom') return canCustom(ctx) ? [{ ...def, payload: '' }] : [];
      const payload = texts[def.type];
      if (!payload) return [];
      if (def.capability && !t.capabilities.includes(def.capability)) return [];
      return [{ ...def, payload }];
    });
  }

  async available(ctx: AuthContext, objectId: string): Promise<AvailableCommand[]> {
    return this.catalogue(ctx, await this.target(ctx, objectId));
  }

  async send(ctx: AuthContext, objectId: string, req: SendCommandRequest): Promise<CommandDto> {
    const t = await this.target(ctx, objectId);
    const cmd = this.catalogue(ctx, t).find((c) => c.type === req.type);
    if (!cmd) throw new BadRequestException(`"${COMMAND_DEF_MAP[req.type]?.label ?? req.type}" is not supported by this tracker`);
    const text = req.type === 'custom' ? (req.text ?? '').trim() : cmd.payload;
    if (!text) throw new BadRequestException('Enter the command text');

    // Customer API keys: no raw commands; engine stop / restore only with the explicit critical scope.
    if (ctx.apiKey) {
      if (req.type === 'custom') throw new ForbiddenException('Custom commands are not available through the API');
      if ((API_CRITICAL_COMMANDS as readonly string[]).includes(req.type) && !ctx.apiKey.scopes.includes('write:commands:critical')) {
        throw new ForbiddenException('This API key lacks the "write:commands:critical" scope needed for engine stop / restore');
      }
    }
    if (cmd.critical && ctx.apiKey) {
      await this.assertSlow(t);
    } else if (cmd.critical) {
      const user = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { passwordHash: true } });
      if (!user?.passwordHash) throw new ForbiddenException('Set a password on your account to send this command');
      if (!req.password || !(await verifyPassword(req.password, user.passwordHash))) throw new ForbiddenException('Password is incorrect');
      await this.assertSlow(t);
    }

    const row = await this.prisma.deviceCommand.create({
      data: {
        companyId: t.companyId,
        objectId: t.objectId,
        deviceId: t.deviceId,
        uniqueId: t.uniqueId,
        type: req.type,
        payload: text,
        createdById: ctx.apiKey ? null : ctx.userId,
        expiresAt: new Date(Date.now() + COMMAND_TTL_HOURS * 3600_000),
      },
    });
    await this.audit.record({ ...ctx, companyId: t.companyId }, { action: 'CREATE', entity: 'DeviceCommand', entityId: row.id, after: { objectId: t.objectId, vehicle: t.name, uniqueId: t.uniqueId, type: req.type, payload: text, ...(ctx.apiKey ? { apiKey: ctx.apiKey.name, apiKeyId: ctx.apiKey.id } : {}) } });
    await this.dispatch({ commandId: row.id, uniqueId: t.uniqueId, text });
    this.logger.log(`${ctx.userId} → ${t.uniqueId} ${req.type} "${text}" (${row.id})`);
    return (await this.toDtos([row]))[0];
  }

  /** Engine stop is refused while the vehicle moves faster than ENGINE_STOP_MAX_SPEED_KPH. */
  private async assertSlow(t: Target): Promise<void> {
    const live = (await this.liveState.read([t.objectId])).get(t.objectId);
    if (live && live.status !== 'OFFLINE' && live.speedKph > ENGINE_STOP_MAX_SPEED_KPH) {
      throw new BadRequestException(`The vehicle is moving at ${Math.round(live.speedKph)} km/h. Engine stop is only allowed below ${ENGINE_STOP_MAX_SPEED_KPH} km/h.`);
    }
  }

  /** A reply carrying the SIM ICCID or firmware version (e.g. VERSION# / ICCID# / getver) is saved on the device. */
  private async saveDeviceInfo(commandId: string, response: string, at: Date): Promise<void> {
    const info = parseDeviceInfo(response);
    if (!info.iccid && !info.version) return;
    const cmd = await this.prisma.deviceCommand.findUnique({ where: { id: commandId }, select: { deviceId: true } });
    if (!cmd) return;
    await this.prisma.device.update({
      where: { id: cmd.deviceId },
      data: { ...(info.iccid ? { iccid: info.iccid } : {}), ...(info.version ? { firmwareReported: info.version } : {}), deviceInfoAt: at },
    });
  }

  /** Super Admin: ask the tracker for its SIM ICCID and firmware version (answers are saved by saveDeviceInfo). */
  async readDeviceInfo(ctx: AuthContext, deviceId: string): Promise<{ sent: string[] }> {
    const d = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, uniqueId: true, companyId: true, model: { select: { protocol: true } }, assignments: { where: { toTime: null }, select: { objectId: true } } },
    });
    if (!d) throw new NotFoundException('Device not found');
    const texts = DEVICE_INFO_QUERIES[d.model.protocol] ?? [];
    if (!texts.length) throw new BadRequestException('This tracker type has no SIM / version query. Read them from the device label or the vendor tool.');
    const objectId = d.assignments[0]?.objectId;
    if (!objectId || !d.companyId) throw new BadRequestException('Fit the device to a vehicle or person first (commands are sent through it)');
    for (const text of texts) {
      const row = await this.prisma.deviceCommand.create({
        data: { companyId: d.companyId, objectId, deviceId: d.id, uniqueId: d.uniqueId, type: 'custom', payload: text, createdById: ctx.userId, expiresAt: new Date(Date.now() + COMMAND_TTL_HOURS * 3600_000) },
      });
      await this.dispatch({ commandId: row.id, uniqueId: d.uniqueId, text });
    }
    return { sent: texts };
  }

  /** Online: publish to the device's gateway. Offline (or a stale gateway id): queue for its next connection. */
  private async dispatch(d: CommandDispatch): Promise<void> {
    const json = JSON.stringify(d);
    const gatewayId = await this.redis.client.get(RedisKeys.connection(d.uniqueId));
    if (gatewayId && (await this.redis.client.publish(RedisKeys.commandChannel(gatewayId), json)) > 0) return;
    const key = RedisKeys.commandQueue(d.uniqueId);
    await this.redis.client.multi().rpush(key, json).expire(key, COMMAND_TTL_HOURS * 3600).exec();
  }

  async list(ctx: AuthContext, objectId: string): Promise<CommandDto[]> {
    const t = await this.target(ctx, objectId);
    let rows = await this.prisma.deviceCommand.findMany({ where: { objectId: t.objectId }, orderBy: { createdAt: 'desc' }, take: HISTORY_LIMIT });
    if (await this.reconcile(rows)) rows = await this.prisma.deviceCommand.findMany({ where: { objectId: t.objectId }, orderBy: { createdAt: 'desc' }, take: HISTORY_LIMIT });
    return this.toDtos(rows);
  }

  /** Applies gateway updates missed while the API was down, and expires undelivered commands. True if anything changed. */
  private async reconcile(rows: DeviceCommand[]): Promise<boolean> {
    const open = rows.filter((r) => r.status === 'QUEUED' || r.status === 'SENT');
    if (!open.length) return false;
    let changed = false;
    const states = await this.redis.client.mget(open.map((r) => RedisKeys.commandState(r.id)));
    for (let i = 0; i < open.length; i++) {
      const s = states[i];
      if (s) changed = (await this.apply(JSON.parse(s) as CommandUpdate)) || changed;
    }
    const expired = await this.prisma.deviceCommand.updateMany({ where: { id: { in: open.map((r) => r.id) }, status: 'QUEUED', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } });
    return changed || expired.count > 0;
  }

  /** Moves a command forward (QUEUED → SENT → ACKED); never backwards. */
  private async apply(u: CommandUpdate): Promise<boolean> {
    const at = new Date(u.at);
    const from: Prisma.EnumCommandStatusFilter['in'] = u.status === 'SENT' ? ['QUEUED'] : ['QUEUED', 'SENT'];
    const data: Prisma.DeviceCommandUpdateManyMutationInput =
      u.status === 'SENT'
        ? { status: 'SENT', sentAt: at }
        : u.status === 'ACKED'
          ? { status: 'ACKED', ackAt: at, response: u.response ?? null }
          : { status: 'FAILED', error: u.error ?? null };
    try {
      const r = await this.prisma.deviceCommand.updateMany({ where: { id: u.commandId, status: { in: from } }, data });
      // A reply can arrive before the SENT update was applied; record when it was sent too.
      if (u.status === 'ACKED' && r.count) await this.prisma.deviceCommand.updateMany({ where: { id: u.commandId, sentAt: null }, data: { sentAt: at } });
      if (u.status === 'ACKED' && r.count && u.response) await this.saveDeviceInfo(u.commandId, u.response, at);
      return r.count > 0;
    } catch (error) {
      this.logger.error(`Command update ${u.commandId} failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async toDtos(rows: DeviceCommand[]): Promise<CommandDto[]> {
    const ids = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => !!id))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      objectId: r.objectId,
      uniqueId: r.uniqueId,
      type: r.type as CommandType,
      payload: r.payload,
      status: r.status,
      response: r.response,
      error: r.error,
      createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      ackAt: r.ackAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
    }));
  }
}
