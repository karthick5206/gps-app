import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT, loadEnv } from '../config/env';
import { Gt06Decoder } from './gt06/decoder';
import { BaseSession, ProtocolDecoder } from './protocol';
import { TcpGatewayServer } from './tcp-server';
import { TeltonikaDecoder } from './teltonika/decoder';
import { UnparsedLog } from './unparsed-log';

const STATS_INTERVAL_MS = 30_000;

/**
 * Device gateway: one TCP listener per protocol, all feeding the same `vt:positions` stream.
 *   GT06_PORT (5023)       Concox / Jimi GT06 family (GT06N, GT800, V5, VL149, …)
 *   TELTONIKA_PORT (5027)  Teltonika FMB/FMC/FMM (0 disables)
 * GATEWAY_CAPTURE = comma-separated IMEIs (or `all`) to write raw frames to var/logs/capture-<protocol>.log.
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
  ];
  const servers: TcpGatewayServer<BaseSession>[] = [];
  for (const [decoder, port] of listeners) {
    if (!port) continue;
    const server = new TcpGatewayServer(decoder, { redis, gatewayId, unparsed, capture });
    await server.listen(port);
    servers.push(server);
    logger.log(`${decoder.name} listening on tcp://0.0.0.0:${port}`);
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
    await Promise.all(servers.map((s) => s.close()));
    await redis.quit();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main();
