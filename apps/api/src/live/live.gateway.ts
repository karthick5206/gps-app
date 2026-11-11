import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { ALL_COMPANIES, AlertDto, AlertsAckedEvent, LiveObject, PLANNED_TRIP_SOCKET_EVENT, PlannedTripLiveUpdate, SystemHealthSummary } from '@veetracer/shared';
import { Namespace, Socket } from 'socket.io';
import { hasPermission, objectScopeWhere, shareOf } from '../access/access-rules';
import { asSharedLive } from './shared-live';
import { AuthContext } from '../access/auth-context';
import { AuthContextService } from '../access/auth-context.service';
import type { AlertStateMessage } from '../alerts/alerts/alert-sync.service';
import { loadEnv } from '../config/env';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { apiMetrics } from '../monitoring/api-metrics';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

const FLUSH_MS = 1000;
const SCOPE_REFRESH_MS = 60_000;
const INVALIDATE_DEBOUNCE_MS = 1000;

interface Client {
  socket: Socket;
  ctx: AuthContext;
  /** Allowed object ids; null = every object of the company (COMPANY scope). */
  allowed: Set<string> | null;
  /** Vehicles locked by an expired licence: no live updates. */
  locked: Set<string>;
  /** Latest update per object since the last flush. */
  pending: Map<string, LiveObject>;
}

interface LiveUpdate {
  companyId: string;
  live: LiveObject;
}

/**
 * Realtime fan-out on namespace `/live`: one Valkey subscription for the whole process, per-socket scope
 * filtering, and a `live:batch` emit per socket every second (latest state per object).
 */
/** Room of the Super Admin sockets that view all companies (they get every company's updates and alerts). */
const ALL_COMPANIES_ROOM = '*';
const roomOf = (client: Client) => (client.ctx.allCompanies ? ALL_COMPANIES_ROOM : client.ctx.companyId);

@WebSocketGateway({ namespace: '/live', cors: { origin: loadEnv().corsOrigins, credentials: true } })
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(LiveGateway.name);
  private readonly clients = new Map<string, Client>();
  private readonly byCompany = new Map<string, Set<Client>>();
  /** Sockets of the companies a vehicle is shared with. */
  private readonly byShared = new Map<string, Set<Client>>();
  private timers: NodeJS.Timeout[] = [];
  private invalidateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly contexts: AuthContextService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown; companyId?: unknown };
      if (typeof auth.token !== 'string') return next(new Error('Missing access token'));
      const companyId = typeof auth.companyId === 'string' ? auth.companyId : undefined;
      this.contexts
        .fromToken(auth.token, companyId, socket.handshake.address)
        .then((ctx) => {
          if (!hasPermission(ctx, 'live_map', 'view') && !hasPermission(ctx, 'alerts', 'view')) {
            return next(new Error('Permission denied'));
          }
          socket.data.ctx = ctx;
          next();
        })
        .catch((error: Error) => next(new Error(error.message || 'Unauthorized')));
    });

    const channels = [RedisKeys.liveUpdates, RedisKeys.cacheInvalidate, RedisKeys.alertsChannel, RedisKeys.alertsState, RedisKeys.healthUpdates, RedisKeys.plannedTripUpdates];
    this.redis.subscribe(channels, (channel, message) => {
      if (channel === RedisKeys.liveUpdates) this.onUpdate(message);
      else if (channel === RedisKeys.alertsChannel) this.onAlert(message);
      else if (channel === RedisKeys.plannedTripUpdates) this.onPlannedTrip(message);
      else if (channel === RedisKeys.alertsState) this.onAlertState(message);
      else if (channel === RedisKeys.healthUpdates) this.onSystemHealth(message);
      else this.scheduleRefresh();
    });
    this.timers = [
      setInterval(() => this.flush(), FLUSH_MS),
      setInterval(() => void this.refreshAll(), SCOPE_REFRESH_MS),
    ];
  }

  async handleConnection(socket: Socket): Promise<void> {
    const ctx = socket.data.ctx as AuthContext;
    const client: Client = { socket, ctx, allowed: await this.allowedObjects(ctx), locked: await this.lockedObjects(ctx), pending: new Map() };
    if (!socket.connected) return;
    this.clients.set(socket.id, client);
    this.index(client);
    this.indexShares(client);
    apiMetrics.sockets = this.clients.size;
  }

  handleDisconnect(socket: Socket): void {
    const client = this.clients.get(socket.id);
    if (!client) return;
    this.clients.delete(socket.id);
    this.byCompany.get(roomOf(client))?.delete(client);
    this.unindexShares(client);
    apiMetrics.sockets = this.clients.size;
  }

  onModuleDestroy(): void {
    this.timers.forEach(clearInterval);
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
  }

  /** Sockets of a company plus the Super Admins viewing all companies. */
  private clientsOf(companyId: string): Client[] | undefined {
    const own = this.byCompany.get(companyId);
    const all = this.byCompany.get(ALL_COMPANIES_ROOM);
    if (!all?.size) return own ? [...own] : undefined;
    return [...(own ?? []), ...all];
  }

  private index(client: Client): void {
    const set = this.byCompany.get(roomOf(client)) ?? new Set<Client>();
    set.add(client);
    this.byCompany.set(roomOf(client), set);
  }

  private indexShares(client: Client): void {
    for (const x of client.ctx.shares ?? []) {
      const set = this.byShared.get(x.objectId) ?? new Set<Client>();
      set.add(client);
      this.byShared.set(x.objectId, set);
    }
  }

  private unindexShares(client: Client): void {
    for (const x of client.ctx.shares ?? []) {
      const set = this.byShared.get(x.objectId);
      set?.delete(client);
      if (set && !set.size) this.byShared.delete(x.objectId);
    }
  }

  private onUpdate(message: string): void {
    let update: LiveUpdate;
    try {
      update = JSON.parse(message) as LiveUpdate;
    } catch {
      return;
    }
    const objectId = update.live.objectId;
    for (const client of this.clientsOf(update.companyId) ?? []) {
      if (!hasPermission(client.ctx, 'live_map', 'view')) continue;
      if (client.locked.has(objectId)) continue;
      if (client.allowed === null || client.allowed.has(objectId)) client.pending.set(objectId, update.live);
    }
    for (const client of this.byShared.get(objectId) ?? []) {
      if (!hasPermission(client.ctx, 'live_map', 'view') || client.locked.has(objectId)) continue;
      client.pending.set(objectId, asSharedLive(update.live));
    }
  }

  /** New alert: emitted immediately (not batched) to in-scope sockets holding `alerts:view`. */
  private onAlert(message: string): void {
    let event: { companyId: string; alert: AlertDto };
    try {
      event = JSON.parse(message) as { companyId: string; alert: AlertDto };
    } catch {
      return;
    }
    for (const client of this.clientsOf(event.companyId) ?? []) {
      if (!hasPermission(client.ctx, 'alerts', 'view')) continue;
      if (client.allowed === null || client.allowed.has(event.alert.objectId)) client.socket.emit('alert', event.alert);
    }
    // Only when the share includes alerts; acknowledging stays with the owner.
    for (const client of this.byShared.get(event.alert.objectId) ?? []) {
      if (!hasPermission(client.ctx, 'alerts', 'view') || client.locked.has(event.alert.objectId)) continue;
      if (shareOf(client.ctx, event.alert.objectId)?.alertsOn) client.socket.emit('alert', { ...event.alert, ackRequired: false });
    }
  }

  /**
   * Planned-trip progress from the processor's tracker: emitted immediately as `plannedTrip.update` to the company's
   * sockets holding `plannedTrips:view` with the vehicle in scope (not to vehicles shared from other companies).
   */
  private onPlannedTrip(message: string): void {
    let msg: { companyId: string; objectId: string; update: PlannedTripLiveUpdate };
    try {
      msg = JSON.parse(message) as typeof msg;
    } catch {
      return;
    }
    if (!msg?.update?.id) return;
    for (const client of this.clientsOf(msg.companyId) ?? []) {
      if (!hasPermission(client.ctx, 'plannedTrips', 'view') || client.locked.has(msg.objectId)) continue;
      if (client.allowed === null || client.allowed.has(msg.objectId)) client.socket.emit(PLANNED_TRIP_SOCKET_EVENT, msg.update);
    }
  }

  /**
   * Alerts read / acknowledged. `alerts:read` goes to the reading user's own sockets (their other tab or phone);
   * `alerts:acked` to in-scope sockets of the company holding `alerts:view`, so everyone's bell and badge update.
   */
  private onAlertState(message: string): void {
    let msg: AlertStateMessage;
    try {
      msg = JSON.parse(message) as AlertStateMessage;
    } catch {
      return;
    }
    if (msg.kind === 'read') {
      for (const client of this.clients.values()) if (client.ctx.userId === msg.userId) client.socket.emit('alerts:read', msg.event);
      return;
    }
    const clients = this.clientsOf(msg.companyId);
    if (!clients) return;
    for (const client of clients) {
      if (!hasPermission(client.ctx, 'alerts', 'view')) continue;
      const ids = msg.items && msg.items.filter((i) => client.allowed === null || client.allowed.has(i.objectId)).map((i) => i.id);
      if (ids && !ids.length) continue;
      const event: AlertsAckedEvent = { ...(ids ? { ids } : {}), ackByName: msg.ackByName, ackAt: msg.ackAt };
      client.socket.emit('alerts:acked', event);
    }
  }

  /** System Health evaluation (`SystemHealthSummary`): only the Super Admin's sockets, any selected company. */
  private onSystemHealth(message: string): void {
    let summary: SystemHealthSummary;
    try {
      summary = JSON.parse(message) as SystemHealthSummary;
    } catch {
      return;
    }
    for (const client of this.clients.values()) {
      if (client.ctx.isSuperAdmin) client.socket.emit('system:health', summary);
    }
  }

  private flush(): void {
    for (const client of this.clients.values()) {
      if (!client.pending.size) continue;
      client.socket.emit('live:batch', [...client.pending.values()]);
      client.pending.clear();
    }
  }

  private async allowedObjects(ctx: AuthContext): Promise<Set<string> | null> {
    if (ctx.dataScope === 'COMPANY') return null;
    const rows = await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  private async lockedObjects(ctx: AuthContext): Promise<Set<string>> {
    const own = (await this.licences?.lockedObjectIds(ctx)) ?? new Set<string>();
    if (!ctx.shares?.length) return own;
    return new Set([...own, ...((await this.licences?.lockedSharedIds(ctx.shares)) ?? [])]);
  }

  private scheduleRefresh(): void {
    if (this.invalidateTimer) return;
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      void this.refreshAll();
    }, INVALIDATE_DEBOUNCE_MS);
  }

  /** Re-resolve each socket's permissions and scope; disconnect sockets that lost access. */
  private async refreshAll(): Promise<void> {
    for (const client of [...this.clients.values()]) {
      try {
        const { ctx } = client;
        const requested = ctx.allCompanies ? ALL_COMPANIES : ctx.companyId !== ctx.homeCompanyId ? ctx.companyId : undefined;
        const next = await this.contexts.forUser(ctx.userId, requested, ctx.ip);
        if (!hasPermission(next, 'live_map', 'view') && !hasPermission(next, 'alerts', 'view')) throw new Error('Permission denied');
        this.unindexShares(client);
        client.ctx = next;
        this.indexShares(client);
        client.allowed = await this.allowedObjects(next);
        client.locked = await this.lockedObjects(next);
      } catch (error) {
        this.logger.log(`Disconnecting socket ${client.socket.id}: ${(error as Error).message}`);
        client.socket.disconnect(true);
      }
    }
  }
}
