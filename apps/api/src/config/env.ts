import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Typed process configuration shared by the api, gateway, processor and tooling. */
export interface AppEnv {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  apiPort: number;
  gt06Port: number;
  webUrl: string;
  otpDevEcho: boolean;
  mailDevEcho: boolean;
  corsOrigins: string[];
}

/** apps/api directory (works from both src/ and dist/). */
export const APP_ROOT = join(__dirname, '..', '..');

let cached: AppEnv | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const envFile = join(APP_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  cached = {
    databaseUrl: required('DATABASE_URL'),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    jwtSecret,
    apiPort: Number(process.env.API_PORT ?? 4000),
    gt06Port: Number(process.env.GT06_PORT ?? 5023),
    webUrl: process.env.WEB_URL ?? 'http://localhost:5173',
    otpDevEcho: process.env.OTP_DEV_ECHO === 'true',
    mailDevEcho: process.env.MAIL_DEV_ECHO === 'true',
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
  if (process.env.NODE_ENV === 'production') assertProductionSafe(cached);
  return cached;
}

/** Dev conveniences that expose login codes or reset links must never reach a public server. */
function assertProductionSafe(env: AppEnv): void {
  if (env.otpDevEcho || env.mailDevEcho) {
    throw new Error('OTP_DEV_ECHO and MAIL_DEV_ECHO must be false when NODE_ENV=production');
  }
  if (env.jwtSecret.startsWith('change-me')) {
    throw new Error('JWT_SECRET still has the .env.example value; set a long random secret');
  }
}
