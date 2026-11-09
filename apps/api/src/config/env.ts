import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Typed process configuration shared by the api, gateway, processor and tooling. */
export interface AppEnv {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  apiPort: number;
  gt06Port: number;
  /** Teltonika TCP port; 0 disables the listener. */
  teltonikaPort: number;
  /** JT/T 808 (dashcams / MDVRs) TCP port; 0 disables the listener. */
  jt808Port: number;
  /** AIS-140 (iTriangle TS101 and other VLT units) TCP port; 0 disables the listener. */
  ais140Port: number;
  /** JT/T 1078 media: TCP port dashcams stream to (0 disables video), host they are told to connect to. */
  mediaPort: number;
  mediaPublicHost: string;
  /** Gateway's localhost-only HTTP-FLV server; the API proxies viewers to it. */
  mediaHttpPort: number;
  mediaMaxStreams: number;
  /** Su-standard alarm attachment server: TCP port dashcams upload ADAS/DMS photos/clips to (0 disables). */
  attachPort: number;
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
    teltonikaPort: Number(process.env.TELTONIKA_PORT ?? 5027),
    jt808Port: Number(process.env.JT808_PORT ?? 6808),
    ais140Port: Number(process.env.AIS140_PORT ?? 5030),
    mediaPort: Number(process.env.MEDIA_PORT ?? 7612),
    mediaPublicHost: process.env.MEDIA_PUBLIC_HOST ?? 'track.mintplus.co.in',
    mediaHttpPort: Number(process.env.MEDIA_HTTP_PORT ?? 4110),
    mediaMaxStreams: Number(process.env.MEDIA_MAX_STREAMS ?? 8),
    attachPort: Number(process.env.ATTACH_PORT ?? 7613),
    webUrl: process.env.WEB_URL ?? 'http://localhost:5173',
    otpDevEcho: process.env.OTP_DEV_ECHO === 'true',
    mailDevEcho: process.env.MAIL_DEV_ECHO === 'true',
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
  if (process.env.NODE_ENV === 'production') {
    assertProductionSafe(cached);
    for (const w of productionWarnings(process.env)) console.warn(`[env] WARNING: ${w}`);
  }
  return cached;
}

/** Production misconfigurations that do not stop the server but mean messages are not delivered. */
export function productionWarnings(raw: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (!raw.SMS_PROVIDER || raw.SMS_PROVIDER === 'console') out.push('No SMS provider configured (SMS_PROVIDER): OTP and alert SMS are NOT delivered');
  if (!raw.SMTP_URL && !raw.ZOHO_MAIL_KEY) out.push('No mail provider configured (SMTP_URL / ZOHO_MAIL_KEY): password-reset and alert e-mails are NOT delivered');
  if (raw.MAIL_KEEP_COPIES === 'true') out.push('MAIL_KEEP_COPIES=true: full e-mail copies (reset links, invoices) are stored in var/mail');
  if (raw.WEBHOOK_ALLOW_PRIVATE === 'true') out.push('WEBHOOK_ALLOW_PRIVATE=true: webhooks may target private networks');
  if (raw.RELAY_ALLOW_PRIVATE === 'true') out.push('RELAY_ALLOW_PRIVATE=true: data forwarding may target private networks');
  return out;
}

/** Dev conveniences that expose login codes or reset links must never reach a public server. */
export function assertProductionSafe(env: Pick<AppEnv, 'otpDevEcho' | 'mailDevEcho' | 'jwtSecret'>): void {
  if (env.otpDevEcho || env.mailDevEcho) {
    throw new Error('OTP_DEV_ECHO and MAIL_DEV_ECHO must be false when NODE_ENV=production');
  }
  if (env.jwtSecret.startsWith('change-me')) {
    throw new Error('JWT_SECRET still has the .env.example value; set a long random secret');
  }
}
