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
