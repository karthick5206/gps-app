import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CommandDispatch, COMMAND_TTL_HOURS } from '@veetracer/shared';
import { APP_ROOT, loadEnv } from '../config/env';
import { RedisKeys } from '../redis/keys';
import { Ais140Decoder } from './ais140/decoder';
import { Gt06Decoder } from './gt06/decoder';
import { MediaHub } from './jt1078/hub';
import { MediaServer } from './jt1078/media-server';
import { VideoControl } from './jt1078/video-control';
import { Jt808Decoder } from './jt808/decoder';
import { BaseSession, ProtocolDecoder } from './protocol';
import { TcpGatewayServer } from './tcp-server';
import { TeltonikaDecoder } from './teltonika/decoder';
import { UnparsedLog } from './unparsed-log';

const STATS_INTERVAL_MS = 30_000;

/**
 * Device gateway: one TCP listener per protocol, all feeding the same `vt:positions` stream.
 *   GT06_PORT (5023)       Concox / Jimi GT06 family (GT06N, GT800, V5, VL149, …)
 *   TELTONIKA_PORT (5027)  Teltonika FMB/FMC/FMM (0 disables)
 *   JT808_PORT (6808)      JT/T 808-2013/2019 dashcams and MDVRs (Mettax MC202, Jimi JC4xx) (0 disables)
 *   AIS140_PORT (5030)     AIS-140 VLT devices (iTriangle TS101) (0 disables)
 *   MEDIA_PORT (7612)      JT/T 1078 dashcam video streams (0 disables); MEDIA_HTTP_PORT (4110, localhost) HTTP-FLV
 * GATEWAY_CAPTURE =comma-separated IMEIs (or `all`) to write raw frames to var/logs/capture-<protocol>.log.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Gateway');
  const gatewayId = process.env.GATEWAY_ID ?? `gw-${hostname()}-${process.pid}`;
  const redis = new Redis(env.redisUrl);
  redis.on('error', (error) => logger.error(`Valkey error: ${error.message}`));

  const logDir = join(APP_ROOT, 'var', 'logs');
  const unparsed = new UnparsedLog({ dir: logDir });
  const captureIds = (process.env.GATEWAY_CAPTURE ?? '').trim();
  const capture = captureIds
    ? { dir: logDir, ids: captureIds === 'all' ? ('all' as const) : new Set(captureIds.split(',').map((s) => s.trim()).filter(Boolean)) }
    : null;

  const listeners: [ProtocolDecoder<BaseSession>, number][] = [
    [new Gt06Decoder() as ProtocolDecoder<BaseSession>, env.gt06Port],
    [new TeltonikaDecoder(), env.teltonikaPort],
    [new Jt808Decoder() as ProtocolDecoder<BaseSession>, env.jt808Port],
    [new Ais140Decoder() as ProtocolDecoder<BaseSession>, env.ais140Port],
  ];
  const servers: TcpGatewayServer<BaseSession>[] = [];
  for (const [decoder, port] of listeners) {
    if (!port) continue;
    const server = new TcpGatewayServer(decoder, { redis, gatewayId, unparsed, capture });
    await server.listen(port);
    servers.push(server);
    logger.log(`${decoder.name} listening on tcp://0.0.0.0:${port}`);
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
    if (servers.some((s) => s.sendCommand(d))) return;
    // The device disconnected meanwhile: queue it for its next login.
    const key = RedisKeys.commandQueue(d.uniqueId);
    redis
      .multi()
      .rpush(key, message)
      .expire(key, COMMAND_TTL_HOURS * 3600)
      .exec()
      .catch((error: Error) => logger.error(`Command re-queue failed: ${error.message}`));
  });
  await commands.subscribe(RedisKeys.commandChannel(gatewayId));

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
    await control.subscribe(videoSub, redis, gatewayId);
    logger.log(`JT/T 1078 media on tcp://0.0.0.0:${env.mediaPort} (devices → ${env.mediaPublicHost}), HTTP-FLV on http://127.0.0.1:${env.mediaHttpPort}, max ${env.mediaMaxStreams} streams`);
  }

  logger.log(`Gateway ${gatewayId} ready${capture ? ` (capturing ${captureIds})` : ''}`);

  const last = new Map(servers.map((s) => [s.protocol, s.stats.positions]));
  const timer = setInterval(() => {
    for (const server of servers) {
      const s = server.stats;
      const rate = ((s.positions - (last.get(server.protocol) ?? 0)) * 1000) / STATS_INTERVAL_MS;
      logger.log(
        `[${server.protocol}] connections=${s.connections} frames=${s.frames} positions=${s.positions} dropped=${s.dropped} errors=${s.errors} rate=${rate.toFixed(1)}/s`,
      );
      last.set(server.protocol, s.positions);
    }
  }, STATS_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await media?.close();
    await videoSub?.quit().catch(() => undefined);
    await Promise.all(servers.map((s) => s.close()));
    await commands.quit().catch(() => undefined);
    await redis.quit();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main();
