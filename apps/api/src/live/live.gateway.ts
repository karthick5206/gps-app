import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { ALL_COMPANIES, AlertDto, AlertsAckedEvent, LiveObject, PLANNED_TRIP_SOCKET_EVENT, PlannedTripLiveUpdate, SOS_SOCKET_EVENT, SystemHealthSummary } from '@veetracer/shared';
import { Namespace, Socket } from 'socket.io';
import { hasPermission, objectScopeWhere, shareOf } from '../access/access-rules';
import { asSharedLive } from './shared-live';
import { AuthContext } from '../access/auth-context';
import { AuthContextService } from '../access/auth-context.service';
import { SessionsRevokedMessage, parseSessionsRevoked, revocationMatches } from '../auth/session-revocation';
import type { AlertStateMessage } from '../alerts/alerts/alert-sync.service';
import { loadEnv } from '../config/env';
import { incidentAccess } from '../etms/safety/sos-rules';
import { SOS_CHANNEL, sosLocalBus, type SosFanoutMessage } from '../etms/safety/sos-bus';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { apiMetrics } from '../monitoring/api-metrics';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

const FLUSH_MS = 1000;
const SCOPE_REFRESH_MS = 60_000;
const INVALIDATE_DEBOUNCE_MS = 1000;
/** How long a received revocation is kept to catch sockets still in the handshake when it arrived. */
const RECENT_REVOCATION_MS = 60_000;

interface Client {
  socket: Socket;
  ctx: AuthContext;
  /** Session that opened the socket (access token `sid`); null for legacy tokens without one. R-14. */
  sessionId: string | null;
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
  /** Revocations received in the last RECENT_REVOCATION_MS, with the local receive time. */
  private recentRevocations: { msg: SessionsRevokedMessage; receivedAt: number }[] = [];
  private offSosBus: (() => void) | null = null;

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
      // A revocation received after this instant may have raced the session check below (see handleConnection).
      socket.data.authStartedAt = Date.now();
      this.contexts
        .fromToken(auth.token, companyId, socket.handshake.address)
        .then((ctx) => {
          if (!hasPermission(ctx, 'live_map', 'view') && !hasPermission(ctx, 'alerts', 'view') && !hasPermission(ctx, 'etms_incidents', 'view')) {
            return next(new Error('Permission denied'));
          }
          socket.data.ctx = ctx;
          next();
        })
        .catch((error: Error) => next(new Error(error.message || 'Unauthorized')));
    });

    const channels = [
      RedisKeys.liveUpdates,
      RedisKeys.cacheInvalidate,
      RedisKeys.alertsChannel,
      RedisKeys.alertsState,
      RedisKeys.healthUpdates,
      RedisKeys.plannedTripUpdates,
      RedisKeys.sessionsRevoked,
      SOS_CHANNEL,
    ];
    this.redis.subscribe(channels, (channel, message) => {
      if (channel === RedisKeys.liveUpdates) this.onUpdate(message);
      else if (channel === RedisKeys.sessionsRevoked) this.onSessionsRevoked(message);
      else if (channel === RedisKeys.alertsChannel) this.onAlert(message);
      else if (channel === RedisKeys.plannedTripUpdates) this.onPlannedTrip(message);
      else if (channel === RedisKeys.alertsState) this.onAlertState(message);
      else if (channel === RedisKeys.healthUpdates) this.onSystemHealth(message);
      else if (channel === SOS_CHANNEL) this.onSos(message);
      else this.scheduleRefresh();
    });
    // ETMS SOS direct-send fallback (Valkey down): the SAFETY relay of this process emits here directly.
    this.offSosBus = sosLocalBus.register((msg) => this.emitSos(msg));
    this.timers = [
      setInterval(() => this.flush(), FLUSH_MS),
      setInterval(() => void this.refreshAll(), SCOPE_REFRESH_MS),
    ];
  }

  async handleConnection(socket: Socket): Promise<void> {
    const ctx = socket.data.ctx as AuthContext;
    const client: Client = { socket, ctx, sessionId: ctx.sessionId ?? null, allowed: await this.allowedObjects(ctx), locked: await this.lockedObjects(ctx), pending: new Map() };
    if (!socket.connected) return;
    this.clients.set(socket.id, client);
    this.index(client);
    this.indexShares(client);
    apiMetrics.sockets = this.clients.size;
    // Revoked while this socket was between the session check and registration: drop it now.
    const since = typeof socket.data.authStartedAt === 'number' ? socket.data.authStartedAt : 0;
    if (this.recentRevocations.some((r) => r.receivedAt >= since && revocationMatches(r.msg, { userId: ctx.userId, sessionId: client.sessionId }))) {
      this.logger.log(`Disconnecting socket ${socket.id}: session revoked during handshake`);
      this.drop(client);
    }
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
    this.offSosBus?.();
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

  /** ETMS SOS (WP 5.4) from Valkey: see emitSos. */
  private onSos(message: string): void {
    let msg: SosFanoutMessage;
    try {
      msg = JSON.parse(message) as SosFanoutMessage;
    } catch {
      return;
    }
    if (msg?.payload?.incidentId) this.emitSos(msg);
  }

  /**
   * `transport.sos` (doc 05 §5.5): emitted immediately (not batched) to sockets holding etms_incidents:view that may
   * see the incident (incidentAccess: the raiser's company, the other party with an incident grant, the Super Admin).
   * Not vehicle-scoped: an SOS is never hidden by branch. Returns the number of sockets reached (direct-send fallback).
   */
  private emitSos(msg: SosFanoutMessage): number {
    const targets = new Set<Client>();
    for (const companyId of [msg.providerCompanyId, msg.customerCompanyId]) if (companyId) for (const c of this.clientsOf(companyId) ?? []) targets.add(c);
    let n = 0;
    for (const client of targets) {
      if (!hasPermission(client.ctx, 'etms_incidents', 'view')) continue;
      if (!client.ctx.isSuperAdmin && !client.ctx.features?.includes('etms')) continue;
      if (incidentAccess(client.ctx, msg) === 'none') continue;
      client.socket.emit(SOS_SOCKET_EVENT, msg.payload);
      n++;
    }
    return n;
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

  /**
   * Sessions signed out on any API instance (R-14): disconnect the matching sockets right away. The client sees
   * `io server disconnect`, tries a token refresh, which fails for a revoked session, and signs the user out.
   */
  private onSessionsRevoked(message: string): void {
    const msg = parseSessionsRevoked(message);
    if (!msg) return;
    const now = Date.now();
    this.recentRevocations = this.recentRevocations.filter((r) => now - r.receivedAt < RECENT_REVOCATION_MS);
    this.recentRevocations.push({ msg, receivedAt: now });
    for (const client of [...this.clients.values()]) {
      if (!revocationMatches(msg, { userId: client.ctx.userId, sessionId: client.sessionId })) continue;
      this.logger.log(`Disconnecting socket ${client.socket.id}: session revoked`);
      this.drop(client);
    }
  }

  /** Disconnect and forget a socket at once, so no event is queued for it even before `handleDisconnect` runs. */
  private drop(client: Client): void {
    client.pending.clear();
    this.handleDisconnect(client.socket);
    client.socket.disconnect(true);
  }

  /**
   * Session ids (of the given ones) that are missing, revoked or expired. One indexed query per refresh tick; this is
   * the fallback when a `sessionsRevoked` message was lost (Valkey down), bounding the exposure to SCOPE_REFRESH_MS.
   */
  private async endedSessions(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.session.findMany({ where: { id: { in: ids } }, select: { id: true, revokedAt: true, expiresAt: true } });
    const now = Date.now();
    const live = new Set(rows.filter((r) => !r.revokedAt && r.expiresAt.getTime() > now).map((r) => r.id));
    return new Set(ids.filter((id) => !live.has(id)));
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
    const clients = [...this.clients.values()];
    let ended = new Set<string>();
    try {
      ended = await this.endedSessions([...new Set(clients.map((c) => c.sessionId).filter((id): id is string => !!id))]);
    } catch (error) {
      this.logger.warn(`Session re-check failed: ${(error as Error).message}`);
    }
    for (const client of clients) {
      if (!this.clients.has(client.socket.id)) continue;
      if (client.sessionId && ended.has(client.sessionId)) {
        this.logger.log(`Disconnecting socket ${client.socket.id}: session ended`);
        this.drop(client);
        continue;
      }
      try {
        const { ctx } = client;
        const requested = ctx.allCompanies ? ALL_COMPANIES : ctx.companyId !== ctx.homeCompanyId ? ctx.companyId : undefined;
        const next = await this.contexts.forUser(ctx.userId, requested, ctx.ip);
        // Same gate as the handshake (security review L2): a role with Incidents & SOS only keeps its socket.
        if (!hasPermission(next, 'live_map', 'view') && !hasPermission(next, 'alerts', 'view') && !hasPermission(next, 'etms_incidents', 'view')) throw new Error('Permission denied');
        // Dropped meanwhile (revoked / disconnected): do not re-index it.
        if (!this.clients.has(client.socket.id)) continue;
        this.unindexShares(client);
        // Keep the session binding: forUser() resolves by user id only.
        client.ctx = { ...next, sessionId: client.sessionId };
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
