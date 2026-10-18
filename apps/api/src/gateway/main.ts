import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { loadEnv } from '../config/env';
import { Gt06Server } from './gt06-server';

const STATS_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Gateway');
  const gatewayId = process.env.GATEWAY_ID ?? `gw-${hostname()}-${process.pid}`;
  const redis = new Redis(env.redisUrl);
  redis.on('error', (error) => logger.error(`Valkey error: ${error.message}`));

  const server = new Gt06Server(redis, gatewayId);
  await server.listen(env.gt06Port);
  logger.log(`GT06 gateway ${gatewayId} listening on tcp://0.0.0.0:${env.gt06Port}`);

  let last = { ...server.stats };
  const timer = setInterval(() => {
    const s = server.stats;
    const rate = ((s.positions - last.positions) * 1000) / STATS_INTERVAL_MS;
    logger.log(
      `connections=${s.connections} frames=${s.frames} positions=${s.positions} dropped=${s.dropped} rate=${rate.toFixed(1)}/s`,
    );
    last = { ...s };
  }, STATS_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await server.close();
    await redis.quit();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main();
