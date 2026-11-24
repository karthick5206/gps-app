import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { json } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { displayHost, resolveApiHost } from './config/api-host';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  // API_HOST (config/api-host.ts): loopback by default in production (behind Caddy / cloudflared); development keeps
  // every interface. Resolved before anything starts, so a bad value fails fast.
  const binding = resolveApiHost(process.env.API_HOST);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // The web dev server proxies to us; trust loopback so req.ip is the browser's address.
  app.set('trust proxy', 'loopback');
  // Gzip JSON/CSV: the live snapshot is ~600 B per object (~6 MB at 10k objects) before compression.
  app.use(compression());
  // Jimi dashcams post their whole SD-card name list (can pass 1 MB) as JSON, sometimes without a JSON content type.
  // Registered before Nest's own parser (100 kB), which then skips the already-parsed body.
  app.use('/api/dvr/jimi/filelist', json({ limit: '4mb', type: () => true }));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  if (binding.host === undefined) await app.listen(env.apiPort);
  else await app.listen(env.apiPort, binding.host);
  if (process.env.NODE_ENV === 'production' && (binding.exposure === 'all-interfaces' || binding.exposure === 'specific')) {
    Logger.warn(`API_HOST=${displayHost(binding)}: the API accepts connections beyond this host (${binding.exposure}); keep it behind a firewall or proxy`, 'Bootstrap');
  }
  Logger.log(`API listening on http://${displayHost(binding)}:${env.apiPort}/api (${binding.exposure}; Socket.IO namespace /live)`, 'Bootstrap');
}

void bootstrap();
