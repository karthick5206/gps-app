/**
 * Alert catalogue, configuration shapes and alert/notification DTOs.
 * Alert settings resolve per object through Company → Branch → Vehicle group → Object; the most specific level wins per field.
 */

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const NOTIFY_CHANNELS = ['INAPP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const ALERT_LEVELS = ['COMPANY', 'BRANCH', 'GROUP', 'OBJECT'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export type AlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED';

export type AlertParamType = 'number' | 'time' | 'geofences' | 'boolean';

export interface AlertParamDef {
  key: string;
  label: string;
  type: AlertParamType;
  unit?: string;
  default: number | string | boolean | string[] | null;
  hint?: string;
  min?: number;
  max?: number;
}

export interface AlertTypeDef {
  code: AlertTypeCode;
  label: string;
  category: 'Driving' | 'Driver safety' | 'Location' | 'Device' | 'Device health' | 'Vehicle' | 'Safety' | 'Compliance' | 'Sensors';
  /** Device-model capability required; null = any GPS device. */
  capability: string | null;
  defaultSeverity: AlertSeverity;
  defaultEnabled: boolean;
  /** Mandatory alerts cannot be switched off below company level. */
  mandatory: boolean;
  params: AlertParamDef[];
  /** Extra template placeholders beyond COMMON_PLACEHOLDERS. */
  placeholders: string[];
}

export const ALERT_TYPE_CODES = [
  'OVERSPEED',
  'IDLING',
  'IGNITION_ON',
  'IGNITION_OFF',
  'GEOFENCE_ENTER',
  'GEOFENCE_EXIT',
  'GEOFENCE_STAY',
  'GEOFENCE_OVERSPEED',
  'POWER_CUT',
  'SOS',
  'LOW_BATTERY',
  'DEVICE_OFFLINE',
  'GPS_LOST',
  'GSM_WEAK',
  'DATA_DELAYED',
  'CLOCK_ERROR',
  'POWER_LOW',
  'DEVICE_TAMPER',
  'UNKNOWN_ALARM',
  'DRIVER_FATIGUE',
  'DRIVER_PHONE',
  'DRIVER_SMOKING',
  'DRIVER_DISTRACTED',
  'DRIVER_ABSENT',
  'FORWARD_COLLISION_WARNING',
  'LANE_DEPARTURE',
  'TAILGATING',
  'CAMERA_FAULT',
  'CRASH',
  'DOCUMENT_EXPIRING',
  'DOCUMENT_EXPIRED',
  'SERVICE_DUE',
  'FUEL_DRAIN',
  'FUEL_REFILL',
  'AC_ON',
  'AC_OFF',
  'AC_ON_ENGINE_OFF',
  'DOOR_OPEN',
  'DOOR_CLOSED',
  'DOOR_OPEN_WHILE_MOVING',
] as const;
export type AlertTypeCode = (typeof ALERT_TYPE_CODES)[number];

export const COMMON_PLACEHOLDERS = [
  'vehicle_name', 'plate', 'branch', 'alert_type', 'severity', 'time', 'location', 'map_link', 'speed', 'driver_name', 'company',
] as const;

/** Dashcams rate each ADAS / DMS event level 1 (first warning) or 2 (severe / repeated). */
const DASHCAM_LEVEL_PARAM: AlertParamDef = {
  key: 'minLevel', label: 'Minimum event level', type: 'number', default: 1, min: 1, max: 2, hint: '1 = every event, 2 = only severe (level 2) events',
};

export const ALERT_TYPES: readonly AlertTypeDef[] = [
  {
    code: 'OVERSPEED', label: 'Overspeed', category: 'Driving', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [
      { key: 'limitKph', label: 'Speed limit', type: 'number', unit: 'km/h', default: null, min: 5, max: 250, hint: 'Empty = the vehicle\'s own limit, else the vehicle-type default' },
      { key: 'toleranceKph', label: 'Tolerance', type: 'number', unit: 'km/h', default: 0, min: 0, max: 50 },
      { key: 'minDurationSec', label: 'Minimum duration over the limit', type: 'number', unit: 's', default: 10, min: 0, max: 600 },
      { key: 'criticalOverKph', label: 'Critical when over the limit by', type: 'number', unit: 'km/h', default: 20, min: 1, max: 150 },
      { key: 'nightLimitKph', label: 'Night limit', type: 'number', unit: 'km/h', default: null, min: 5, max: 250, hint: 'Empty = same as day' },
      { key: 'nightFrom', label: 'Night from', type: 'time', default: '22:00' },
      { key: 'nightTo', label: 'Night to', type: 'time', default: '05:00' },
      { key: 'repeatEveryMin', label: 'Repeat while overspeeding every', type: 'number', unit: 'min', default: 0, min: 0, max: 120, hint: '0 = one alert per overspeed event' },
    ],
    placeholders: ['limit', 'max_speed', 'duration'],
  },
  {
    code: 'IDLING', label: 'Long idling', category: 'Driving', capability: 'ignition', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [
      { key: 'speedBelowKph', label: 'Idle when speed below', type: 'number', unit: 'km/h', default: 3, min: 0, max: 10 },
      { key: 'thresholdMin', label: 'Alert after idling for', type: 'number', unit: 'min', default: 10, min: 1, max: 600 },
      { key: 'criticalMin', label: 'Critical after', type: 'number', unit: 'min', default: 30, min: 1, max: 1440 },
      { key: 'movementToleranceM', label: 'Movement that doesn\'t reset the timer', type: 'number', unit: 'm', default: 50, min: 0, max: 500 },
      { key: 'repeatEveryMin', label: 'Repeat while idling every', type: 'number', unit: 'min', default: 15, min: 0, max: 240, hint: '0 = no repeat' },
      { key: 'excludeGeofenceIds', label: 'No alert inside geofences', type: 'geofences', default: [] },
    ],
    placeholders: ['duration'],
  },
  { code: 'IGNITION_ON', label: 'Ignition on', category: 'Vehicle', capability: 'ignition', defaultSeverity: 'INFO', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  { code: 'IGNITION_OFF', label: 'Ignition off', category: 'Vehicle', capability: 'ignition', defaultSeverity: 'INFO', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  { code: 'GEOFENCE_ENTER', label: 'Geofence entry', category: 'Location', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: ['geofence'] },
  { code: 'GEOFENCE_EXIT', label: 'Geofence exit', category: 'Location', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: ['geofence'] },
  { code: 'GEOFENCE_STAY', label: 'Stayed too long in geofence', category: 'Location', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: ['geofence', 'duration'] },
  { code: 'GEOFENCE_OVERSPEED', label: 'Overspeed inside geofence', category: 'Location', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: ['geofence', 'limit'] },
  { code: 'POWER_CUT', label: 'Power cut / tamper', category: 'Device', capability: 'power_cut', defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  { code: 'SOS', label: 'SOS / panic', category: 'Safety', capability: 'sos', defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: true, params: [], placeholders: [] },
  {
    code: 'LOW_BATTERY', label: 'Low device battery', category: 'Device', capability: 'battery', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'thresholdPct', label: 'Alert below', type: 'number', unit: '%', default: 20, min: 5, max: 80 }],
    placeholders: ['battery'],
  },
  {
    code: 'DEVICE_OFFLINE', label: 'Device offline', category: 'Device', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'afterMin', label: 'Offline after', type: 'number', unit: 'min', default: null, min: 5, max: 1440, hint: 'Empty = company offline threshold' }],
    placeholders: ['duration'],
  },
  // ── Device health (computed from the data the tracker sends) ──
  {
    code: 'GPS_LOST', label: 'GPS signal lost', category: 'Device health', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'afterMin', label: 'Alert after no GPS fix for', type: 'number', unit: 'min', default: 30, min: 5, max: 1440, hint: 'Data keeps arriving but without a valid fix: antenna, jamming or covered parking' }],
    placeholders: ['duration'],
  },
  {
    code: 'GSM_WEAK', label: 'Weak mobile signal', category: 'Device health', capability: null, defaultSeverity: 'INFO', defaultEnabled: true, mandatory: false,
    params: [
      { key: 'maxLevel', label: 'Weak at or below', type: 'number', unit: 'bars (0–4)', default: 1, min: 0, max: 3 },
      { key: 'afterMin', label: 'Alert after', type: 'number', unit: 'min', default: 30, min: 5, max: 1440 },
    ],
    placeholders: ['duration'],
  },
  {
    code: 'DATA_DELAYED', label: 'Data delayed (network)', category: 'Device health', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'delayMin', label: 'Alert when data arrives later than', type: 'number', unit: 'min', default: 10, min: 2, max: 720, hint: 'The tracker buffered data because GPRS was down' }],
    placeholders: ['duration'],
  },
  {
    code: 'CLOCK_ERROR', label: 'Wrong device time', category: 'Device health', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'thresholdMin', label: 'Alert when the device clock is ahead by', type: 'number', unit: 'min', default: 15, min: 5, max: 1440, hint: 'Usually a wrong time-zone setting on the tracker' }],
    placeholders: ['duration'],
  },
  {
    code: 'POWER_LOW', label: 'Low vehicle voltage', category: 'Device health', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [
      { key: 'thresholdV', label: 'Alert below', type: 'number', unit: 'V', default: 11.5, min: 5, max: 30, hint: '12 V vehicles ~11.5 V; 24 V vehicles ~23 V' },
      { key: 'afterMin', label: 'For at least', type: 'number', unit: 'min', default: 10, min: 1, max: 1440 },
    ],
    placeholders: ['voltage'],
  },
  { code: 'DEVICE_TAMPER', label: 'Tracker tamper / GPS jamming', category: 'Device health', capability: null, defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  // A device sent an alarm code VeeTrax doesn't recognise (e.g. a new model's SOS) — so it is noticed, not dropped.
  { code: 'UNKNOWN_ALARM', label: 'Unrecognised device alarm', category: 'Device health', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  // ── Driver safety (dashcam DMS = driver camera, ADAS = road camera) ──
  { code: 'DRIVER_FATIGUE', label: 'Driver fatigue', category: 'Driver safety', capability: 'dms', defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'DRIVER_PHONE', label: 'Driver using phone', category: 'Driver safety', capability: 'dms', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'DRIVER_SMOKING', label: 'Driver smoking', category: 'Driver safety', capability: 'dms', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'DRIVER_DISTRACTED', label: 'Driver distracted', category: 'Driver safety', capability: 'dms', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'DRIVER_ABSENT', label: 'Driver not in seat', category: 'Driver safety', capability: 'dms', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'FORWARD_COLLISION_WARNING', label: 'Forward collision warning', category: 'Driver safety', capability: 'adas', defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'LANE_DEPARTURE', label: 'Lane departure', category: 'Driver safety', capability: 'adas', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'TAILGATING', label: 'Following too close', category: 'Driver safety', capability: 'adas', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [DASHCAM_LEVEL_PARAM], placeholders: [] },
  { code: 'CAMERA_FAULT', label: 'Dashcam camera fault', category: 'Device health', capability: 'video', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  { code: 'CRASH', label: 'Crash / rollover', category: 'Safety', capability: 'crash', defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [], placeholders: [] },
  // ── Compliance (raised by the daily reminders job, not by tracker data) ──
  { code: 'DOCUMENT_EXPIRING', label: 'Document expiring', category: 'Compliance', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: ['document', 'expires_on', 'days_left'] },
  { code: 'DOCUMENT_EXPIRED', label: 'Document expired', category: 'Compliance', capability: null, defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [], placeholders: ['document', 'expires_on'] },
  { code: 'SERVICE_DUE', label: 'Service due', category: 'Compliance', capability: null, defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false, params: [], placeholders: ['service', 'due'] },
  // ── Fuel (refill / drain detected from the vehicle's fuel sensor; thresholds are in the vehicle's fuel settings) ──
  { code: 'FUEL_DRAIN', label: 'Possible fuel theft', category: 'Vehicle', capability: 'fuel', defaultSeverity: 'CRITICAL', defaultEnabled: true, mandatory: false, params: [], placeholders: ['litres', 'fuel_before', 'fuel_after'] },
  { code: 'FUEL_REFILL', label: 'Fuel refill', category: 'Vehicle', capability: 'fuel', defaultSeverity: 'INFO', defaultEnabled: true, mandatory: false, params: [], placeholders: ['litres', 'fuel_before', 'fuel_after'] },
  // ── AC / door sensors (supported only on vehicles with the sensor configured in "AC / Door sensors") ──
  { code: 'AC_ON', label: 'AC switched on', category: 'Sensors', capability: 'ac', defaultSeverity: 'INFO', defaultEnabled: false, mandatory: false, params: [], placeholders: [] },
  { code: 'AC_OFF', label: 'AC switched off', category: 'Sensors', capability: 'ac', defaultSeverity: 'INFO', defaultEnabled: false, mandatory: false, params: [], placeholders: ['duration'] },
  {
    code: 'AC_ON_ENGINE_OFF', label: 'AC running with ignition off', category: 'Sensors', capability: 'ac', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'minutes', label: 'Alert after AC on with ignition off for', type: 'number', unit: 'min', default: 10, min: 1, max: 600, hint: 'Drains the vehicle battery' }],
    placeholders: ['duration'],
  },
  { code: 'DOOR_OPEN', label: 'Door opened', category: 'Sensors', capability: 'door', defaultSeverity: 'INFO', defaultEnabled: false, mandatory: false, params: [], placeholders: [] },
  { code: 'DOOR_CLOSED', label: 'Door closed', category: 'Sensors', capability: 'door', defaultSeverity: 'INFO', defaultEnabled: false, mandatory: false, params: [], placeholders: ['duration'] },
  {
    code: 'DOOR_OPEN_WHILE_MOVING', label: 'Door open while moving', category: 'Sensors', capability: 'door', defaultSeverity: 'WARNING', defaultEnabled: true, mandatory: false,
    params: [{ key: 'speedKph', label: 'Alert when the door is open above', type: 'number', unit: 'km/h', default: 10, min: 1, max: 120 }],
    placeholders: [],
  },
];

/** Catalogue default cooldown (minutes) per alert type when nothing is configured (shared by API and web). */
export const DEFAULT_COOLDOWN_MIN: Record<AlertTypeCode, number> = {
  OVERSPEED: 0,
  IDLING: 0,
  IGNITION_ON: 0,
  IGNITION_OFF: 0,
  GEOFENCE_ENTER: 0,
  GEOFENCE_EXIT: 0,
  GEOFENCE_STAY: 0,
  GEOFENCE_OVERSPEED: 5,
  POWER_CUT: 5,
  SOS: 1,
  LOW_BATTERY: 60,
  DEVICE_OFFLINE: 0,
  GPS_LOST: 0,
  GSM_WEAK: 0,
  DATA_DELAYED: 60,
  CLOCK_ERROR: 1440,
  POWER_LOW: 0,
  DEVICE_TAMPER: 5,
  UNKNOWN_ALARM: 60,
  // Dashcams repeat an event every few seconds while it lasts: one alert per short window.
  DRIVER_FATIGUE: 2,
  DRIVER_PHONE: 2,
  DRIVER_SMOKING: 2,
  DRIVER_DISTRACTED: 2,
  DRIVER_ABSENT: 2,
  FORWARD_COLLISION_WARNING: 2,
  LANE_DEPARTURE: 2,
  TAILGATING: 2,
  CAMERA_FAULT: 30,
  CRASH: 5,
  // Raised once per document / service state by the reminders job.
  DOCUMENT_EXPIRING: 0,
  DOCUMENT_EXPIRED: 0,
  SERVICE_DUE: 0,
  // One alert per detected event (events are already debounced by the detector).
  FUEL_DRAIN: 0,
  FUEL_REFILL: 0,
  // State changes are debounced by the processor; a short cooldown still guards against a loose wire.
  AC_ON: 1,
  AC_OFF: 1,
  AC_ON_ENGINE_OFF: 30,
  DOOR_OPEN: 1,
  DOOR_CLOSED: 1,
  DOOR_OPEN_WHILE_MOVING: 5,
};

export const ALERT_TYPE_MAP: Record<AlertTypeCode, AlertTypeDef> = Object.fromEntries(ALERT_TYPES.map((t) => [t.code, t])) as Record<AlertTypeCode, AlertTypeDef>;

/**
 * Emergency alerts: the mobile app plays a loud siren (push channel 'sos') and opens a full-screen alarm; the web
 * repeats a siren until acknowledged. POWER_CUT = tracker power removed / tampered (possible theft).
 */
export const EMERGENCY_ALERT_TYPES = ['SOS', 'CRASH', 'POWER_CUT'] as const satisfies readonly AlertTypeCode[];

export function isEmergencyAlert(type: string | null | undefined): boolean {
  return !!type && (EMERGENCY_ALERT_TYPES as readonly string[]).includes(type);
}

/**
 * Default "require acknowledgement" (someone takes responsibility) when no Alert Settings level sets it: emergencies and
 * device disconnection, plus every alert raised as CRITICAL. Configurable per alert type at Company → Branch → Vehicle
 * group → Vehicle (`AlertSettingDto.requireAck`); the value is stored on each alert when it is raised.
 */
export const ACK_REQUIRED_ALERT_TYPES = [...EMERGENCY_ALERT_TYPES, 'DEVICE_OFFLINE'] as const satisfies readonly AlertTypeCode[];

export function defaultRequireAck(type: string, severity: string): boolean {
  return severity === 'CRITICAL' || (ACK_REQUIRED_ALERT_TYPES as readonly string[]).includes(type);
}

/** SOS and crash always require acknowledgement: `requireAck: false` is rejected at every level. */
/** Life-safety alerts whose acknowledgement can't be turned off (power cut rings like one but stays configurable). */
const ACK_MANDATORY_TYPES: readonly string[] = ['SOS', 'CRASH'];

export function isAckMandatory(type: string): boolean {
  return ACK_MANDATORY_TYPES.includes(type);
}

/**
 * Whether an alert being raised needs acknowledgement: mandatory types always; a value set at some settings level wins;
 * otherwise the default rule on the alert's own severity (rules may escalate one alert to CRITICAL).
 */
export function ackRequiredFor(setting: Pick<EffectiveAlertSetting, 'alertType' | 'requireAck' | 'sources'> | undefined, type: string, severity: string): boolean {
  if (isAckMandatory(type)) return true;
  if (!setting || (setting.sources?.requireAck ?? 'DEFAULT') === 'DEFAULT') return defaultRequireAck(type, severity);
  return setting.requireAck;
}

/** Days 1–7 = Monday–Sunday; times are HH:mm in the company timezone; `from` > `to` wraps midnight. */
export interface TimeWindow {
  days: number[];
  from: string;
  to: string;
}

export type ChannelsBySeverity = Record<AlertSeverity, NotifyChannel[]>;

export const DEFAULT_CHANNELS: ChannelsBySeverity = {
  INFO: ['INAPP'],
  WARNING: ['INAPP', 'PUSH', 'EMAIL'],
  CRITICAL: ['INAPP', 'PUSH', 'EMAIL', 'SMS'],
};

/** One stored override row. Null/absent fields inherit from the level above. */
export interface AlertSettingDto {
  id: string;
  level: AlertLevel;
  targetId: string; // companyId for COMPANY level
  targetName: string;
  alertType: AlertTypeCode;
  enabled: boolean | null;
  params: Record<string, unknown>; // only overridden keys
  schedule: TimeWindow | null;
  cooldownMin: number | null;
  severity: AlertSeverity | null;
  channels: Partial<ChannelsBySeverity> | null;
  /** Require acknowledgement for this alert type; null = inherit (default: `defaultRequireAck`). */
  requireAck: boolean | null;
  updatedAt: string;
}

/** Fully resolved setting for one object and alert type, with where each field came from. */
export interface EffectiveAlertSetting {
  alertType: AlertTypeCode;
  supported: boolean; // device capability present
  enabled: boolean;
  params: Record<string, unknown>;
  schedule: TimeWindow | null;
  cooldownMin: number;
  severity: AlertSeverity;
  channels: ChannelsBySeverity;
  /** Require acknowledgement (source DEFAULT = `defaultRequireAck` on the effective severity; alerts escalated to CRITICAL also need it). */
  requireAck: boolean;
  snoozedUntil: string | null;
  /** field name ('enabled', 'params.toleranceKph', 'channels', …) → level it came from ('DEFAULT' when catalogue default). */
  sources: Record<string, AlertLevel | 'DEFAULT'>;
}

export type RecipientMode = 'DEFAULT' | 'ADD' | 'ONLY' | 'NONE';
export type RecipientKind = 'USER' | 'ROLE' | 'DYNAMIC' | 'EMAIL' | 'MOBILE';
/**
 * DYNAMIC values: OBJECT_USERS (users mapped to the object or its branch), BRANCH_MANAGERS, ALL_VIEWERS (every active
 * user who can see the object, incl. company-wide roles). ALL_VIEWERS is also the PUSH default when no push list exists.
 */
export type DynamicRecipient = 'OBJECT_USERS' | 'BRANCH_MANAGERS' | 'ALL_VIEWERS';

export interface RecipientEntry {
  kind: RecipientKind;
  value: string; // user id, role id, DynamicRecipient, email or +91 mobile
  label?: string;
}

export interface RecipientListDto {
  id: string;
  level: AlertLevel;
  targetId: string;
  targetName: string;
  alertType: AlertTypeCode | '*'; // '*' = default list for all alerts
  severity: AlertSeverity | '*';
  channel: NotifyChannel;
  mode: RecipientMode;
  entries: RecipientEntry[];
  updatedAt: string;
}

export interface AlertSnoozeDto {
  id: string; level: AlertLevel; targetId: string; targetName: string;
  alertTypes: AlertTypeCode[]; // empty = all non-mandatory alerts
  until: string; reason: string | null; createdByName: string | null; createdAt: string;
}

export interface AlertPackDto {
  id: string; name: string; description: string | null; isSystem: boolean; isActive: boolean;
  settings: Omit<AlertSettingDto, 'id' | 'level' | 'targetId' | 'targetName' | 'updatedAt'>[];
}

export interface AlertDto {
  id: string;
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  branchId: string | null;
  type: AlertTypeCode;
  severity: AlertSeverity;
  message: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  geofenceId: string | null;
  geofenceName: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
  status: AlertStatus;
  ackByName: string | null;
  ackAt: string | null;
  ackNote: string | null;
  /**
   * Read by the calling user: they opened it (or marked it / all read), or it is no longer NEW (acknowledged or
   * resolved alerts are handled, so read for everyone). Separate from acknowledging, which is shared.
   */
  read: boolean;
  /** Needs acknowledgement: decided when the alert was raised (Alert Settings `requireAck`, else `defaultRequireAck`). */
  ackRequired: boolean;
  /** GET /alerts/:id of an emergency alert only: who to call (driver on the vehicle at the time, device SIM). */
  contacts?: { driverName: string | null; driverMobile: string | null; deviceSim: string | null };
}

/** GET /alerts/unread-count: unread for the caller, and NEW alerts that still need acknowledgement (shared, in scope). */
export interface AlertUnreadCount {
  count: number;
  pendingAck: number;
}

/** Socket `alerts:read`, sent to the reading user's own sockets (web + phone): `ids` are now read, or `all` of them. */
export interface AlertsReadEvent {
  ids?: string[];
  all?: boolean;
}

/** Socket `alerts:acked`, sent to in-scope sockets: these alerts were acknowledged. No `ids` = many, refetch. */
export interface AlertsAckedEvent {
  ids?: string[];
  ackByName: string | null;
  ackAt: string;
}

export type NotificationStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface NotificationLogDto {
  id: string; alertId: string | null; channel: NotifyChannel; recipient: string;
  subject: string | null; status: NotificationStatus; error: string | null; provider: string | null;
  createdAt: string; sentAt: string | null;
}

export const SYSTEM_TEMPLATE_PURPOSES = ['SYSTEM_OTP', 'SYSTEM_PASSWORD_RESET', 'SYSTEM_WELCOME', 'SYSTEM_SCHEDULED_REPORT'] as const;
export type TemplatePurpose = AlertTypeCode | (typeof SYSTEM_TEMPLATE_PURPOSES)[number];
export type TemplateApproval = 'NA' | 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface MessageTemplateDto {
  id: string;
  level: 'SYSTEM' | 'COMPANY';
  overridesId: string | null; // company override → the system template it replaces
  purpose: TemplatePurpose;
  channel: Exclude<NotifyChannel, 'INAPP'>;
  language: string;
  name: string;
  subject: string | null;
  body: string;
  dltTemplateId: string | null;
  senderId: string | null;
  approvalStatus: TemplateApproval;
  isActive: boolean;
  version: number;
  usedByRules: number;
  overrideCount: number; // SYSTEM rows, Super Admin only; else 0
  updatedByName: string | null;
  updatedAt: string;
}
