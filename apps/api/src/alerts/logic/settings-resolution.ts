import {
  DEFAULT_COOLDOWN_MIN,
  ALERT_SEVERITIES,
  ALERT_TYPE_MAP,
  ALERT_TYPES,
  AlertLevel,
  AlertParamDef,
  AlertSeverity,
  AlertTypeCode,
  AlertTypeDef,
  ChannelsBySeverity,
  DEFAULT_CHANNELS,
  defaultRequireAck,
  EffectiveAlertSetting,
  isAckMandatory,
  NOTIFY_CHANNELS,
  NotifyChannel,
  TimeWindow,
} from '@veetracer/shared';
import { isValidTimeWindow, parseHhmm } from './time-window';

export { DEFAULT_COOLDOWN_MIN };

/** The override fields of one stored AlertSetting row. Null/absent = inherit. */
export interface SettingOverride {
  enabled: boolean | null;
  params: Record<string, unknown>;
  schedule: TimeWindow | null;
  cooldownMin: number | null;
  severity: AlertSeverity | null;
  channels: Partial<ChannelsBySeverity> | null;
  /** Absent/null = inherit. */
  requireAck?: boolean | null;
}

export type OverrideMap = Partial<Record<string, SettingOverride>>; // alertType → override

export interface GroupOverrides {
  groupId: string;
  name: string;
  priority: number;
  rows: OverrideMap;
}

/** All overrides along one object's hierarchy. */
export interface SettingsChain {
  company?: OverrideMap;
  branch?: OverrideMap;
  groups: GroupOverrides[];
  object?: OverrideMap;
}

export interface ApplicableSnooze {
  alertTypes: string[]; // empty = all non-mandatory
  until: number; // epoch ms
}

type Source = AlertLevel | 'DEFAULT';

/** Groups ordered by priority (highest first), ties broken by name then id so resolution is deterministic. */
export function sortGroups<T extends { priority: number; name: string; groupId: string }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name) || a.groupId.localeCompare(b.groupId));
}

interface Layer {
  level: AlertLevel;
  row: SettingOverride;
}

/** Most specific first: OBJECT, GROUP (highest priority first), BRANCH, COMPANY. */
function layersFor(chain: SettingsChain, type: AlertTypeCode): Layer[] {
  const layers: Layer[] = [];
  const push = (level: AlertLevel, map?: OverrideMap) => {
    const row = map?.[type];
    if (row) layers.push({ level, row });
  };
  push('OBJECT', chain.object);
  for (const g of sortGroups(chain.groups)) push('GROUP', g.rows);
  push('BRANCH', chain.branch);
  push('COMPANY', chain.company);
  return layers;
}

function pick<T>(layers: Layer[], get: (row: SettingOverride) => T | null | undefined, fallback: T): { value: T; source: Source } {
  for (const layer of layers) {
    const v = get(layer.row);
    if (v !== null && v !== undefined) return { value: v, source: layer.level };
  }
  return { value: fallback, source: 'DEFAULT' };
}

export function resolveOne(
  def: AlertTypeDef,
  chain: SettingsChain,
  capabilities: readonly string[],
  snoozes: ApplicableSnooze[],
  now: number,
): EffectiveAlertSetting {
  const layers = layersFor(chain, def.code);
  const sources: Record<string, Source> = {};

  // Mandatory alerts ignore `enabled: false` below company level.
  const enabledLayers = def.mandatory
    ? layers.filter((l) => l.level === 'COMPANY' || l.row.enabled !== false)
    : layers;
  const enabled = pick(enabledLayers, (r) => r.enabled, def.defaultEnabled);
  sources.enabled = enabled.source;

  const params: Record<string, unknown> = {};
  for (const p of def.params) {
    const v = pick(layers, (r) => (Object.prototype.hasOwnProperty.call(r.params ?? {}, p.key) ? (r.params[p.key] as unknown) : null), p.default as unknown);
    params[p.key] = v.value;
    sources[`params.${p.key}`] = v.source;
  }

  const schedule = pick<TimeWindow | null>(layers, (r) => r.schedule, null);
  sources.schedule = schedule.source;
  const cooldown = pick(layers, (r) => r.cooldownMin, DEFAULT_COOLDOWN_MIN[def.code]);
  sources.cooldownMin = cooldown.source;
  const severity = pick(layers, (r) => r.severity, def.defaultSeverity);
  sources.severity = severity.source;

  const channels = {} as ChannelsBySeverity;
  let channelsSource: Source = 'DEFAULT';
  const rank: Record<Source, number> = { DEFAULT: 0, COMPANY: 1, BRANCH: 2, GROUP: 3, OBJECT: 4 };
  for (const sev of ALERT_SEVERITIES) {
    const c = pick(layers, (r) => r.channels?.[sev], DEFAULT_CHANNELS[sev]);
    channels[sev] = [...c.value];
    sources[`channels.${sev}`] = c.source;
    if (rank[c.source] > rank[channelsSource]) channelsSource = c.source;
  }
  sources.channels = channelsSource;

  // SOS / crash always need acknowledgement; stored `false` rows (none can be saved) are ignored too.
  const requireAck = isAckMandatory(def.code)
    ? { value: true, source: 'DEFAULT' as Source }
    : pick(layers, (r) => r.requireAck, defaultRequireAck(def.code, severity.value));
  sources.requireAck = requireAck.source;

  let snoozedUntil: number | null = null;
  if (!def.mandatory) {
    for (const s of snoozes) {
      if (s.until <= now) continue;
      if (s.alertTypes.length && !s.alertTypes.includes(def.code)) continue;
      snoozedUntil = Math.max(snoozedUntil ?? 0, s.until);
    }
  }

  return {
    alertType: def.code,
    supported: def.capability === null || capabilities.includes(def.capability),
    enabled: enabled.value,
    params,
    schedule: schedule.value,
    cooldownMin: cooldown.value,
    severity: severity.value,
    channels,
    requireAck: requireAck.value,
    snoozedUntil: snoozedUntil ? new Date(snoozedUntil).toISOString() : null,
    sources,
  };
}

/** Effective settings for every alert type of one object. */
export function resolveEffectiveSettings(
  chain: SettingsChain,
  capabilities: readonly string[],
  snoozes: ApplicableSnooze[],
  now: number,
): EffectiveAlertSetting[] {
  return ALERT_TYPES.map((def) => resolveOne(def, chain, capabilities, snoozes, now));
}

export interface GroupConflict {
  alertType: AlertTypeCode;
  field: string;
  winner: { groupId: string; groupName: string; priority: number; value: unknown };
  others: { groupId: string; groupName: string; priority: number; value: unknown }[];
  /** True when a more specific OBJECT-level value overrides the groups anyway. */
  overriddenByObject: boolean;
}

function fieldValues(row: SettingOverride): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (row.enabled !== null && row.enabled !== undefined) out.enabled = row.enabled;
  if (row.severity) out.severity = row.severity;
  if (row.cooldownMin !== null && row.cooldownMin !== undefined) out.cooldownMin = row.cooldownMin;
  if (row.schedule) out.schedule = row.schedule;
  if (row.requireAck !== null && row.requireAck !== undefined) out.requireAck = row.requireAck;
  for (const [k, v] of Object.entries(row.params ?? {})) if (v !== null && v !== undefined) out[`params.${k}`] = v;
  for (const sev of ALERT_SEVERITIES) if (row.channels?.[sev]) out[`channels.${sev}`] = row.channels[sev];
  return out;
}

/** Fields that two or more of the object's groups set to different values, and which group wins. */
export function findGroupConflicts(chain: SettingsChain): GroupConflict[] {
  const conflicts: GroupConflict[] = [];
  const groups = sortGroups(chain.groups);
  for (const def of ALERT_TYPES) {
    const perField = new Map<string, { g: GroupOverrides; value: unknown }[]>();
    for (const g of groups) {
      const row = g.rows[def.code];
      if (!row) continue;
      for (const [field, value] of Object.entries(fieldValues(row))) {
        const list = perField.get(field) ?? [];
        list.push({ g, value });
        perField.set(field, list);
      }
    }
    const objectFields = chain.object?.[def.code] ? fieldValues(chain.object[def.code]!) : {};
    for (const [field, list] of perField) {
      if (list.length < 2) continue;
      const distinct = new Set(list.map((x) => JSON.stringify(x.value)));
      if (distinct.size < 2) continue;
      const [winner, ...others] = list;
      const fmt = (x: { g: GroupOverrides; value: unknown }) => ({
        groupId: x.g.groupId,
        groupName: x.g.name,
        priority: x.g.priority,
        value: x.value,
      });
      conflicts.push({
        alertType: def.code,
        field,
        winner: fmt(winner),
        others: others.map(fmt),
        overriddenByObject: field in objectFields,
      });
    }
  }
  return conflicts;
}

// ───────────── validation of incoming overrides ─────────────

function validateParam(def: AlertParamDef, value: unknown): string | null {
  if (value === null) return null;
  switch (def.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${def.label} must be a number`;
      if (def.min !== undefined && value < def.min) return `${def.label} must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `${def.label} must be at most ${def.max}`;
      return null;
    case 'time':
      return parseHhmm(value) === null ? `${def.label} must be HH:mm` : null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${def.label} must be true or false`;
    case 'geofences':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : `${def.label} must be a list of geofence ids`;
  }
}

export interface OverrideInput {
  enabled?: boolean | null;
  params?: Record<string, unknown> | null;
  schedule?: unknown;
  cooldownMin?: number | null;
  severity?: string | null;
  channels?: unknown;
  requireAck?: boolean | null;
}

/** Returns an error message or null. Checks catalogue param types/ranges, schedule, channels and the mandatory rule. */
export function validateOverride(type: string, level: AlertLevel, input: OverrideInput): string | null {
  const def = ALERT_TYPE_MAP[type as AlertTypeCode];
  if (!def) return `Unknown alert type "${type}"`;
  if (def.mandatory && input.enabled === false && level !== 'COMPANY') {
    return `${def.label} is mandatory and can only be switched off at company level`;
  }
  if (input.requireAck === false && isAckMandatory(type)) {
    return `${def.label} always requires acknowledgement`;
  }
  if (input.params) {
    for (const [key, value] of Object.entries(input.params)) {
      const p = def.params.find((x) => x.key === key);
      if (!p) return `Unknown parameter "${key}" for ${def.label}`;
      const err = validateParam(p, value);
      if (err) return err;
    }
  }
  if (input.schedule !== undefined && input.schedule !== null && !isValidTimeWindow(input.schedule)) {
    return 'Schedule must be {days: [1–7], from: "HH:mm", to: "HH:mm"}';
  }
  if (input.cooldownMin !== undefined && input.cooldownMin !== null) {
    if (!Number.isInteger(input.cooldownMin) || input.cooldownMin < 0 || input.cooldownMin > 1440) {
      return 'Cooldown must be 0–1440 minutes';
    }
  }
  if (input.severity !== undefined && input.severity !== null && !ALERT_SEVERITIES.includes(input.severity as AlertSeverity)) {
    return 'Unknown severity';
  }
  if (input.channels !== undefined && input.channels !== null) {
    if (typeof input.channels !== 'object' || Array.isArray(input.channels)) return 'Channels must be {SEVERITY: [channels]}';
    for (const [sev, list] of Object.entries(input.channels as Record<string, unknown>)) {
      if (!ALERT_SEVERITIES.includes(sev as AlertSeverity)) return `Unknown severity "${sev}" in channels`;
      if (list === null) continue;
      if (!Array.isArray(list) || !list.every((c) => NOTIFY_CHANNELS.includes(c as NotifyChannel))) {
        return `Channels for ${sev} must be a list of ${NOTIFY_CHANNELS.join('/')}`;
      }
    }
  }
  return null;
}

/** Parse a DB row's JSON columns into a SettingOverride. */
export function toOverride(row: {
  enabled: boolean | null;
  params: unknown;
  schedule: unknown;
  cooldownMin: number | null;
  severity: string | null;
  channels: unknown;
  requireAck?: boolean | null;
}): SettingOverride {
  const params = typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params) ? (row.params as Record<string, unknown>) : {};
  return {
    enabled: row.enabled,
    params,
    schedule: isValidTimeWindow(row.schedule) ? row.schedule : null,
    cooldownMin: row.cooldownMin,
    severity: (row.severity as AlertSeverity | null) ?? null,
    channels:
      typeof row.channels === 'object' && row.channels !== null && !Array.isArray(row.channels)
        ? (row.channels as Partial<ChannelsBySeverity>)
        : null,
    requireAck: row.requireAck ?? null,
  };
}
