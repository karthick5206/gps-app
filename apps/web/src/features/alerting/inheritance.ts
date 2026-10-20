/**
 * Field-by-field inheritance for alert settings as shown in the UI (no runtime imports: node --test friendly).
 * Chain order: most general first (Company → Branch → Group → Object); the most specific non-null value wins.
 * Object-level effective values come from the API (`/alert-settings/effective`); this resolver is used for the
 * Company/Branch/Group screens and to explain where a value comes from.
 */
import type { AlertLevel, AlertSeverity, AlertSettingDto, ChannelsBySeverity, NotifyChannel, TimeWindow } from '@veetracer/shared';

export type Source = AlertLevel | 'DEFAULT';

export interface SourceRef {
  level: Source;
  /** Display name of the level target (branch name, group name…), when known. */
  name?: string | null;
}

export type StoredSetting = Pick<AlertSettingDto, 'enabled' | 'params' | 'schedule' | 'cooldownMin' | 'severity' | 'channels'> & Partial<Pick<AlertSettingDto, 'requireAck'>>;

export interface ChainLink {
  level: AlertLevel;
  name?: string | null;
  row?: StoredSetting | null;
}

export interface Defaults {
  enabled: boolean;
  severity: AlertSeverity;
  cooldownMin: number;
  params: Record<string, unknown>;
  channels: ChannelsBySeverity;
  /** Default "require acknowledgement" for the resolved severity (shared `defaultRequireAck`); absent = false. */
  requireAck?: (severity: AlertSeverity) => boolean;
  /** SOS / crash: always required, can't be turned off. */
  ackMandatory?: boolean;
}

export interface Resolved {
  enabled: boolean;
  severity: AlertSeverity;
  cooldownMin: number;
  schedule: TimeWindow | null;
  params: Record<string, unknown>;
  channels: ChannelsBySeverity;
  requireAck: boolean;
  /** 'enabled' | 'severity' | 'cooldownMin' | 'schedule' | 'params.<key>' | 'channels.<SEVERITY>' → origin. */
  sources: Record<string, SourceRef>;
}

const SEVERITIES: AlertSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

export function resolveChain(defaults: Defaults, chain: ChainLink[]): Resolved {
  const out: Resolved = {
    enabled: defaults.enabled,
    severity: defaults.severity,
    cooldownMin: defaults.cooldownMin,
    schedule: null,
    params: { ...defaults.params },
    channels: { ...defaults.channels },
    requireAck: false,
    sources: {},
  };
  let requireAck: { value: boolean; src: SourceRef } | null = null;
  const def: SourceRef = { level: 'DEFAULT' };
  out.sources.enabled = def;
  out.sources.severity = def;
  out.sources.cooldownMin = def;
  out.sources.schedule = def;
  for (const k of Object.keys(defaults.params)) out.sources[`params.${k}`] = def;
  for (const s of SEVERITIES) out.sources[`channels.${s}`] = def;

  for (const link of chain) {
    const r = link.row;
    if (!r) continue;
    const src: SourceRef = { level: link.level, name: link.name ?? null };
    if (r.enabled !== null && r.enabled !== undefined) {
      out.enabled = r.enabled;
      out.sources.enabled = src;
    }
    if (r.severity) {
      out.severity = r.severity;
      out.sources.severity = src;
    }
    if (r.cooldownMin !== null && r.cooldownMin !== undefined) {
      out.cooldownMin = r.cooldownMin;
      out.sources.cooldownMin = src;
    }
    if (r.schedule) {
      out.schedule = r.schedule;
      out.sources.schedule = src;
    }
    for (const [k, v] of Object.entries(r.params ?? {})) {
      if (v === undefined) continue;
      out.params[k] = v;
      out.sources[`params.${k}`] = src;
    }
    for (const s of SEVERITIES) {
      const ch = r.channels?.[s];
      if (ch) {
        out.channels[s] = ch;
        out.sources[`channels.${s}`] = src;
      }
    }
    if (r.requireAck !== null && r.requireAck !== undefined) requireAck = { value: r.requireAck, src };
  }
  // The default follows the resolved severity (CRITICAL alerts need acknowledgement); SOS / crash always.
  if (defaults.ackMandatory || !requireAck) {
    out.requireAck = defaults.ackMandatory ? true : (defaults.requireAck?.(out.severity) ?? false);
    out.sources.requireAck = def;
  } else {
    out.requireAck = requireAck.value;
    out.sources.requireAck = requireAck.src;
  }
  return out;
}

const LEVEL_LABEL: Record<Source, string> = {
  DEFAULT: 'Default',
  COMPANY: 'Company',
  BRANCH: 'Branch',
  GROUP: 'Group',
  OBJECT: 'Vehicle',
};

export function levelLabel(level: Source): string {
  return LEVEL_LABEL[level];
}

/** Translator for UI text; the default fills `{{vars}}` into the English key (keeps this file import-free for tests). */
export type Translate = (key: string, vars?: Record<string, string>) => string;
const plain: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars?.[k] ?? '');

/**
 * Badge text for a field shown at `viewLevel`: "Set here", "Default", "Inherited from Company",
 * "Inherited from Branch: Chennai".
 */
export function sourceText(src: SourceRef | undefined, viewLevel: AlertLevel, t: Translate = plain): string {
  if (!src || src.level === 'DEFAULT') return t('Default');
  if (src.level === viewLevel) return t('Set here');
  const label = t(LEVEL_LABEL[src.level]);
  return src.name ? t('Inherited from {{level}}: {{name}}', { level: label, name: src.name }) : t('Inherited from {{level}}', { level: label });
}

export function isOverriddenHere(src: SourceRef | undefined, viewLevel: AlertLevel): boolean {
  return !!src && src.level === viewLevel;
}

/** Builds the PUT body for one setting row; a row whose fields are all null/empty means "delete" (reset to inherited). */
export function toPutBody(level: AlertLevel, targetId: string, alertType: string, row: StoredSetting) {
  const params = row.params && Object.keys(row.params).length ? row.params : null;
  const channels = row.channels && Object.keys(row.channels).length ? row.channels : null;
  return {
    level,
    targetId,
    alertType,
    enabled: row.enabled ?? null,
    params,
    schedule: row.schedule ?? null,
    cooldownMin: row.cooldownMin ?? null,
    severity: row.severity ?? null,
    channels,
    requireAck: row.requireAck ?? null,
  };
}

export function isEmptyRow(row: StoredSetting): boolean {
  const b = toPutBody('COMPANY', '', '', row);
  return b.enabled === null && b.params === null && b.schedule === null && b.cooldownMin === null && b.severity === null && b.channels === null && b.requireAck === null;
}

/** Removes one field override from a stored row ('params.x', 'channels.WARNING', 'enabled', …). */
export function clearField(row: StoredSetting, field: string): StoredSetting {
  const next: StoredSetting = { ...row, params: { ...(row.params ?? {}) }, channels: row.channels ? { ...row.channels } : null };
  if (field.startsWith('params.')) delete next.params[field.slice(7)];
  else if (field.startsWith('channels.')) {
    if (next.channels) delete next.channels[field.slice(9) as AlertSeverity];
  } else if (field === 'enabled') next.enabled = null;
  else if (field === 'severity') next.severity = null;
  else if (field === 'cooldownMin') next.cooldownMin = null;
  else if (field === 'schedule') next.schedule = null;
  else if (field === 'requireAck') next.requireAck = null;
  return next;
}

export function sameChannels(a: NotifyChannel[] | undefined, b: NotifyChannel[] | undefined): boolean {
  const x = [...(a ?? [])].sort().join();
  const y = [...(b ?? [])].sort().join();
  return x === y;
}

export const EMPTY_ROW: StoredSetting = { enabled: null, params: {}, schedule: null, cooldownMin: null, severity: null, channels: null, requireAck: null };
