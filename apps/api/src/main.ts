import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // The web dev server proxies to us; trust loopback so req.ip is the browser's address.
  app.set('trust proxy', 'loopback');
  // Gzip JSON/CSV: the live snapshot is ~600 B per object (~6 MB at 10k objects) before compression.
  app.use(compression());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(env.apiPort);
  Logger.log(`API listening on http://localhost:${env.apiPort}/api (Socket.IO namespace /live)`, 'Bootstrap');
}

void bootstrap();
