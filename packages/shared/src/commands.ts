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
