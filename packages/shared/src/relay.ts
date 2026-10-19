/**
 * Data forwarding (Super Admin → Platform → Data forwarding): copies of device data sent to other servers.
 *  - RAW_TCP: the gateway mirrors each device connection's original bytes to host:port (one upstream connection per
 *    device connection, login frames replayed first).
 *  - HTTP_JSON: the notifier posts signed batches of normalised positions (optionally alerts) to an https URL.
 */

export const RELAY_TARGET_TYPES = ['RAW_TCP', 'HTTP_JSON'] as const;
export type RelayTargetType = (typeof RELAY_TARGET_TYPES)[number];

export const RELAY_SCOPES = ['ALL', 'COMPANY', 'DEVICES', 'PROTOCOL'] as const;
export type RelayScope = (typeof RELAY_SCOPES)[number];

export const RELAY_AUTH_TYPES = ['NONE', 'BEARER', 'BASIC'] as const;
export type RelayAuthType = (typeof RELAY_AUTH_TYPES)[number];

/** Gateway protocol ids a PROTOCOL scope can name. */
export const RELAY_PROTOCOLS = ['gt06', 'teltonika', 'jt808', 'ais140'] as const;

/** Max devices in a DEVICES scope. */
export const RELAY_MAX_SCOPE_DEVICES = 1000;

/** A target counts as failing (System Health warning) after this long without success. */
export const RELAY_FAILING_WARN_SEC = 300;

/** Live counters of one target in one process (gateway for RAW_TCP, notifier for HTTP_JSON), sent in heartbeats. */
export interface RelayTargetStats {
  id: string;
  name: string;
  type: RelayTargetType;
  /** Open upstream connections (RAW_TCP). */
  connected: number;
  /** Device connections currently forwarded (RAW_TCP; includes those waiting to reconnect). */
  sessions: number;
  bytes: number;
  /** Chunks (RAW_TCP) or positions + alerts (HTTP_JSON) forwarded since start. */
  frames: number;
  /** Bytes (RAW_TCP) or items (HTTP_JSON) waiting while the target is unreachable. */
  queued: number;
  /** Dropped because the buffer was full (oldest first) or the socket limit was reached. */
  dropped: number;
  lastSuccessAt: string | null;
  lastError: { message: string; at: string } | null;
  /** Start of the current failure streak (no success since), null when healthy. */
  failingSince: string | null;
  recentErrors: { message: string; at: string }[];
}

/** Resolved rule as published by the API to Valkey for the gateway / notifier (`vt:relay:rules`). */
export interface RelayRuleSpec {
  id: string;
  name: string;
  type: RelayTargetType;
  host: string | null;
  port: number | null;
  passDownstream: boolean;
  url: string | null;
  /** Ready-made Authorization header value, or null. */
  authorization: string | null;
  secret: string;
  includeAlerts: boolean;
  scope: RelayScope;
  protocol: string | null;
  companyId: string | null;
  /** Device unique ids (IMEI) of a COMPANY / DEVICES scope; null for ALL / PROTOCOL. */
  uniqueIds: string[] | null;
  /** Tracked objects of a DEVICES scope (alert matching); null otherwise. */
  objectIds: string[] | null;
  liveOnly: boolean;
  validOnly: boolean;
}

export interface RelayRuleSet {
  at: string;
  rules: RelayRuleSpec[];
  /** Master switch off: no rules are published, so nothing is forwarded. */
  paused?: boolean;
}

export interface RelayTargetDto {
  id: string;
  name: string;
  type: RelayTargetType;
  enabled: boolean;
  host: string | null;
  port: number | null;
  passDownstream: boolean;
  url: string | null;
  authType: RelayAuthType;
  /** True when an auth value is stored (never returned). */
  hasAuth: boolean;
  /** Start of the signing secret (`whsec_ab12`). */
  secretPreview: string;
  includeAlerts: boolean;
  scope: RelayScope;
  companyId: string | null;
  companyName: string | null;
  deviceIds: string[];
  /** Unique ids of `deviceIds` (for the picker chips). */
  devices: { id: string; uniqueId: string }[];
  protocol: string | null;
  liveOnly: boolean;
  validOnly: boolean;
  createdAt: string;
  updatedAt: string;
  /** Aggregated over all gateway / notifier instances; null when no process reported it. */
  stats: RelayTargetStats | null;
  status: 'OK' | 'FAILING' | 'IDLE' | 'DISABLED';
}

export interface RelayTargetInput {
  name: string;
  type: RelayTargetType;
  enabled: boolean;
  host?: string | null;
  port?: number | null;
  passDownstream?: boolean;
  url?: string | null;
  authType?: RelayAuthType;
  /** Omit to keep the stored value; empty string clears it. */
  authValue?: string | null;
  includeAlerts?: boolean;
  scope: RelayScope;
  companyId?: string | null;
  deviceIds?: string[];
  protocol?: string | null;
  liveOnly?: boolean;
  validOnly?: boolean;
}

export interface RelayTestResult {
  ok: boolean;
  message: string;
  durationMs: number;
  status?: number | null;
}

/**
 * Protocols whose upstream replies may be passed to the device (RAW_TCP `passDownstream`). AIS-140 is a text protocol
 * where VeeTrax only sends short ACKs (login, some vendor variants' location ACKs) that devices tolerate twice; the
 * binary protocols (GT06 serials, JT808 flow numbers, Teltonika record counts) would be corrupted by a second server.
 */
export const RELAY_PASS_DOWNSTREAM_PROTOCOLS: readonly string[] = ['ais140'];
