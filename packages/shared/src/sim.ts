/**
 * SIM management (Phase C): statuses, the allowed-transition table, ICCID / MSISDN normalisation and DTOs.
 *
 * SIM code never writes Device rows: the tracker-reported Device.iccid and the free-text Device.simNumber /
 * simOperator stay as they are and are only *compared* with the managed SIM (reconciliation). SIMs have no link to
 * licence seats or to the customer assignment of a device.
 */

export const SIM_STATUSES = ['AVAILABLE', 'RESERVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'DEACTIVATED', 'DAMAGED'] as const;
export type SimStatus = (typeof SIM_STATUSES)[number];

export const SIM_STATUS_LABELS: Record<SimStatus, string> = {
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  EXPIRED: 'Expired',
  DEACTIVATED: 'Deactivated',
  DAMAGED: 'Damaged',
};

/**
 * Allowed status changes (from → to). DEACTIVATED is terminal. EXPIRED → ACTIVE is a renewal. DAMAGED can only be
 * deactivated (written off).
 */
export const SIM_TRANSITIONS: Record<SimStatus, readonly SimStatus[]> = {
  AVAILABLE: ['RESERVED', 'ACTIVE', 'DAMAGED', 'DEACTIVATED'],
  RESERVED: ['AVAILABLE', 'ACTIVE', 'DAMAGED', 'DEACTIVATED'],
  ACTIVE: ['SUSPENDED', 'EXPIRED', 'DEACTIVATED', 'DAMAGED'],
  SUSPENDED: ['ACTIVE', 'EXPIRED', 'DEACTIVATED', 'DAMAGED'],
  EXPIRED: ['ACTIVE', 'DEACTIVATED'],
  DEACTIVATED: [],
  DAMAGED: ['DEACTIVATED'],
};

/** A change into one of these needs a written reason. */
export const SIM_REASON_REQUIRED: readonly SimStatus[] = ['SUSPENDED', 'DEACTIVATED', 'DAMAGED'];

/** A SIM in one of these may be fitted to a device. */
export const SIM_ASSIGNABLE: readonly SimStatus[] = ['AVAILABLE', 'RESERVED', 'ACTIVE', 'SUSPENDED'];

/** A SIM must be taken out of its device before moving into one of these. */
export const SIM_UNASSIGNED_ONLY: readonly SimStatus[] = ['DEACTIVATED', 'DAMAGED'];

export const SIM_PROVIDER_KINDS = ['MNO', 'M2M_AGGREGATOR', 'ESIM'] as const;
export type SimProviderKind = (typeof SIM_PROVIDER_KINDS)[number];

/** QI-4 (open): all three supported for tracking; BYO SIMs are tracking only. */
export const SIM_OWNERSHIPS = ['PLATFORM', 'PARTNER', 'CUSTOMER'] as const;
export type SimOwnership = (typeof SIM_OWNERSHIPS)[number];

export const SIM_EVENT_KINDS = ['REGISTER', 'STATUS', 'ASSIGN', 'UNASSIGN', 'RENEW', 'EDIT', 'USAGE'] as const;
export type SimEventKind = (typeof SIM_EVENT_KINDS)[number];

export function isSimStatus(v: unknown): v is SimStatus {
  return typeof v === 'string' && (SIM_STATUSES as readonly string[]).includes(v);
}

export function canSimTransition(from: SimStatus, to: SimStatus): boolean {
  return SIM_TRANSITIONS[from].includes(to);
}

/** The single rule set for a SIM status change. Returns an error message or null. */
export function validateSimStatusChange(input: { from: SimStatus; to: SimStatus; assigned: boolean; reason?: string | null }): string | null {
  const { from, to, assigned } = input;
  if (!isSimStatus(to)) return `Unknown SIM status "${String(to)}"`;
  if (from === to) return `The SIM is already ${SIM_STATUS_LABELS[to].toLowerCase()}`;
  if (!canSimTransition(from, to)) return `Cannot change a SIM from ${SIM_STATUS_LABELS[from]} to ${SIM_STATUS_LABELS[to]}`;
  if (SIM_REASON_REQUIRED.includes(to) && !input.reason?.trim()) return `A reason is required to mark a SIM ${SIM_STATUS_LABELS[to].toLowerCase()}`;
  if (assigned && SIM_UNASSIGNED_ONLY.includes(to)) return 'Take the SIM out of its device first';
  return null;
}

/**
 * ICCID: 18–22 digits once spaces / dashes and a trailing filler "F" are removed (ITU-T E.118 allows 19–20; some
 * operators print 18 or 22). Returns null when the value is not a plausible ICCID.
 */
export function normalizeIccid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/[\s-]/g, '').replace(/[fF]$/, '');
  return /^\d{18,22}$/.test(v) ? v : null;
}

/** MSISDN: digits only (a leading "+" is dropped), 8–15 digits (E.164). */
export function normalizeMsisdn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  return /^\d{8,15}$/.test(v) ? v : null;
}

/** Days until the renewal date (negative = overdue); null when no date. */
export function simDaysUntil(date: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (!date) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;
  const startOfDay = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  return Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
}

export type SimRenewalState = 'NONE' | 'OK' | 'DUE_SOON' | 'OVERDUE';

/** Renewal reminder bucket shown in lists (no outbound messaging). */
export function renewalState(date: string | Date | null | undefined, withinDays = 30, now: Date = new Date()): SimRenewalState {
  const d = simDaysUntil(date, now);
  if (d === null) return 'NONE';
  if (d < 0) return 'OVERDUE';
  return d <= withinDays ? 'DUE_SOON' : 'OK';
}

// ───────────── DTOs ─────────────

export interface SimProviderDto {
  id: string;
  name: string;
  kind: SimProviderKind;
  supportContact: Record<string, string>;
  isActive: boolean;
  simCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SimPlanDto {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  dataMbPerMonth: number | null;
  smsPerMonth: number | null;
  validityDays: number;
  /** What VeeTrax pays (never shown to tenants). */
  costPaise: number;
  /** Customer price if SIMs are billed (QI-3 open: null = not billed). */
  pricePaise: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SimCardDto {
  id: string;
  iccid: string;
  msisdn: string | null;
  imsi: string | null;
  provider: { id: string; name: string };
  plan: { id: string; name: string; validityDays: number; costPaise: number } | null;
  status: SimStatus;
  ownership: SimOwnership;
  location: { id: string; code: string; name: string } | null;
  activatedAt: string | null;
  renewalDueAt: string | null;
  renewalState: SimRenewalState;
  statusChangedAt: string;
  note: string | null;
  /** Current device (open SimAssignment), with the existing device fields read-only for reconciliation. */
  device: {
    id: string;
    uniqueId: string;
    companyName: string | null;
    reportedIccid: string | null;
    simNumber: string | null;
    assignedAt: string;
  } | null;
  /** Reported ICCID / SIM number on the device disagree with this SIM (report only, never rewritten). */
  reconcile: SimReconcileFlag[];
  createdAt: string;
  updatedAt: string;
}

export type SimReconcileFlag = 'ICCID_DIFFERS' | 'MSISDN_DIFFERS';

export interface SimEventDto {
  id: string;
  simId: string | null;
  iccidRef: string;
  kind: SimEventKind;
  fromStatus: SimStatus | null;
  toStatus: SimStatus | null;
  deviceId: string | null;
  deviceRef: string | null;
  reason: string | null;
  note: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  at: string;
  createdByName: string | null;
}

export interface SimAssignmentDto {
  id: string;
  deviceId: string | null;
  deviceRef: string;
  fromTime: string;
  toTime: string | null;
}

export interface SimUsageDto {
  id: string;
  simId: string;
  periodStart: string;
  periodEnd: string;
  dataMb: number | null;
  smsCount: number | null;
  costPaise: number | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface SimSummaryDto {
  byStatus: Record<SimStatus, number>;
  byProvider: { providerId: string; name: string; count: number }[];
  assigned: number;
  renewalsDue: number;
  renewalsOverdue: number;
  reconcileIssues: number;
  /** Sum of the plan cost of ACTIVE / SUSPENDED SIMs per validity period (recorded plans only). */
  activePlanCostPaise: number;
}

export type SimImportAction = 'CREATE' | 'ERROR';

export interface SimImportReport {
  dryRun: boolean;
  applied: boolean;
  summary: { rows: number; create: number; errors: number };
  rows: { line: number; iccid: string | null; action: SimImportAction; errors: string[] }[];
}

/** Tenant read-only view (QI-21 option A, behind a platform flag): never cost, plan price or provider contract data. */
export interface TenantSimView {
  msisdn: string | null;
  status: SimStatus;
  renewalDueAt: string | null;
}

export interface AssetDeviceView {
  deviceId: string;
  uniqueId: string;
  modelName: string;
  /** Existing tenant-editable device field. */
  simNumber: string | null;
  fittedAt: string;
  licence: { status: 'NO_SEAT' | 'ACTIVE' | 'EXPIRED'; expiresAt: string | null };
  sim: TenantSimView | null;
}

export interface AssetLinksDto {
  objectId: string;
  objectName: string;
  devices: AssetDeviceView[];
  /** Whether SIM details are enabled for tenants (QI-21). */
  simVisible: boolean;
}
