/** Vehicle / driver documents (RC, insurance, PUC…) with expiry reminders, and service (maintenance) reminders. */

export type DocumentOwner = 'VEHICLE' | 'DRIVER';

/** DOCUMENT_TYPE lookup codes (seeded); `owner` = who the document normally belongs to. */
export const DOCUMENT_TYPES = [
  { code: 'RC', label: 'Registration certificate (RC)', owner: 'VEHICLE' },
  { code: 'INSURANCE', label: 'Insurance', owner: 'VEHICLE' },
  { code: 'PUC', label: 'Pollution certificate (PUC)', owner: 'VEHICLE' },
  { code: 'FITNESS', label: 'Fitness certificate', owner: 'VEHICLE' },
  { code: 'PERMIT', label: 'Permit', owner: 'VEHICLE' },
  { code: 'ROAD_TAX', label: 'Road tax', owner: 'VEHICLE' },
  { code: 'DRIVING_LICENCE', label: 'Driving licence', owner: 'DRIVER' },
] as const satisfies readonly { code: string; label: string; owner: DocumentOwner }[];

/** English label of a document type code (company lookup codes fall back to a humanised code). */
export function documentTypeLabel(code: string): string {
  const known = DOCUMENT_TYPES.find((t) => t.code === code);
  if (known) return known.label;
  const s = code.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Days before expiry when reminders start (per document, editable). */
export const DEFAULT_REMINDER_DAYS = 30;
/** Upload limits for document scans / photos. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** VALID, EXPIRING (within its reminder window), EXPIRED, or NO_EXPIRY (no expiry date recorded). */
export type DocumentStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NO_EXPIRY';
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['VALID', 'EXPIRING', 'EXPIRED', 'NO_EXPIRY'];

const DAY_MS = 86_400_000;
const ymdMs = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((ymdMs(to) - ymdMs(from)) / DAY_MS);
}

/** `ymd` plus `days` (YYYY-MM-DD). */
export function addDays(ymd: string, days: number): string {
  return new Date(ymdMs(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Status of a document on `today` (YYYY-MM-DD in the company timezone). A document is valid through its expiry day;
 * it is EXPIRING from `reminderDays` before it, and EXPIRED the day after.
 */
export function documentStatus(expiresOn: string | null, reminderDays: number, today: string): { status: DocumentStatus; daysLeft: number | null } {
  if (!expiresOn) return { status: 'NO_EXPIRY', daysLeft: null };
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) return { status: 'EXPIRED', daysLeft };
  if (daysLeft <= Math.max(0, reminderDays)) return { status: 'EXPIRING', daysLeft };
  return { status: 'VALID', daysLeft };
}

export interface DocumentFileDto {
  name: string;
  type: string;
  size: number;
}

export interface DocumentDto {
  id: string;
  owner: DocumentOwner;
  objectId: string | null;
  objectName: string | null;
  plateNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  type: string;
  number: string | null;
  /** YYYY-MM-DD */
  issuedOn: string | null;
  /** YYYY-MM-DD */
  expiresOn: string | null;
  reminderDays: number;
  notes: string | null;
  file: DocumentFileDto | null;
  status: DocumentStatus;
  daysLeft: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRequest {
  objectId?: string | null;
  driverId?: string | null;
  type: string;
  number?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  reminderDays?: number;
  notes?: string | null;
}

// ───────────── Service reminders ─────────────

/** OK, DUE_SOON (inside the notify-before window), OVERDUE (past the due date or odometer). */
export type ServiceStatus = 'OK' | 'DUE_SOON' | 'OVERDUE';
export const SERVICE_STATUSES: readonly ServiceStatus[] = ['OK', 'DUE_SOON', 'OVERDUE'];
export const DEFAULT_NOTIFY_BEFORE_DAYS = 7;
export const DEFAULT_NOTIFY_BEFORE_KM = 500;

export interface ServiceSchedule {
  intervalKm: number | null;
  intervalDays: number | null;
  /** YYYY-MM-DD */
  lastDoneAt: string | null;
  lastDoneOdometerKm: number | null;
}

/** Next due date / odometer: last service plus each interval (null when that interval or its starting point is missing). */
export function serviceDue(s: ServiceSchedule): { dueAt: string | null; dueOdometerKm: number | null } {
  return {
    dueAt: s.intervalDays && s.lastDoneAt ? addDays(s.lastDoneAt, s.intervalDays) : null,
    dueOdometerKm: s.intervalKm && s.lastDoneOdometerKm !== null ? Math.round((s.lastDoneOdometerKm + s.intervalKm) * 10) / 10 : null,
  };
}

/** Status by date and/or odometer, whichever comes first. */
export function serviceStatus(
  s: { dueAt: string | null; dueOdometerKm: number | null; notifyBeforeDays: number; notifyBeforeKm: number },
  today: string,
  odometerKm: number | null,
): { status: ServiceStatus; daysLeft: number | null; kmLeft: number | null } {
  const daysLeft = s.dueAt ? daysBetween(today, s.dueAt) : null;
  const kmLeft = s.dueOdometerKm !== null && odometerKm !== null ? Math.round((s.dueOdometerKm - odometerKm) * 10) / 10 : null;
  let status: ServiceStatus = 'OK';
  if ((daysLeft !== null && daysLeft < 0) || (kmLeft !== null && kmLeft <= 0)) status = 'OVERDUE';
  else if ((daysLeft !== null && daysLeft <= s.notifyBeforeDays) || (kmLeft !== null && kmLeft <= s.notifyBeforeKm)) status = 'DUE_SOON';
  return { status, daysLeft, kmLeft };
}

export interface ServiceReminderDto {
  id: string;
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  title: string;
  intervalKm: number | null;
  intervalDays: number | null;
  lastDoneAt: string | null;
  lastDoneOdometerKm: number | null;
  dueAt: string | null;
  dueOdometerKm: number | null;
  notifyBeforeKm: number;
  notifyBeforeDays: number;
  notes: string | null;
  isActive: boolean;
  /** Vehicle odometer now: distance recorded by VeeTrax plus the vehicle's odometer offset. */
  odometerKm: number | null;
  status: ServiceStatus;
  daysLeft: number | null;
  kmLeft: number | null;
  /** Vehicle is in maintenance (workshop) right now. */
  inMaintenance: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceReminderRequest {
  objectId: string;
  title: string;
  intervalKm?: number | null;
  intervalDays?: number | null;
  lastDoneAt?: string | null;
  lastDoneOdometerKm?: number | null;
  notifyBeforeKm?: number;
  notifyBeforeDays?: number;
  notes?: string | null;
  isActive?: boolean;
}

/** POST /service-reminders/:id/done */
export interface ServiceDoneRequest {
  /** YYYY-MM-DD, default today. */
  doneAt?: string;
  /** Default: the vehicle's odometer now. */
  odometerKm?: number | null;
  cost?: number | null;
  notes?: string | null;
  /** Also take the vehicle out of maintenance. */
  endMaintenance?: boolean;
}

export interface ServiceRecordDto {
  id: string;
  reminderId: string | null;
  objectId: string;
  objectName: string;
  title: string;
  doneAt: string;
  odometerKm: number | null;
  cost: number | null;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** GET /documents/summary: counts for the dashboard. */
export interface ComplianceSummary {
  documentsExpiring: number;
  documentsExpired: number;
  /** Documents expiring before the end of the current month (not yet expired). */
  documentsExpiringThisMonth: number;
  servicesDueSoon: number;
  servicesOverdue: number;
}

/** DOCUMENTS report: one row per document or service reminder. */
export interface DocumentsReportRow {
  kind: 'DOCUMENT' | 'SERVICE';
  vehicle: string | null;
  driver: string | null;
  item: string;
  number: string | null;
  dueOn: string | null;
  dueOdometerKm: number | null;
  daysLeft: number | null;
  kmLeft: number | null;
  status: DocumentStatus | ServiceStatus;
}
