import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { AlertDto, LiveObject, SystemHealthSummary } from '@veetracer/shared';
import { Namespace, Socket } from 'socket.io';
import { hasPermission, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuthContextService } from '../access/auth-context.service';
import { loadEnv } from '../config/env';
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
@WebSocketGateway({ namespace: '/live', cors: { origin: loadEnv().corsOrigins, credentials: true } })
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(LiveGateway.name);
  private readonly clients = new Map<string, Client>();
  private readonly byCompany = new Map<string, Set<Client>>();
  private timers: NodeJS.Timeout[] = [];
  private invalidateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly contexts: AuthContextService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
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

    this.redis.subscribe([RedisKeys.liveUpdates, RedisKeys.cacheInvalidate, RedisKeys.alertsChannel, RedisKeys.healthUpdates], (channel, message) => {
      if (channel === RedisKeys.liveUpdates) this.onUpdate(message);
      else if (channel === RedisKeys.alertsChannel) this.onAlert(message);
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
    const client: Client = { socket, ctx, allowed: await this.allowedObjects(ctx), pending: new Map() };
    if (!socket.connected) return;
    this.clients.set(socket.id, client);
    this.index(client);
    apiMetrics.sockets = this.clients.size;
  }

  handleDisconnect(socket: Socket): void {
    const client = this.clients.get(socket.id);
    if (!client) return;
    this.clients.delete(socket.id);
    this.byCompany.get(client.ctx.companyId)?.delete(client);
    apiMetrics.sockets = this.clients.size;
  }

  onModuleDestroy(): void {
    this.timers.forEach(clearInterval);
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
  }

  private index(client: Client): void {
    const set = this.byCompany.get(client.ctx.companyId) ?? new Set<Client>();
    set.add(client);
    this.byCompany.set(client.ctx.companyId, set);
  }

  private onUpdate(message: string): void {
    let update: LiveUpdate;
    try {
      update = JSON.parse(message) as LiveUpdate;
    } catch {
      return;
    }
    const clients = this.byCompany.get(update.companyId);
    if (!clients) return;
    const objectId = update.live.objectId;
    for (const client of clients) {
      if (!hasPermission(client.ctx, 'live_map', 'view')) continue;
      if (client.allowed === null || client.allowed.has(objectId)) client.pending.set(objectId, update.live);
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
    const clients = this.byCompany.get(event.companyId);
    if (!clients) return;
    for (const client of clients) {
      if (!hasPermission(client.ctx, 'alerts', 'view')) continue;
      if (client.allowed === null || client.allowed.has(event.alert.objectId)) client.socket.emit('alert', event.alert);
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
        const requested = ctx.companyId !== ctx.homeCompanyId ? ctx.companyId : undefined;
        const next = await this.contexts.forUser(ctx.userId, requested, ctx.ip);
        if (!hasPermission(next, 'live_map', 'view') && !hasPermission(next, 'alerts', 'view')) throw new Error('Permission denied');
        client.ctx = next;
        client.allowed = await this.allowedObjects(next);
      } catch (error) {
        this.logger.log(`Disconnecting socket ${client.socket.id}: ${(error as Error).message}`);
        client.socket.disconnect(true);
      }
    }
  }
}
