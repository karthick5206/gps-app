import { API_SCOPES, WEBHOOK_EVENTS } from '@veetracer/shared';
import { V1_REPORT_MAX_DAYS, V1_REPORT_TYPES, reportSlug } from './public-api.controller';
import { LIST_MAX_DAYS, LIST_PAGE_MAX, POSITIONS_MAX_DAYS, POSITIONS_PAGE_MAX } from './v1-query';

/** Hand-written OpenAPI 3.0 description of the public API v1 (served at GET /api/v1/openapi.json). */
type Json = Record<string, unknown>;

const str = (description?: string, extra: Json = {}): Json => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const num = (description?: string): Json => ({ type: 'number', ...(description ? { description } : {}) });
const int = (description?: string): Json => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description?: string): Json => ({ type: 'boolean', ...(description ? { description } : {}) });
const time = (description?: string): Json => str(description, { format: 'date-time' });
const nullable = (s: Json): Json => ({ ...s, nullable: true });
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Json>): Json => ({ type: 'object', properties });

const pageMeta = obj({ count: int('Rows in this page'), nextCursor: nullable(str('Pass as ?cursor= for the next page; null on the last page')) });
const list = (item: string): Json => obj({ data: { type: 'array', items: ref(item) }, meta: pageMeta });

const SCHEMAS: Record<string, Json> = {
  Error: obj({ error: obj({ status: int('HTTP status'), code: str('invalid_request | unauthorized | forbidden | not_found | rate_limited | internal_error'), message: str() }) }),
  Vehicle: obj({
    id: str('Vehicle id (UUID)'),
    name: str(),
    plateNumber: nullable(str()),
    type: str('VEHICLE | PERSON | ASSET | PET'),
    vehicleType: nullable(str('CAR | BIKE | TRUCK | BUS | SCHOOL_BUS | VAN | AUTO | OTHER')),
    make: nullable(str()),
    model: nullable(str()),
    color: nullable(str()),
    isActive: bool(),
    branch: nullable(obj({ id: str(), name: str() })),
    device: nullable(obj({ imei: str('Tracker IMEI / unique id'), simNumber: nullable(str()), model: str(), protocol: str() })),
    createdAt: time(),
  }),
  LiveVehicle: obj({
    vehicleId: str(),
    name: str(),
    plateNumber: nullable(str()),
    status: str('RUNNING | IDLE | OFF | OVERSPEED | OFFLINE | NO_DATA'),
    state: str('moving | idle | stopped | offline | no_data'),
    statusSince: nullable(time()),
    lat: nullable(num()),
    lng: nullable(num()),
    speedKph: num(),
    course: int('Heading in degrees'),
    ignition: nullable(bool()),
    satellites: nullable(int()),
    address: nullable(str('Cached address of the position, when already looked up')),
    odometerKm: nullable(num()),
    fuelL: nullable(num('Fuel in the tank (litres), with a configured fuel sensor')),
    fuelPct: nullable(num()),
    batteryLevel: nullable(num()),
    extVoltage: nullable(num()),
    driverName: nullable(str()),
    fixTime: nullable(time('GPS time of the position')),
    serverTime: nullable(time('When VeeTrax received it')),
  }),
  Position: obj({
    time: time('GPS fix time'),
    serverTime: time(),
    lat: num(),
    lng: num(),
    speedKph: num(),
    course: int(),
    altitude: nullable(num()),
    satellites: nullable(int()),
    valid: bool('False when the tracker had no GPS fix'),
    ignition: nullable(bool()),
    odometerKm: nullable(num('Device odometer, if the tracker reports one')),
    fuelL: nullable(num()),
    fuelPct: nullable(num()),
    batteryLevel: nullable(num()),
    extVoltage: nullable(num()),
  }),
  Trip: obj({
    id: str(),
    vehicleId: str(),
    vehicleName: nullable(str()),
    plateNumber: nullable(str()),
    startTime: time(),
    endTime: time(),
    start: obj({ lat: num(), lng: num(), address: nullable(str()) }),
    end: obj({ lat: num(), lng: num(), address: nullable(str()) }),
    distanceKm: num(),
    durationSec: int(),
    idleSec: int(),
    maxSpeedKph: num(),
    avgSpeedKph: num(),
  }),
  Stop: obj({
    id: str(),
    vehicleId: str(),
    vehicleName: nullable(str()),
    plateNumber: nullable(str()),
    startTime: time(),
    endTime: time(),
    lat: num(),
    lng: num(),
    address: nullable(str()),
    durationSec: int(),
    ignitionOn: bool(),
  }),
  Alert: obj({
    id: str(),
    vehicleId: str(),
    vehicleName: nullable(str()),
    plateNumber: nullable(str()),
    type: str('Alert type code, e.g. OVERSPEED, SOS, GEOFENCE_ENTER, FUEL_DRAIN'),
    severity: str('INFO | WARNING | CRITICAL'),
    message: str(),
    occurredAt: time(),
    lat: nullable(num()),
    lng: nullable(num()),
    address: nullable(str()),
    geofenceId: nullable(str()),
    status: str('NEW | ACKNOWLEDGED | RESOLVED'),
    acknowledgedAt: nullable(time()),
    details: { type: 'object', additionalProperties: true },
  }),
  Command: obj({
    id: str(),
    vehicleId: str(),
    imei: str(),
    type: str('engine_stop | engine_resume | locate | status | reboot'),
    status: str('QUEUED | SENT | ACKED | FAILED | EXPIRED'),
    response: nullable(str()),
    error: nullable(str()),
    createdAt: time(),
    sentAt: nullable(time()),
    acknowledgedAt: nullable(time()),
    expiresAt: time(),
  }),
  WebhookEndpoint: obj({
    id: str(),
    name: str(),
    url: str(),
    events: { type: 'array', items: str() },
    isActive: bool(),
    secretPrefix: str(),
    secret: str('Only in the response that created the endpoint'),
    consecutiveFailures: int(),
    disabledAt: nullable(time()),
    disabledReason: nullable(str()),
    lastDeliveryAt: nullable(time()),
    lastStatusCode: nullable(int()),
    createdAt: time(),
    updatedAt: time(),
  }),
  WebhookEvent: obj({
    id: str('Event id; the same event is never sent twice to an endpoint (use it to de-duplicate retries)'),
    type: str(WEBHOOK_EVENTS.join(' | ')),
    createdAt: time(),
    companyId: str(),
    test: bool('Present and true for "Send test event"'),
    data: { type: 'object', additionalProperties: true },
  }),
};

const q = (name: string, description: string, schema: Json = str(), required = false): Json => ({ name, in: 'query', required, description, schema });
const vehiclePath: Json = { name: 'id', in: 'path', required: true, description: 'Vehicle id', schema: str(undefined, { format: 'uuid' }) };
const cursor = q('cursor', 'Opaque cursor from meta.nextCursor of the previous page');
const limit = (max: number, def: number) => q('limit', `Rows per page (default ${def}, max ${max})`, { type: 'integer', minimum: 1, maximum: max });
const range = (maxDays: number) => [
  q('from', `Start (ISO 8601, UTC recommended). Range at most ${maxDays} days`, time(), true),
  q('to', 'End (ISO 8601)', time(), true),
];
const errors = (...codes: number[]): Json =>
  Object.fromEntries(codes.map((c) => [String(c), { description: ERROR_TEXT[c] ?? 'Error', content: { 'application/json': { schema: ref('Error') } } }]));
const ERROR_TEXT: Record<number, string> = {
  400: 'Invalid request',
  401: 'Missing, invalid, revoked or expired API key',
  403: 'The key lacks the scope or the IP is not allowed',
  404: 'Not found (or outside the key\'s data scope)',
  429: 'Rate limit exceeded (see Retry-After)',
};
const ok = (schema: Json, description = 'OK'): Json => ({ description, content: { 'application/json': { schema } } });
const op = (summary: string, scope: string, parameters: Json[], response: Json, extra: Json = {}): Json => ({
  summary,
  description: `Scope: \`${scope}\`.`,
  security: [{ apiKey: [] }],
  parameters,
  responses: { '200': response, ...errors(400, 401, 403, 404, 429) },
  ...extra,
});

export function buildOpenApi(serverUrl = '/api'): Json {
  return {
    openapi: '3.0.3',
    info: {
      title: 'VeeTrax Customer API',
      version: '1.0.0',
      description:
        'Read vehicles, live positions, history, trips, alerts and reports, and send device commands from your own systems. ' +
        'Authenticate with `Authorization: Bearer vtx_live_…` (create keys under Administration → Developer API). ' +
        'All times are ISO 8601 in UTC. Lists are paginated with `cursor` / `limit`; responses are `{ data, meta }`, errors `{ error: { status, code, message } }`. ' +
        `Scopes: ${API_SCOPES.join(', ')}. Each key has a per-minute and per-day request limit (X-RateLimit-* headers; 429 with Retry-After when exceeded).`,
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'vtx_live_…' } },
      schemas: SCHEMAS,
    },
    paths: {
      '/v1/vehicles': { get: op('List vehicles', 'read:vehicles', [cursor, limit(LIST_PAGE_MAX, 100)], ok(list('Vehicle'))) },
      '/v1/vehicles/live': {
        get: op('Latest position and status of every vehicle', 'read:positions', [q('vehicleIds', 'Comma-separated vehicle ids (default: all)')], ok(list('LiveVehicle'))),
      },
      '/v1/vehicles/{id}/positions': {
        get: op('Position history of one vehicle (oldest first)', 'read:positions', [vehiclePath, ...range(POSITIONS_MAX_DAYS), cursor, limit(POSITIONS_PAGE_MAX, 1000)], ok(list('Position'))),
      },
      '/v1/trips': {
        get: op('Trips that started in the range', 'read:trips', [...range(LIST_MAX_DAYS), q('vehicleId', 'Only this vehicle', str(undefined, { format: 'uuid' })), cursor, limit(LIST_PAGE_MAX, 100)], ok(list('Trip'))),
      },
      '/v1/stops': {
        get: op('Stops that started in the range', 'read:trips', [...range(LIST_MAX_DAYS), q('vehicleId', 'Only this vehicle', str(undefined, { format: 'uuid' })), cursor, limit(LIST_PAGE_MAX, 100)], ok(list('Stop'))),
      },
      '/v1/alerts': {
        get: op(
          'Alerts in the range (oldest first)',
          'read:alerts',
          [...range(LIST_MAX_DAYS), q('vehicleId', 'Only this vehicle', str(undefined, { format: 'uuid' })), q('type', 'Comma-separated alert types, e.g. OVERSPEED,SOS'), cursor, limit(LIST_PAGE_MAX, 100)],
          ok(list('Alert')),
        ),
      },
      '/v1/reports/{type}': {
        get: op(
          'Report data as JSON',
          'read:reports',
          [
            { name: 'type', in: 'path', required: true, schema: str(undefined, { enum: V1_REPORT_TYPES.map(reportSlug) }) },
            q('from', `First day (YYYY-MM-DD, company time zone). At most ${V1_REPORT_MAX_DAYS} days`, str(undefined, { format: 'date' }), true),
            q('to', 'Last day (YYYY-MM-DD, inclusive)', str(undefined, { format: 'date' }), true),
            q('vehicleIds', 'Comma-separated vehicle ids (default: all)'),
            q('period', 'summary / distance / engine-hours: DAY | WEEK | MONTH'),
          ],
          ok(obj({ data: { type: 'array', items: { type: 'object', additionalProperties: true } }, meta: obj({ report: str(), from: str(), to: str(), timezone: str(), totals: { type: 'object' }, count: int(), totalRows: int(), truncated: bool() }) })),
        ),
      },
      '/v1/webhooks': {
        get: op('List webhook endpoints', 'webhooks', [], ok(list('WebhookEndpoint'))),
        post: {
          ...op('Add a webhook endpoint (the response holds the signing secret)', 'webhooks', [], ok(obj({ data: ref('WebhookEndpoint') }))),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['name', 'url', 'events'], properties: { name: str(), url: str('https:// URL on the public internet'), events: { type: 'array', items: str(undefined, { enum: [...WEBHOOK_EVENTS] }) } } },
              },
            },
          },
        },
      },
      '/v1/webhooks/{id}': {
        delete: {
          ...op('Delete a webhook endpoint', 'webhooks', [{ name: 'id', in: 'path', required: true, schema: str(undefined, { format: 'uuid' }) }], { description: 'Deleted' }),
          responses: { '204': { description: 'Deleted' }, ...errors(401, 403, 404, 429) },
        },
      },
      '/v1/vehicles/{id}/commands': {
        get: op('Recent commands of a vehicle', 'write:commands', [vehiclePath], ok(list('Command'))),
        post: {
          ...op('Send a command to the tracker', 'write:commands', [vehiclePath], ok(obj({ data: ref('Command') }), 'Accepted (queued or sent)')),
          description: 'Scope: `write:commands`. engine_stop / engine_resume also need `write:commands:critical` and are refused while the vehicle moves. Returns 202.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['type'], properties: { type: str('engine_stop | engine_resume | locate | status | reboot') } } } },
          },
          responses: { '202': ok(obj({ data: ref('Command') }), 'Accepted (queued or sent)'), ...errors(400, 401, 403, 404, 429) },
        },
      },
    },
  };
}
