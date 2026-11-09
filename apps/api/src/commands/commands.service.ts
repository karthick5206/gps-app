import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  engineStopBlockReason,
  ENGINE_STOP_PREPARE_MAX_PER_USER,
  ENGINE_STOP_PREPARE_MAX_PER_VEHICLE,
  ENGINE_STOP_PREPARE_WINDOW_SEC,
  ENGINE_STOP_PROBE_COMMANDS,
  EngineStopPrepareRequest,
  EngineStopPrepareResponse,
  freshPositionReason,
  isSafetyCriticalDispatch,
  NO_QUEUE_NOT_DELIVERED,
  PROTOCOL_COMMANDS,
  SendCommandRequest,
} from '@veetracer/shared';
import { PREPARE_NOT_CONNECTED, PREPARE_STATE_TTL_SEC, PrepareState, prepareVerdict } from './engine-stop-prepare';
import { hasPermission, allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { verifyPassword } from '../common/secrets';
import { LiveStateService } from '../live/live-state.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

const HISTORY_LIMIT = 30;
const ENGINE_STOP_NOT_CONNECTED = 'Not sent: the tracker is not connected right now. Engine stop is never queued; send it again once the vehicle is online.';

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
    if (req.prepareRequestId && (req.type !== 'engine_stop' || ctx.apiKey)) {
      throw new BadRequestException('A fresh-position confirmation only applies to engine stop sent by a signed-in user');
    }

    // Customer API keys: no raw commands; engine stop / restore only with the explicit critical scope.
    if (ctx.apiKey) {
      if (req.type === 'custom') throw new ForbiddenException('Custom commands are not available through the API');
      if ((API_CRITICAL_COMMANDS as readonly string[]).includes(req.type) && !ctx.apiKey.scopes.includes('write:commands:critical')) {
        throw new ForbiddenException('This API key lacks the "write:commands:critical" scope needed for engine stop / restore');
      }
    }
    if (cmd.critical && ctx.apiKey) {
      await this.assertEngineStopSafe(t);
    } else if (cmd.critical) {
      const user = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { passwordHash: true } });
      if (!user?.passwordHash) throw new ForbiddenException('Set a password on your account to send this command');
      if (!req.password || !(await verifyPassword(req.password, user.passwordHash))) throw new ForbiddenException('Password is incorrect');
      await this.assertEngineStopSafe(t);
      // Additional (never replacing) check when the user confirmed a fresh position from the preparation step.
      if (req.prepareRequestId) await this.consumePrepare(ctx, t, req.prepareRequestId);
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
    await this.audit.record({ ...ctx, companyId: t.companyId }, { action: 'CREATE', entity: 'DeviceCommand', entityId: row.id, after: { objectId: t.objectId, vehicle: t.name, uniqueId: t.uniqueId, type: req.type, payload: text, ...(req.prepareRequestId ? { prepareRequestId: req.prepareRequestId } : {}), ...(ctx.apiKey ? { apiKey: ctx.apiKey.name, apiKeyId: ctx.apiKey.id } : {}) } });
    const delivered = await this.dispatch({ commandId: row.id, uniqueId: t.uniqueId, text, ...(cmd.critical ? { critical: true, issuedAt: new Date().toISOString() } : {}) });
    this.logger.log(`${ctx.userId} → ${t.uniqueId} ${req.type} "${text}" (${row.id})${delivered ? '' : cmd.critical ? ' NOT SENT (tracker not connected)' : ' queued'}`);
    if (!delivered && cmd.critical) {
      // Decision Q-01: an engine stop is never queued for later delivery.
      const failed = await this.prisma.deviceCommand.update({ where: { id: row.id }, data: { status: 'FAILED', error: ENGINE_STOP_NOT_CONNECTED } });
      await this.audit.record({ ...ctx, companyId: t.companyId }, { action: 'UPDATE', entity: 'DeviceCommand', entityId: row.id, after: { status: 'FAILED', error: ENGINE_STOP_NOT_CONNECTED } });
      return (await this.toDtos([failed]))[0];
    }
    return (await this.toDtos([row]))[0];
  }

  // ── Engine-stop preparation: "request a fresh position, then confirm" (anti-theft proposal, Option 1) ──

  /**
   * Starts (no `requestId`) or polls (`requestId`) an engine-stop preparation. Starting sends the protocol's position
   * request to a tracker that is CONNECTED right now (never queued) and records it; polling reports whether a fresh
   * position (received after the request, valid GPS fix) has arrived and whether the unchanged engine-stop rules allow
   * a stop with it. It never sends, queues or authorises the engine stop itself.
   */
  async prepareEngineStop(ctx: AuthContext, objectId: string, req: EngineStopPrepareRequest): Promise<EngineStopPrepareResponse> {
    if (ctx.apiKey) throw new ForbiddenException('The fresh-position step is for signed-in users. API keys send engine stop directly (all safety rules apply).');
    const t = await this.target(ctx, objectId);
    if (!this.catalogue(ctx, t).some((c) => c.type === 'engine_stop')) throw new BadRequestException('"Stop engine" is not supported by this tracker');
    const actor = { ...ctx, companyId: t.companyId };

    if (req.requestId) {
      const state = await this.loadPrepare(req.requestId);
      if (!state || state.userId !== ctx.userId || state.objectId !== t.objectId) throw new NotFoundException('This position request has expired. Request a fresh position again.');
      return this.evaluatePrepare(actor, t, state);
    }

    const probeText = ENGINE_STOP_PROBE_COMMANDS[t.protocol];
    if (!probeText) throw new BadRequestException('This tracker type has no position request for engine stop.');
    // Connected right now? Otherwise nothing is sent and nothing is kept for later (engine stop is never queued).
    if (!(await this.redis.client.get(RedisKeys.connection(t.uniqueId)))) {
      await this.audit.record(actor, { action: 'CREATE', entity: 'EngineStopPrepare', entityId: null, details: { objectId: t.objectId, vehicle: t.name, uniqueId: t.uniqueId, result: 'not_connected' } });
      return { requestId: null, status: 'not_connected', requestedAt: null, message: PREPARE_NOT_CONNECTED, blockReason: PREPARE_NOT_CONNECTED, freshPosition: null, confirmBy: null };
    }
    await this.limitPrepare(actor, t);

    const requestId = randomUUID();
    // Recorded before the request goes out, so a position can only count if the processor received it afterwards.
    const requestedAt = new Date();
    const row = await this.prisma.deviceCommand.create({
      data: {
        companyId: t.companyId,
        objectId: t.objectId,
        deviceId: t.deviceId,
        uniqueId: t.uniqueId,
        type: 'locate',
        payload: probeText,
        createdById: ctx.userId,
        expiresAt: new Date(requestedAt.getTime() + COMMAND_TTL_HOURS * 3600_000),
      },
    });
    const state: PrepareState = { requestId, userId: ctx.userId, objectId: t.objectId, companyId: t.companyId, uniqueId: t.uniqueId, commandId: row.id, requestedAt: requestedAt.toISOString() };
    await this.redis.client.set(RedisKeys.engineStopPrepare(requestId), JSON.stringify(state), 'EX', PREPARE_STATE_TTL_SEC);
    await this.audit.record(actor, {
      action: 'CREATE',
      entity: 'EngineStopPrepare',
      entityId: requestId,
      details: { objectId: t.objectId, vehicle: t.name, uniqueId: t.uniqueId, commandId: row.id, payload: probeText, requestedAt: state.requestedAt, result: 'requested' },
    });
    const delivered = await this.dispatch({ commandId: row.id, uniqueId: t.uniqueId, text: probeText, noQueue: true });
    this.logger.log(`${ctx.userId} → ${t.uniqueId} engine-stop position request "${probeText}" (${requestId})${delivered ? '' : ' NOT SENT (tracker not connected)'}`);
    if (!delivered) {
      await this.prisma.deviceCommand.update({ where: { id: row.id }, data: { status: 'FAILED', error: NO_QUEUE_NOT_DELIVERED } });
    }
    return this.evaluatePrepare(actor, t, state, delivered ? null : 'FAILED');
  }

  private async loadPrepare(requestId: string): Promise<PrepareState | null> {
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null;
    const json = await this.redis.client.get(RedisKeys.engineStopPrepare(requestId));
    try {
      return json ? (JSON.parse(json) as PrepareState) : null;
    } catch {
      return null;
    }
  }

  /** Position requests per user+vehicle and per vehicle (battery / data of the tracker; abuse). */
  private async limitPrepare(actor: AuthContext, t: Target): Promise<void> {
    const limits: [string, number][] = [
      [RedisKeys.engineStopPrepareRateUser(t.objectId, actor.userId), ENGINE_STOP_PREPARE_MAX_PER_USER],
      [RedisKeys.engineStopPrepareRateVehicle(t.objectId), ENGINE_STOP_PREPARE_MAX_PER_VEHICLE],
    ];
    for (const [key, max] of limits) {
      const count = Number(await this.redis.client.incr(key));
      if (count === 1) await this.redis.client.expire(key, ENGINE_STOP_PREPARE_WINDOW_SEC);
      if (count > max) {
        await this.audit.record(actor, { action: 'CREATE', entity: 'EngineStopPrepare', entityId: null, details: { objectId: t.objectId, vehicle: t.name, uniqueId: t.uniqueId, result: 'rate_limited' } });
        throw new HttpException(
          `Too many position requests for this vehicle. Wait up to ${ENGINE_STOP_PREPARE_WINDOW_SEC / 60} minutes and try again.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /** Current verdict; every change of outcome (ready / blocked / timeout / not_connected) is written to the audit trail. */
  private async evaluatePrepare(actor: AuthContext, t: Target, state: PrepareState, probeStatus?: 'FAILED' | null): Promise<EngineStopPrepareResponse> {
    const now = Date.now();
    let status = probeStatus;
    if (status === undefined) {
      const row = await this.prisma.deviceCommand.findUnique({ where: { id: state.commandId }, select: { status: true } });
      const update = await this.redis.client.get(RedisKeys.commandState(state.commandId));
      const failed = row?.status === 'FAILED' || (update ? (JSON.parse(update) as CommandUpdate).status === 'FAILED' : false);
      status = failed ? 'FAILED' : null;
    }
    const live = (await this.liveState.read([t.objectId])).get(t.objectId);
    let verdict = prepareVerdict(state, live, status, now);
    // A timeout / disconnection is final: a position arriving later doesn't revive this request.
    if ((state.outcome === 'timeout' || state.outcome === 'not_connected') && verdict.status !== state.outcome) {
      verdict = prepareVerdict(state, null, state.outcome === 'not_connected' ? 'FAILED' : null, Number.POSITIVE_INFINITY);
    }
    if (verdict.status !== 'waiting' && verdict.status !== state.outcome) {
      state.outcome = verdict.status;
      await this.redis.client.set(RedisKeys.engineStopPrepare(state.requestId), JSON.stringify(state), 'KEEPTTL');
      await this.audit.record(actor, {
        action: 'UPDATE',
        entity: 'EngineStopPrepare',
        entityId: state.requestId,
        details: {
          objectId: t.objectId,
          vehicle: t.name,
          uniqueId: t.uniqueId,
          result: verdict.status,
          ...(verdict.blockReason ? { reason: verdict.blockReason } : {}),
          ...(verdict.freshPosition ? { position: { ...verdict.freshPosition } } : {}),
        },
      });
    }
    return verdict;
  }

  /**
   * Final send with a confirmed preparation: the preparation must be this user's, for this vehicle, still hold a fresh
   * position and not have been used before (single use). Runs AFTER the unchanged engine-stop checks, never instead.
   */
  private async consumePrepare(ctx: AuthContext, t: Target, requestId: string): Promise<void> {
    const state = await this.loadPrepare(requestId);
    if (!state || state.userId !== ctx.userId || state.objectId !== t.objectId) {
      throw new BadRequestException('The fresh-position check has expired. Request a fresh position again.');
    }
    const live = (await this.liveState.read([t.objectId])).get(t.objectId);
    const reason = freshPositionReason(live, Date.parse(state.requestedAt), Date.now());
    if (reason) throw new BadRequestException(`The confirmed position is no longer current: ${reason} Request a fresh position again.`);
    const first = await this.redis.client.set(RedisKeys.engineStopPrepareUsed(requestId), ctx.userId, 'EX', PREPARE_STATE_TTL_SEC, 'NX');
    if (first !== 'OK') throw new ConflictException('This confirmation was already used. Request a fresh position again to send another engine stop.');
  }

  /**
   * Engine stop needs an online vehicle with telemetry from the last ENGINE_STOP_MAX_FIX_AGE_SEC seconds, moving no
   * faster than ENGINE_STOP_MAX_SPEED_KPH (decision Q-01). Unknown or stale state is refused, never assumed safe.
   */
  private async assertEngineStopSafe(t: Target): Promise<void> {
    const live = (await this.liveState.read([t.objectId])).get(t.objectId);
    const reason = engineStopBlockReason(live, Date.now());
    if (reason) throw new BadRequestException(reason);
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

  /**
   * Online: publish to the device's gateway (true). Offline (or a stale gateway id): queue for its next connection,
   * except safety-critical commands, which are never queued (false; the caller marks them FAILED).
   */
  private async dispatch(d: CommandDispatch): Promise<boolean> {
    const json = JSON.stringify(d);
    const gatewayId = await this.redis.client.get(RedisKeys.connection(d.uniqueId));
    if (gatewayId && (await this.redis.client.publish(RedisKeys.commandChannel(gatewayId), json)) > 0) return true;
    if (isSafetyCriticalDispatch(d) || d.noQueue) return false;
    const key = RedisKeys.commandQueue(d.uniqueId);
    await this.redis.client.multi().rpush(key, json).expire(key, COMMAND_TTL_HOURS * 3600).exec();
    return false;
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
