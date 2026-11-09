/** Device commands: catalogue per protocol family, request/response DTOs. */

export const COMMAND_TYPES = ['engine_stop', 'engine_resume', 'locate', 'status', 'reboot', 'custom'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];
export type CommandStatusValue = 'QUEUED' | 'SENT' | 'ACKED' | 'FAILED' | 'EXPIRED';

export interface CommandDef {
  type: CommandType;
  label: string;
  description: string;
  /** Asks for the user's password and is refused while the vehicle moves faster than ENGINE_STOP_MAX_SPEED_KPH. */
  critical: boolean;
  /** Device capability needed (from the device model), if any. */
  capability: string | null;
}

export const COMMAND_DEFS: readonly CommandDef[] = [
  { type: 'engine_stop', label: 'Stop engine', description: 'Cuts fuel/ignition through the immobiliser relay.', critical: true, capability: 'engine_cut' },
  { type: 'engine_resume', label: 'Restore engine', description: 'Releases the immobiliser relay.', critical: false, capability: 'engine_cut' },
  { type: 'locate', label: 'Request location', description: 'Asks the device to report its position now.', critical: false, capability: null },
  { type: 'status', label: 'Device status', description: 'Asks the device for its status (GPS, GSM, power, relay).', critical: false, capability: null },
  { type: 'reboot', label: 'Restart device', description: 'Restarts the tracker; it reconnects within a minute or two.', critical: false, capability: null },
  { type: 'custom', label: 'Custom command', description: 'Sends a raw protocol command (support staff).', critical: false, capability: null },
];
export const COMMAND_DEF_MAP = Object.fromEntries(COMMAND_DEFS.map((d) => [d.type, d])) as Record<CommandType, CommandDef>;

/** Text sent for each command, per protocol family (DeviceModel.protocol). Missing = not supported. */
export const PROTOCOL_COMMANDS: Record<string, Partial<Record<Exclude<CommandType, 'custom'>, string>>> = {
  GT06: { engine_stop: 'RELAY,1#', engine_resume: 'RELAY,0#', locate: 'WHERE#', status: 'STATUS#', reboot: 'RESET#' },
  TELTONIKA: { engine_stop: 'setdigout 1', engine_resume: 'setdigout 0', locate: 'getgps', status: 'getstatus', reboot: 'cpureset' },
  // '#<msgId>[:arg]' is sent as that binary message (see gateway/jt808/decoder.ts); other text goes out as 0x8300 TTS.
  JT808: { locate: '#8201', reboot: '#8105:4' },
  // AIS-140 OTA command syntax differs per vendor and isn't confirmed for the iTriangle TS101 yet: only the custom
  // (raw text line) command is offered until a vendor document / device test confirms SET/GET commands.
  AIS140: {},
};

/** Engine cut-off is refused above this speed (km/h), as most operators require for safety. */
export const ENGINE_STOP_MAX_SPEED_KPH = 20;
/** A queued command not delivered within this time is expired. */
export const COMMAND_TTL_HOURS = 24;

/**
 * Safety-critical commands (engine stop) are never queued for an offline vehicle and never delivered late
 * (decision Q-01, docs/modernization/decision-log.md): they need a fresh authorised request, fresh telemetry and the
 * speed check at the moment they are sent.
 */
/** The vehicle's last position must be at most this old (seconds) for an engine stop to be accepted. */
export const ENGINE_STOP_MAX_FIX_AGE_SEC = 60;
/** A safety-critical dispatch older than this (seconds) when it reaches the gateway is dropped, not sent. */
export const CRITICAL_DISPATCH_MAX_AGE_SEC = 60;

/** Engine-stop protocol texts, to recognise safety-critical entries queued before dispatches carried `critical`. */
const ENGINE_STOP_TEXTS = new Set(Object.values(PROTOCOL_COMMANDS).flatMap((c) => (c.engine_stop ? [c.engine_stop.trim().toLowerCase()] : [])));

/** True for engine-stop dispatches, including legacy queue entries without the `critical` flag. */
export function isSafetyCriticalDispatch(d: Pick<CommandDispatch, 'text' | 'critical'>): boolean {
  return d.critical === true || ENGINE_STOP_TEXTS.has(d.text.trim().toLowerCase());
}

/** Why a safety-critical dispatch reaching the gateway must not be sent now (null = send it). */
export function criticalDispatchRejection(d: Pick<CommandDispatch, 'text' | 'critical' | 'issuedAt'>, nowMs: number): string | null {
  if (!isSafetyCriticalDispatch(d) || !d.issuedAt) return null;
  const ageSec = (nowMs - Date.parse(d.issuedAt)) / 1000;
  if (!Number.isFinite(ageSec) || ageSec > CRITICAL_DISPATCH_MAX_AGE_SEC) {
    return 'Engine stop expired before it reached the tracker. Send it again.';
  }
  return null;
}

/** Message recorded when a queued engine stop is found on reconnect (it is dropped, never delivered). */
export const CRITICAL_NOT_DELIVERED_OFFLINE = 'Engine stop was not delivered: the vehicle was offline. Send it again once the vehicle is online.';

/** The live-state fields the engine-stop check reads. */
export interface EngineStopLiveState {
  status: string;
  speedKph: number;
  fixTime: string | null;
  /** When the server last received data from the device (may be newer than the GPS fix while parked). */
  serverTime?: string | null;
}

/** Age (seconds) of the newest telemetry: the later of the GPS fix and the server receive time. */
function telemetryAgeSec(live: EngineStopLiveState, nowMs: number): number {
  const times = [live.fixTime, live.serverTime].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
  return times.length ? (nowMs - Math.max(...times)) / 1000 : NaN;
}

/** Why an engine stop must be refused right now (null = allowed): needs a fresh, slow, online vehicle. */
export function engineStopBlockReason(live: EngineStopLiveState | undefined | null, nowMs: number): string | null {
  if (!live || (!live.fixTime && !live.serverTime)) return 'No position has been received from this vehicle yet. Engine stop needs fresh telemetry.';
  if (live.status === 'OFFLINE' || live.status === 'NO_DATA') return 'The vehicle is offline. Engine stop is only sent to a vehicle that is online now.';
  const ageSec = telemetryAgeSec(live, nowMs);
  if (!Number.isFinite(ageSec) || ageSec > ENGINE_STOP_MAX_FIX_AGE_SEC) {
    return `The last position is ${Number.isFinite(ageSec) ? Math.round(ageSec) : '?'} s old. Engine stop needs a position from the last ${ENGINE_STOP_MAX_FIX_AGE_SEC} s.`;
  }
  if (live.speedKph > ENGINE_STOP_MAX_SPEED_KPH) {
    return `The vehicle is moving at ${Math.round(live.speedKph)} km/h. Engine stop is only allowed below ${ENGINE_STOP_MAX_SPEED_KPH} km/h.`;
  }
  return null;
}

// ── Engine-stop preparation: "request a fresh position, then confirm" ─────────────────────────────────────────────
// Owner decision on docs/modernization/anti-theft-immobilisation-proposal.md (Option 1 + Option 4 entry point). It only
// asks the tracker for a new position and shows it; the engine stop itself still goes through the unchanged send path
// (engineStopBlockReason, never queued, gateway freshness check). Nothing here relaxes Q-01 / D-104.

/**
 * Position request sent to a CONNECTED tracker by the preparation step (never queued). Teltonika `getrecord` makes the
 * device generate and send a fresh AVL record [vendor: confirm on a bench device]. Concox `WHERE#` is answered with a
 * text reply which is NOT parsed into a position; only a GPS packet the device uploads afterwards counts
 * [vendor: confirm which firmware uploads one].
 */
export const ENGINE_STOP_PROBE_COMMANDS: Record<string, string> = { GT06: 'WHERE#', TELTONIKA: 'getrecord' };
/** How long the preparation waits for a fresh position (seconds) before giving up. */
export const ENGINE_STOP_PREPARE_WAIT_SEC = 45;
/** Position requests allowed per user and vehicle within ENGINE_STOP_PREPARE_WINDOW_SEC. */
export const ENGINE_STOP_PREPARE_MAX_PER_USER = 3;
/** Position requests allowed per vehicle (all users) within ENGINE_STOP_PREPARE_WINDOW_SEC. */
export const ENGINE_STOP_PREPARE_MAX_PER_VEHICLE = 6;
export const ENGINE_STOP_PREPARE_WINDOW_SEC = 600;
/**
 * A fresh position's GPS fix time may be at most this much earlier than the request (seconds): a valid fix carries
 * satellite time, so only the whole-second resolution of the protocols needs allowing for.
 */
export const PREPARE_FIX_TOLERANCE_SEC = 3;
/** A fix dated more than this far in the future (seconds) is not trusted (device clock fault). */
export const PREPARE_FIX_MAX_FUTURE_SEC = 30;

/** The live-state fields the fresh-position check reads. */
export interface FreshPositionLiveState extends EngineStopLiveState {
  /** The live state comes from a trusted GPS fix (valid, not a jump, not a re-upload); set by the processor. */
  gpsValid?: boolean;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Why the live state does not (yet) hold a fresh position for a preparation started at `requestedAtMs` (null = fresh).
 * Fresh means: received by the processor strictly AFTER the request, from a valid GPS fix, with a fix time no earlier
 * than the request (minus PREPARE_FIX_TOLERANCE_SEC) and not in the future. A heartbeat, a text reply, an invalid-fix
 * or re-uploaded record never counts. Stricter than, and additional to, engineStopBlockReason.
 */
export function freshPositionReason(live: FreshPositionLiveState | undefined | null, requestedAtMs: number, nowMs: number): string | null {
  if (!Number.isFinite(requestedAtMs)) return 'Unknown request time.';
  const server = live?.serverTime ? Date.parse(live.serverTime) : NaN;
  if (!live || !Number.isFinite(server) || server <= requestedAtMs) return 'Waiting for a new position from the vehicle.';
  if (live.gpsValid !== true || live.lat == null || live.lng == null) return 'The vehicle answered without a valid GPS fix. Waiting for a position with GPS.';
  const fix = live.fixTime ? Date.parse(live.fixTime) : NaN;
  if (!Number.isFinite(fix) || fix < requestedAtMs - PREPARE_FIX_TOLERANCE_SEC * 1000) return 'The vehicle sent an older stored position. Waiting for a current one.';
  if (fix > nowMs + PREPARE_FIX_MAX_FUTURE_SEC * 1000) return "The position's time is in the future (tracker clock fault). It is not trusted.";
  return null;
}

/** waiting = asking the vehicle; ready = fresh position passes every engine-stop rule; blocked = fresh, but a rule refuses. */
export type EngineStopPrepareStatus = 'waiting' | 'ready' | 'blocked' | 'timeout' | 'not_connected';

export interface EngineStopPrepareRequest {
  /** Poll an earlier preparation instead of starting a new one. */
  requestId?: string;
}

export interface EngineStopFreshPosition {
  lat: number;
  lng: number;
  speedKph: number;
  status: string;
  ignition: boolean | null;
  satellites: number | null;
  fixTime: string;
  serverTime: string;
}

/** POST /objects/:id/commands/engine-stop/prepare */
export interface EngineStopPrepareResponse {
  requestId: string | null;
  status: EngineStopPrepareStatus;
  /** When the position request was sent (ISO). */
  requestedAt: string | null;
  /** Explanation shown to the user (why it waits, why it is refused). */
  message: string | null;
  /** Why the engine stop would be refused right now (engineStopBlockReason, or not connected / timeout). */
  blockReason: string | null;
  freshPosition: EngineStopFreshPosition | null;
  /** Last moment the fresh position is recent enough for an engine stop (the server re-checks at send time). */
  confirmBy: string | null;
}

export interface AvailableCommand extends CommandDef {
  /** Protocol text that will be sent ('' for custom). */
  payload: string;
}

export interface SendCommandRequest {
  type: CommandType;
  /** CUSTOM only: raw protocol text. */
  text?: string;
  /** Critical commands: the user's current password. */
  password?: string;
  /**
   * Engine stop only (optional): the `requestId` of an engine-stop preparation ("request fresh position") whose fresh
   * position the user confirmed. When present it is checked in addition to every existing engine-stop rule; it never
   * replaces or relaxes any of them.
   */
  prepareRequestId?: string;
}

export interface CommandDto {
  id: string;
  objectId: string;
  uniqueId: string;
  type: CommandType;
  payload: string;
  status: CommandStatusValue;
  response: string | null;
  error: string | null;
  createdByName: string | null;
  createdAt: string;
  sentAt: string | null;
  ackAt: string | null;
  expiresAt: string;
}

/** Gateway ↔ API messages over Valkey. */
export interface CommandDispatch {
  commandId: string;
  uniqueId: string;
  text: string;
  /** Safety-critical (engine stop): never queued, never delivered late. */
  critical?: boolean;
  /** When the API issued the dispatch (ISO), for the gateway's freshness check. */
  issuedAt?: string;
  /**
   * Never queued: if the device is not connected when the dispatch arrives, it is reported FAILED instead of being
   * kept for the next connection (engine-stop preparation position requests).
   */
  noQueue?: boolean;
}
export interface CommandUpdate {
  commandId: string;
  status: Extract<CommandStatusValue, 'SENT' | 'ACKED' | 'FAILED'>;
  response?: string;
  error?: string;
  at: string;
}

/** GET /auth/sessions */
export interface SessionDto {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

/** Commands that make a tracker report its SIM ICCID and firmware version (Super Admin "Read SIM & version"). */
export const DEVICE_INFO_QUERIES: Record<string, string[]> = {
  GT06: ['VERSION#', 'ICCID#'],
  TELTONIKA: ['getver', 'getimeiccid'],
};

/** ICCID (89…, 18–22 digits) and firmware version found in a command reply, if any. */
export function parseDeviceInfo(text: string | null | undefined): { iccid?: string; version?: string } {
  const out: { iccid?: string; version?: string } = {};
  if (!text) return out;
  const iccid = /\b(89\d{16,20})F?\b/i.exec(text);
  if (iccid) out.iccid = iccid[1];
  // Concox "[VERSION]GT06N_20_A1D_D23_R0_V02" / "VERSION:…", Teltonika "Ver:03.27.07_04 GPS:…".
  const ver = /(?:\[VERSION\]|\bversion\s*[:=]|\bver\s*[:=])\s*([A-Za-z0-9][A-Za-z0-9._\-/]{2,60})/i.exec(text);
  if (ver) out.version = ver[1];
  return out;
}
