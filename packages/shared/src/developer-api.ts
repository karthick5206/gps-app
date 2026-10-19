/** Customer API (API keys, public REST API v1) and outgoing webhooks: catalogues and admin DTOs. */

export const API_SCOPES = [
  'read:vehicles',
  'read:positions',
  'read:trips',
  'read:alerts',
  'read:reports',
  'write:commands',
  'write:commands:critical',
  'webhooks',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiScopeDef {
  scope: ApiScope;
  label: string;
  description: string;
  /** Not ticked by default in the create dialog. */
  sensitive?: boolean;
}

export const API_SCOPE_DEFS: readonly ApiScopeDef[] = [
  { scope: 'read:vehicles', label: 'Vehicles', description: 'List vehicles, plates, trackers and branches.' },
  { scope: 'read:positions', label: 'Positions', description: 'Live positions and position history.' },
  { scope: 'read:trips', label: 'Trips and stops', description: 'Trips and stops worked out from the positions.' },
  { scope: 'read:alerts', label: 'Alerts', description: 'Alerts raised for the vehicles.' },
  { scope: 'read:reports', label: 'Reports', description: 'Report data as JSON (summary, distance, engine hours…).' },
  { scope: 'write:commands', label: 'Device commands', description: 'Send locate, status and restart commands to trackers.', sensitive: true },
  {
    scope: 'write:commands:critical',
    label: 'Engine stop and restore',
    description: 'Also allow engine stop / restore. Refused while the vehicle moves.',
    sensitive: true,
  },
  { scope: 'webhooks', label: 'Webhooks', description: 'Manage webhook endpoints from your own system.', sensitive: true },
];

/** Commands an API key may only send with the `write:commands:critical` scope. */
export const API_CRITICAL_COMMANDS = ['engine_stop', 'engine_resume'] as const;

/** Default and maximum request limits per key. */
export const API_KEY_DEFAULT_PER_MINUTE = 60;
export const API_KEY_DEFAULT_PER_DAY = 10_000;
export const API_KEY_MAX_PER_MINUTE = 600;
export const API_KEY_MAX_PER_DAY = 200_000;

export interface ApiKeyDto {
  id: string;
  name: string;
  /** First characters of the key, e.g. `vtx_live_AbC12…`, to tell keys apart. */
  prefix: string;
  scopes: ApiScope[];
  branchId: string | null;
  branchName: string | null;
  ipAllowList: string[];
  ratePerMinute: number;
  ratePerDay: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  requestCount: number;
  revokedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiScope[];
  branchId?: string | null;
  ipAllowList?: string[];
  expiresAt?: string | null;
  ratePerMinute?: number;
  ratePerDay?: number;
}

/** Returned once at creation: the only time the full key is visible. */
export interface CreatedApiKey {
  key: ApiKeyDto;
  secret: string;
}

// ───────────── Webhooks ─────────────

export const WEBHOOK_EVENTS = [
  'alert.created',
  'trip.completed',
  'vehicle.status_changed',
  'geofence.enter',
  'geofence.exit',
  'fuel.event',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_DEFS: readonly { event: WebhookEvent; label: string; description: string }[] = [
  { event: 'alert.created', label: 'Alert created', description: 'Every alert (overspeed, SOS, power cut, geofence, fuel…).' },
  { event: 'trip.completed', label: 'Trip completed', description: 'A trip ended (sent within about a minute).' },
  { event: 'vehicle.status_changed', label: 'Vehicle status changed', description: 'Moving, idle, stopped or offline.' },
  { event: 'geofence.enter', label: 'Geofence entry', description: 'A vehicle entered a geofence (needs the geofence alert).' },
  { event: 'geofence.exit', label: 'Geofence exit', description: 'A vehicle left a geofence (needs the geofence alert).' },
  { event: 'fuel.event', label: 'Fuel refill or drain', description: 'Refill or possible theft detected by the fuel sensor.' },
];

/** Signature header of every webhook request: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-VeeTrax-Signature';
/** Waits before each retry after a failed attempt; after the last one the delivery is marked failed. */
export const WEBHOOK_RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21600] as const;
/** An endpoint is switched off after this many failed attempts in a row. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 50;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_LOG_RETENTION_DAYS = 30;

export type WebhookDeliveryStatus = 'PENDING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED';

export interface WebhookEndpointDto {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  isActive: boolean;
  /** `whsec_ab12…`: start of the signing secret. */
  secretPrefix: string;
  consecutiveFailures: number;
  disabledAt: string | null;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  lastStatusCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointRequest {
  name: string;
  url: string;
  events: WebhookEvent[];
  isActive?: boolean;
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  eventId: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempt: number;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  responseBody: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  isTest: boolean;
  isRedelivery: boolean;
  createdAt: string;
  updatedAt: string;
}
