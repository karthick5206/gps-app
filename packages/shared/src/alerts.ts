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
  category: 'Driving' | 'Location' | 'Device' | 'Device health' | 'Vehicle' | 'Safety';
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
] as const;
export type AlertTypeCode = (typeof ALERT_TYPE_CODES)[number];

export const COMMON_PLACEHOLDERS = [
  'vehicle_name', 'plate', 'branch', 'alert_type', 'severity', 'time', 'location', 'map_link', 'speed', 'driver_name', 'company',
] as const;

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
};

export const ALERT_TYPE_MAP: Record<AlertTypeCode, AlertTypeDef> = Object.fromEntries(ALERT_TYPES.map((t) => [t.code, t])) as Record<AlertTypeCode, AlertTypeDef>;

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
  snoozedUntil: string | null;
  /** field name ('enabled', 'params.toleranceKph', 'channels', …) → level it came from ('DEFAULT' when catalogue default). */
  sources: Record<string, AlertLevel | 'DEFAULT'>;
}

export type RecipientMode = 'DEFAULT' | 'ADD' | 'ONLY' | 'NONE';
export type RecipientKind = 'USER' | 'ROLE' | 'DYNAMIC' | 'EMAIL' | 'MOBILE';
/** DYNAMIC values: OBJECT_USERS (users mapped to the object or its branch), BRANCH_MANAGERS. */
export type DynamicRecipient = 'OBJECT_USERS' | 'BRANCH_MANAGERS';

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
