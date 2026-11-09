import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CommandDispatch, COMMAND_TTL_HOURS, criticalDispatchRejection, CRITICAL_NOT_DELIVERED_OFFLINE, GatewayMetrics, isSafetyCriticalDispatch, NO_QUEUE_NOT_DELIVERED } from '@veetracer/shared';
import { APP_ROOT, loadEnv } from '../config/env';
import { RateMeter, startHeartbeat } from '../monitoring/heartbeat';
import { RedisKeys } from '../redis/keys';
import { Ais140Decoder } from './ais140/decoder';
import { Gt06Decoder } from './gt06/decoder';
import { MediaHub } from './jt1078/hub';
import { MediaServer } from './jt1078/media-server';
import { VideoControl } from './jt1078/video-control';
import { Jt808Decoder, Jt808Session } from './jt808/decoder';
import { AttachmentServer } from './media/attachment-server';
import { MediaSink } from './media/media-sink';
import { SnapshotControl } from './media/snapshot-control';
import { BaseSession, ProtocolDecoder } from './protocol';
import { TcpGatewayServer } from './tcp-server';
import { TeltonikaDecoder } from './teltonika/decoder';
import { UnparsedLog } from './unparsed-log';
import { RelayManager } from './relay/relay-manager';
import { RELAY_LIMITS, relayPolicy } from '../relay/guard';
import { watchRuleSet } from '../relay/sync';
import { PositionSpool } from './spool/position-spool';
import { PositionPublisher } from './spool/position-publisher';
import { gatewayHealth, startGatewayHealthServer } from './spool/gateway-health';
import type { Server as HttpServer } from 'node:http';

const STATS_INTERVAL_MS = 30_000;
/** A listener that failed to bind (port in use) is retried this often; System Health shows it as not listening. */
const LISTEN_RETRY_MS = 30_000;

/**
 * Device gateway: one TCP listener per protocol, all feeding the same `vt:positions` stream.
 *   GT06_PORT (5023)       Concox / Jimi GT06 family (GT06N, GT800, V5, VL149, …)
 *   TELTONIKA_PORT (5027)  Teltonika FMB/FMC/FMM (0 disables)
 *   JT808_PORT (6808)      JT/T 808-2013/2019 dashcams and MDVRs (Mettax MC202, Jimi JC4xx) (0 disables)
 *   AIS140_PORT (5030)     AIS-140 VLT devices (iTriangle TS101) (0 disables)
 *   MEDIA_PORT (7612)      JT/T 1078 dashcam video streams (0 disables); MEDIA_HTTP_PORT (4110, localhost) HTTP-FLV
 *   ATTACH_PORT (7613)     Su-standard ADAS / DMS alarm attachments (photos / clips) (0 disables)
 * GATEWAY_CAPTURE =comma-separated IMEIs (or `all`) to write raw frames to var/logs/capture-<protocol>.log.
 *
 * Durable spool (docs/reliability/gateway-spool.md): positions that cannot be XADDed (cache down, or the processor
 * backlog near the stream cap) are fsynced to GATEWAY_SPOOL_DIR (default var/spool/positions) and replayed in order.
 *   GATEWAY_SPOOL=off disables it; GATEWAY_SPOOL_MAX_MB (1024) caps it; GATEWAY_SPOOL_REPLAY_PER_SEC (2000).
 *   GATEWAY_HEALTH_PORT (4121, localhost, 0 disables): /health and /health/live for the watchdog.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Gateway');
  const gatewayId = process.env.GATEWAY_ID ?? `gw-${hostname()}-${process.pid}`;
  const redis = new Redis(env.redisUrl);
  redis.on('error', (error) => logger.error(`Valkey error: ${error.message}`));

  // Positions get their own connection without an offline queue: while the cache is down an XADD fails at once (and
  // the positions go to the spool) instead of sitting in memory and being applied late, which would duplicate them.
  const positionsConn = new Redis(env.redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 5000,
    retryStrategy: (times) => Math.min(250 * 2 ** Math.min(times, 5), 5000) + Math.floor(Math.random() * 250),
  });
  let cacheDownSince: number | null = null;
  positionsConn.on('error', (error) => {
    if (cacheDownSince === null) logger.error(`Valkey (positions) error: ${error.message}`);
  });
  positionsConn.on('close', () => {
    if (cacheDownSince !== null) return;
    cacheDownSince = Date.now();
    logger.error('Cache connection for positions lost: spooling positions to disk until it is back');
  });
  positionsConn.on('ready', () => {
    if (cacheDownSince !== null) logger.log(`Cache connection for positions restored after ${Math.round((Date.now() - cacheDownSince) / 1000)} s`);
    cacheDownSince = null;
  });
  const spoolOn = (process.env.GATEWAY_SPOOL ?? 'on').toLowerCase() !== 'off';
  const spoolDir = process.env.GATEWAY_SPOOL_DIR || join(APP_ROOT, 'var', 'spool', 'positions');
  const spoolMaxMb = Number(process.env.GATEWAY_SPOOL_MAX_MB) > 0 ? Number(process.env.GATEWAY_SPOOL_MAX_MB) : 1024;
  const spool = spoolOn ? new PositionSpool({ dir: spoolDir, maxBytes: spoolMaxMb * 1024 * 1024 }) : null;
  const publisher = new PositionPublisher(positionsConn, spool, {
    replayPerSec: Number(process.env.GATEWAY_SPOOL_REPLAY_PER_SEC) > 0 ? Number(process.env.GATEWAY_SPOOL_REPLAY_PER_SEC) : 2000,
  });
  logger.log(spool ? `Position spool at ${spoolDir} (cap ${spoolMaxMb} MB, ${spool.pending} pending)` : 'Position spool disabled (GATEWAY_SPOOL=off)');

  const logDir = join(APP_ROOT, 'var', 'logs');
  const unparsed = new UnparsedLog({ dir: logDir });
  const captureIds = (process.env.GATEWAY_CAPTURE ?? '').trim();
  const capture = captureIds
    ? { dir: logDir, ids: captureIds === 'all' ? ('all' as const) : new Set(captureIds.split(',').map((s) => s.trim()).filter(Boolean)) }
    : null;

  const listeners: [ProtocolDecoder<BaseSession>, number][] = [
    [new Gt06Decoder() as ProtocolDecoder<BaseSession>, env.gt06Port],
    [new TeltonikaDecoder(), env.teltonikaPort],
    [
      new Jt808Decoder({ attachServer: env.attachPort ? { host: env.mediaPublicHost, port: env.attachPort } : null }) as ProtocolDecoder<BaseSession>,
      env.jt808Port,
    ],
    [new Ais140Decoder() as ProtocolDecoder<BaseSession>, env.ais140Port],
  ];
  const servers: TcpGatewayServer<BaseSession>[] = [];
  // Data forwarding (RAW_TCP): rules come from Valkey (published by the API), so the gateway stays database-free.
  const relay = new RelayManager({
    policy: relayPolicy(env),
    limits: { maxSocketsPerTarget: RELAY_LIMITS.maxSocketsPerTarget(), bufferBytes: RELAY_LIMITS.bufferBytes(), bufferFrames: RELAY_LIMITS.bufferFrames() },
  });
  const relaySub = new Redis(env.redisUrl);
  relaySub.on('error', (error) => logger.error(`Valkey (relay) error: ${error.message}`));
  // Cache-dependent setup never blocks the device listeners: it retries in the background until the cache is up.
  let stopRelaySync: () => void = () => undefined;
  untilCacheUp(logger, "forwarding rules", async () => {
    stopRelaySync = await watchRuleSet(redis, relaySub, (set) => relay.setRules(set));
  });
  // Driver event photos / clips (0x0801 snapshots, alarm attachments) → var/driver-media + vt:driver-media.
  const sink = new MediaSink(redis);
  const retries: NodeJS.Timeout[] = [];
  const listen = async (server: TcpGatewayServer<BaseSession>, port: number): Promise<void> => {
    try {
      await server.listen(port);
      logger.log(`${server.protocol} listening on tcp://0.0.0.0:${port}`);
    } catch (error) {
      // Keep the other protocols running; report the port as not listening and retry.
      logger.error(`${server.protocol} could not listen on ${port}: ${(error as Error).message} (retrying every ${LISTEN_RETRY_MS / 1000}s)`);
      const timer = setTimeout(() => void listen(server, port), LISTEN_RETRY_MS);
      retries.push(timer);
    }
  };
  for (const [decoder, port] of listeners) {
    if (!port) continue;
    const server = new TcpGatewayServer(decoder, { redis, gatewayId, unparsed, capture, onMedia: (m) => sink.accept(m), relay, publisher });
    servers.push(server);
    await listen(server, port);
  }
  // Commands for devices connected to this gateway (the API publishes to the channel named after vt:conn:<id>).
  const commands = new Redis(env.redisUrl);
  commands.on('error', (error) => logger.error(`Valkey (commands) error: ${error.message}`));
  commands.on('message', (_channel, message) => {
    let d: CommandDispatch;
    try {
      d = JSON.parse(message) as CommandDispatch;
    } catch {
      return;
    }
    if (isSafetyCriticalDispatch(d)) {
      // Decision Q-01: engine stop is sent only while fresh; never re-queued for a later connection.
      const reason = criticalDispatchRejection(d, Date.now());
      if (!reason && servers.some((s) => s.sendCommand(d))) return;
      logger.warn(`Safety-critical command ${d.commandId} for ${d.uniqueId} not sent: ${reason ?? 'device disconnected'}`);
      servers[0]?.failCommand(d.commandId, reason ?? CRITICAL_NOT_DELIVERED_OFFLINE);
      return;
    }
    if (servers.some((s) => s.sendCommand(d))) return;
    if (d.noQueue) {
      // Engine-stop position requests are never queued for a later connection.
      servers[0]?.failCommand(d.commandId, NO_QUEUE_NOT_DELIVERED);
      return;
    }
    // The device disconnected meanwhile: queue it for its next login.
    const key = RedisKeys.commandQueue(d.uniqueId);
    redis
      .multi()
      .rpush(key, message)
      .expire(key, COMMAND_TTL_HOURS * 3600)
      .exec()
      .catch((error: Error) => logger.error(`Command re-queue failed: ${error.message}`));
  });
  untilCacheUp(logger, "command channel", () => commands.subscribe(RedisKeys.commandChannel(gatewayId)));

  // JT/T 1078 dashcam video: media TCP (public) + HTTP-FLV on localhost for the API proxy; signalling over JT808.
  let media: MediaServer | null = null;
  let videoSub: Redis | null = null;
  const jt808 = servers.find((s) => s.protocol === 'jt808');
  if (env.mediaPort && jt808) {
    let control: VideoControl | null = null;
    const hub = new MediaHub({
      maxStreams: env.mediaMaxStreams,
      onStop: (stream, reason) => {
        media?.dropStream(stream);
        control?.stopDevice(stream, reason);
      },
    });
    control = new VideoControl(jt808, hub, { host: env.mediaPublicHost, port: env.mediaPort });
    media = new MediaServer(hub);
    await media.listen(env.mediaPort, env.mediaHttpPort);
    videoSub = new Redis(env.redisUrl);
    videoSub.on('error', (error) => logger.error(`Valkey (video) error: ${error.message}`));
    const vs = videoSub;
    untilCacheUp(logger, "video channel", () => control!.subscribe(vs, redis, gatewayId));
    logger.log(`JT/T 1078 media on tcp://0.0.0.0:${env.mediaPort} (devices → ${env.mediaPublicHost}), HTTP-FLV on http://127.0.0.1:${env.mediaHttpPort}, max ${env.mediaMaxStreams} streams`);
  }

  // Driver event snapshots (0x8801) and the Su-standard attachment server.
  let snapSub: Redis | null = null;
  let attachments: AttachmentServer | null = null;
  if (jt808) {
    snapSub = new Redis(env.redisUrl);
    snapSub.on('error', (error) => logger.error(`Valkey (snapshots) error: ${error.message}`));
    const snapshots = new SnapshotControl(jt808);
    const ss = snapSub;
    untilCacheUp(logger, "snapshot channel", () => snapshots.subscribe(ss, gatewayId));
    if (env.attachPort) {
      attachments = new AttachmentServer({
        zoneOf: (id) => (jt808.sessionOf(id) as Jt808Session | null)?.clockZone ?? null,
        onMedia: (m) => sink.accept([m]),
      });
      await attachments.listen(env.attachPort);
      logger.log(`Alarm attachments on tcp://0.0.0.0:${env.attachPort} (devices → ${env.mediaPublicHost})`);
    }
  }

  logger.log(`Gateway ${gatewayId} ready${capture ? ` (capturing ${captureIds})` : ''}`);

  const last = new Map(servers.map((s) => [s.protocol, s.stats.positions]));
  const timer = setInterval(() => {
    for (const server of servers) {
      const s = server.stats;
      const rate = ((s.positions - (last.get(server.protocol) ?? 0)) * 1000) / STATS_INTERVAL_MS;
      logger.log(
        `[${server.protocol}] connections=${s.connections} frames=${s.frames} positions=${s.positions} dropped=${s.dropped} errors=${s.errors} enqueueFailures=${s.enqueueFailures} rate=${rate.toFixed(1)}/s`,
      );
      last.set(server.protocol, s.positions);
    }
  }, STATS_INTERVAL_MS);

  const meters = new Map(servers.map((s) => [s.protocol, { frames: new RateMeter(), positions: new RateMeter() }]));
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
  const heartbeat = startHeartbeat(redis, 'gateway', (): GatewayMetrics => ({
    listeners: servers.map((server) => {
      const s = server.stats;
      const m = meters.get(server.protocol)!;
      return {
        protocol: server.protocol,
        port: server.configuredPort ?? 0,
        listening: server.listening,
        error: server.listening ? null : server.listenError,
        connections: s.connections,
        frames: s.frames,
        positions: s.positions,
        framesPerSec: m.frames.rate(s.frames),
        positionsPerSec: m.positions.rate(s.positions),
        dropped: s.dropped,
        errors: s.errors,
        enqueueFailures: s.enqueueFailures,
        lastPacketAt: iso(s.lastPacketAt),
        lastPositionAt: iso(s.lastPositionAt),
      };
    }),
    relay: relay.snapshot(),
    spool: publisher.metrics(),
  }));

  // Local health for the watchdog (works while the cache, and so the heartbeat, is down).
  let lastNotAcked = 0;
  let lastNotAckedAt: number | null = null;
  const readHealth = () => {
    const spoolMetrics = publisher.metrics();
    if (spoolMetrics.notAcked > lastNotAcked) {
      lastNotAcked = spoolMetrics.notAcked;
      lastNotAckedAt = Date.now();
    }
    return gatewayHealth({
      listeners: servers.map((s) => ({ protocol: s.protocol, port: s.configuredPort ?? 0, listening: s.listening, connections: s.stats.connections })),
      spool: spoolMetrics,
      lastNotAckedAt,
      now: Date.now(),
    });
  };
  const healthPort = Number(process.env.GATEWAY_HEALTH_PORT ?? 4121);
  let healthServer: HttpServer | null = null;
  if (healthPort > 0) {
    healthServer = await startGatewayHealthServer(healthPort, readHealth).catch((error: Error) => {
      logger.error(`Gateway health endpoint could not listen on 127.0.0.1:${healthPort}: ${error.message}`);
      return null;
    });
    if (healthServer) logger.log(`Gateway health on http://127.0.0.1:${healthPort}/health`);
  }
  const spoolLog = setInterval(() => {
    const m = publisher.metrics();
    if (m.mode !== 'direct' && m.mode !== 'disabled') {
      logger.warn(`[spool] mode=${m.mode} pending=${m.pendingEntries} spooled=${m.spooled} replayed=${m.replayed} rejected=${m.rejected} notAcked=${m.notAcked}`);
    }
  }, STATS_INTERVAL_MS);
  spoolLog.unref();

  const shutdown = async () => {
    clearInterval(timer);
    await media?.close();
    await attachments?.close();
    await snapSub?.quit().catch(() => undefined);
    await videoSub?.quit().catch(() => undefined);
    retries.forEach(clearTimeout);
    await heartbeat.stop();
    stopRelaySync();
    relay.closeAll();
    await relaySub.quit().catch(() => undefined);
    await Promise.all(servers.map((s) => s.close()));
    clearInterval(spoolLog);
    healthServer?.close();
    // Flushes appends still waiting for their group commit; anything unreplayed stays on disk for the next start.
    publisher.close();
    await commands.quit().catch(() => undefined);
    await positionsConn.quit().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

/**
 * Runs a cache-dependent setup step without blocking startup: on failure (cache down at start) it is retried every
 * 5 s. ioredis re-subscribes channels by itself after later reconnects.
 */
function untilCacheUp(logger: Logger, label: string, step: () => Promise<unknown>): void {
  let failures = 0;
  const attempt = () => {
    step().then(
      () => {
        if (failures) logger.log(`${label}: ready after ${failures} failed attempt(s)`);
      },
      (error: Error) => {
        if (failures++ === 0) logger.warn(`${label}: cache not available (${error.message}); retrying every 5 s`);
        setTimeout(attempt, 5000).unref();
      },
    );
  };
  attempt();
}

void main();
