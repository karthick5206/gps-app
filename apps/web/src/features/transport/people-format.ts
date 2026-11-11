/**
 * Pure helpers of the ETMS E2 people screens (passengers, import, consent, app access, seats). No React / DOM / aliases,
 * so `node --test` runs them. Mirrors the server rules in apps/api/src/etms/people (passenger-import.ts
 * parseRowSelection, people.service.ts) without replacing them: the server stays the authority.
 * Docs: docs/employee-transport/05 §2.2–2.3, 02 §7 (original vs rounded coordinates), 10 §4 (consent), 07 §6.1.
 */
import {
  CONSENT_PURPOSES,
  PASSENGER_IMPORT_COLUMNS,
  PASSENGER_IMPORT_MAX_BYTES,
  PASSENGER_IMPORT_MAX_ROWS,
  normalisePhone,
  type ConsentRecordDto,
  type EmergencyContact,
  type HomeLocationSource,
  type PassengerConsentStateDto,
  type PassengerDto,
  type PassengerImportAction,
  type PassengerImportIssueCode,
  type PassengerProjection,
} from '@veetracer/shared';

export type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'muted';

// ───────────────────────────── Import: CSV template, file checks, row selection ─────────────────────────────

/** RFC 4180 cell: quoted when it holds a comma, semicolon, quote or line break. */
export function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One example row, shown in the wizard's column help (never put in the downloadable template, so it is not imported by mistake). */
export const PASSENGER_IMPORT_EXAMPLE: Record<(typeof PASSENGER_IMPORT_COLUMNS)[number], string> = {
  employee_code: 'EMP-1042',
  name: 'Asha Krishnan',
  mobile: '+919876543210',
  email: 'asha.k@example.com',
  home_address: '12 Anna Salai, Chennai',
  home_lat: '13.060412',
  home_lng: '80.249679',
  office: 'HQ Guindy',
  default_stop: '',
  branch: 'Chennai',
  wheelchair: 'no',
  accessibility_notes: '',
  active: 'yes',
};

/** Header-only CSV template with the exact columns the server reads (PASSENGER_IMPORT_COLUMNS), CRLF, UTF-8 BOM for Excel. */
export function passengerImportTemplate(): string {
  return `﻿${PASSENGER_IMPORT_COLUMNS.map(csvCell).join(',')}\r\n`;
}

/** Data rows of a CSV text (header excluded, blank lines ignored, quoted line breaks kept inside their row). */
export function countCsvDataRows(text: string): number {
  let rows = 0;
  let inQuotes = false;
  let hasContent = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      hasContent = true;
    } else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (hasContent) rows++;
      hasContent = false;
      if (c === '\r' && s[i + 1] === '\n') i++;
    } else if (c !== ' ' && c !== '\t' && c !== ',' && c !== ';') {
      hasContent = true;
    }
  }
  if (hasContent) rows++;
  return Math.max(0, rows - 1);
}

export type ImportFileProblem = 'NOT_CSV' | 'TOO_LARGE' | 'EMPTY';

/** Checks before upload (the server checks again): .csv / text/csv, at most 5 MB, not empty. */
export function importFileProblem(file: { name: string; size: number; type?: string }): ImportFileProblem | null {
  if (file.size === 0) return 'EMPTY';
  if (file.size > PASSENGER_IMPORT_MAX_BYTES) return 'TOO_LARGE';
  const csvName = /\.csv$/i.test(file.name);
  const csvType = !file.type || /^(text\/csv|text\/plain|application\/vnd\.ms-excel|application\/csv)$/i.test(file.type);
  return csvName && csvType ? null : 'NOT_CSV';
}

export const IMPORT_FILE_PROBLEM_TEXT: Record<ImportFileProblem | 'TOO_MANY_ROWS', string> = {
  NOT_CSV: 'Choose a .csv file (save Excel sheets as “CSV UTF-8”).',
  TOO_LARGE: 'The file is larger than 5 MB. Split it into smaller files.',
  EMPTY: 'The file is empty.',
  TOO_MANY_ROWS: 'The file has more than 10,000 rows. Split it into smaller files.',
};

export const importLimits = { maxRows: PASSENGER_IMPORT_MAX_ROWS, maxBytes: PASSENGER_IMPORT_MAX_BYTES } as const;

/**
 * Parses a row selection such as "1,3-5" (data row numbers, 1-based) like the server does. Returns the sorted rows or
 * an error text. Empty → [] (meaning "every valid row").
 */
export function parseRowSelection(raw: string, maxRow = PASSENGER_IMPORT_MAX_ROWS): { rows: number[] } | { error: string; part: string } {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p);
    if (!m) return { error: 'Invalid row selection', part: p };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > maxRow) return { error: 'Invalid row range', part: p };
    for (let i = a; i <= b; i++) out.add(i);
  }
  return { rows: [...out].sort((x, y) => x - y) };
}

/** [1, 3, 4, 5, 9] → "1,3-5,9" (the compact form sent as `rows`). */
export function formatRowSelection(rows: Iterable<number>): string {
  const sorted = [...new Set(rows)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j === i ? String(sorted[i]) : j === i + 1 ? `${sorted[i]},${sorted[j]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

export const IMPORT_ACTION_META: Record<PassengerImportAction, { label: string; tone: Tone }> = {
  CREATE: { label: 'New', tone: 'success' },
  UPDATE: { label: 'Update', tone: 'info' },
  UNCHANGED: { label: 'Unchanged', tone: 'muted' },
  ERROR: { label: 'Error', tone: 'destructive' },
  SKIPPED: { label: 'Skipped', tone: 'neutral' },
};

export const IMPORT_ISSUE_LABEL: Record<PassengerImportIssueCode, string> = {
  REQUIRED: 'Required value missing',
  INVALID_MOBILE: 'Invalid mobile number',
  INVALID_EMAIL: 'Invalid email address',
  INVALID_COORDINATES: 'Invalid coordinates',
  INVALID_VALUE: 'Invalid value',
  TOO_LONG: 'Value too long',
  UNKNOWN_SITE: 'Unknown office / site',
  UNKNOWN_STOP: 'Unknown pickup stop',
  UNKNOWN_BRANCH: 'Unknown branch',
  DUPLICATE_EMPLOYEE_CODE: 'Duplicate employee code',
  DUPLICATE_EMAIL: 'Duplicate email',
  DUPLICATE_MOBILE: 'Duplicate mobile number',
  GEOCODE_NO_RESULT: 'Address not found',
  GEOCODE_LOW_CONFIDENCE: 'Address match is uncertain',
  NO_LOCATION: 'No location yet',
};

/** Rows that a commit would write: no blocking error and something to change. */
export function committableRows(rows: { row: number; action: PassengerImportAction }[]): number[] {
  return rows.filter((r) => r.action === 'CREATE' || r.action === 'UPDATE').map((r) => r.row);
}

// ───────────────────────────── Passenger view model ─────────────────────────────

export const HOME_SOURCE_LABEL: Record<HomeLocationSource, string> = {
  PIN: 'Pinned on the map',
  PHOTON: 'From the address search',
  IMPORT: 'From an import file',
  TYPED: 'Typed coordinates',
};

/** The server rounds the home point for every projection but FULL (doc 02 §4.2): show it as approximate, never as exact. */
export const isApproximate = (projection: PassengerProjection): boolean => projection !== 'FULL';

/** Decimals the server sent: 6 for FULL, 4 (about 11 m) otherwise. Never pad a rounded value to fake precision. */
export const coordDecimals = (projection: PassengerProjection): 4 | 6 => (projection === 'FULL' ? 6 : 4);

export function formatCoords(lat: number | null | undefined, lng: number | null | undefined, projection: PassengerProjection): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const d = coordDecimals(projection);
  return `${lat.toFixed(d)}, ${lng.toFixed(d)}`;
}

export type LocationKind = 'NEEDS_LOCATION' | 'STOP' | 'HOME' | 'HOME_APPROX' | 'HOME_HIDDEN' | 'NONE';

export interface LocationStatus {
  kind: LocationKind;
  label: string;
  tone: Tone;
  /** Extra text for a tooltip / sub-line, as an i18n key with vars. */
  detail?: { key: string; vars?: Record<string, string> };
}

/** Location badge of a passenger row / editor header. */
export function locationStatus(p: Pick<PassengerDto, 'projection' | 'needsLocation' | 'hasHomeLocation' | 'defaultStop' | 'home' | 'isActive'>): LocationStatus {
  if (p.needsLocation) return { kind: 'NEEDS_LOCATION', label: 'Needs location', tone: 'warning', detail: { key: 'No home point and no pickup stop yet.' } };
  if (p.defaultStop) return { kind: 'STOP', label: 'Pickup stop', tone: 'info', detail: { key: 'Picked up at {{name}}', vars: { name: p.defaultStop.name } } };
  if (p.hasHomeLocation) {
    if (!p.home || p.home.lat === null) return { kind: 'HOME_HIDDEN', label: 'Home set', tone: 'neutral', detail: { key: 'The home point is not shown to your role.' } };
    if (isApproximate(p.projection)) return { kind: 'HOME_APPROX', label: 'Home (approximate)', tone: 'neutral', detail: { key: 'Rounded to about 11 m for your role.' } };
    return { kind: 'HOME', label: 'Home pinned', tone: 'success' };
  }
  return { kind: 'NONE', label: 'No location', tone: 'muted' };
}

// ───────────────────────────── Consent ─────────────────────────────

export const CONSENT_PURPOSE_META: Record<(typeof CONSENT_PURPOSES)[number], { label: string; description: string }> = {
  TRANSPORT_PROFILE: {
    label: 'Transport planning',
    description: 'The home location and profile may be used to plan this employee’s pickups. Without it, no location of the employee is used for routing.',
  },
  PICKUP_LOCATION_SHARE: { label: 'Live pickup location', description: 'The employee may share their live location around a pickup.' },
  SOS_LOCATION: { label: 'SOS location', description: 'The location is sent with an SOS alert.' },
  NOTIFICATIONS_SMS: { label: 'SMS notifications', description: 'Trip updates may be sent by SMS.' },
};

export const consentPurposeLabel = (purpose: string): string => CONSENT_PURPOSE_META[purpose as keyof typeof CONSENT_PURPOSE_META]?.label ?? purpose;

export const CONSENT_CHANNEL_LABEL: Record<string, string> = {
  WEB: 'Web',
  PASSENGER_APP: 'Passenger app',
  ADMIN_ON_BEHALF: 'Admin on behalf',
};
export const consentChannelLabel = (channel: string | null | undefined): string => (channel ? (CONSENT_CHANNEL_LABEL[channel] ?? channel) : '—');

/** Status of one purpose: granted / withdrawn / never recorded. */
export function consentStatus(state: Pick<PassengerConsentStateDto, 'active' | 'revokedAt'> | null | undefined): { label: string; tone: Tone } {
  if (state?.active) return { label: 'Granted', tone: 'success' };
  if (state?.revokedAt) return { label: 'Withdrawn', tone: 'destructive' };
  return { label: 'Not recorded', tone: 'warning' };
}

/** List badge for routing consent (TRANSPORT_PROFILE). */
export function routingConsentBadge(active: boolean): { label: string; tone: Tone } {
  return active ? { label: 'Consent given', tone: 'success' } : { label: 'No consent', tone: 'warning' };
}

/** The current state per purpose in the fixed purpose order (purposes never recorded included, as null). */
export function consentRows(current: PassengerConsentStateDto[] | null | undefined): { purpose: (typeof CONSENT_PURPOSES)[number]; state: PassengerConsentStateDto | null }[] {
  return CONSENT_PURPOSES.map((purpose) => ({ purpose, state: current?.find((c) => c.purpose === purpose) ?? null }));
}

/** History newest first. */
export function consentTimeline(history: ConsentRecordDto[] | null | undefined): ConsentRecordDto[] {
  return [...(history ?? [])].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

/** Notice version suggested when recording consent: the one already on record for the purpose, else the first version. */
export const DEFAULT_NOTICE_VERSION = 'v1';
export function suggestedNoticeVersion(state: Pick<PassengerConsentStateDto, 'noticeVersion'> | null | undefined, history?: ConsentRecordDto[] | null): string {
  return state?.noticeVersion ?? consentTimeline(history)[0]?.noticeVersion ?? DEFAULT_NOTICE_VERSION;
}

// ───────────────────────────── App access / identity errors ─────────────────────────────

export type PeopleErrorKind = 'identity' | 'state' | 'duplicate' | 'forbidden' | 'geocoder' | 'format' | 'validation' | 'other';

export function peopleErrorKind(code: string | null | undefined): PeopleErrorKind {
  switch (code) {
    case 'IDENTITY_IN_USE':
      return 'identity';
    case 'INVALID_STATE':
      return 'state';
    case 'PASSENGER_DUPLICATE':
      return 'duplicate';
    case 'FORBIDDEN_GRANT':
      return 'forbidden';
    case 'GEOCODER_UNAVAILABLE':
      return 'geocoder';
    case 'IMPORT_FORMAT':
      return 'format';
    case 'VALIDATION_FAILED':
      return 'validation';
    default:
      return 'other';
  }
}

/** What IDENTITY_IN_USE means and what to do about it (shown under the server's message). */
export const IDENTITY_IN_USE_HELP =
  'Each person has one VeeTrax login, and an email or mobile number can belong to one login only. This one is already used by a login in another company, by a VeeTrax administrator, or by another passenger or driver. Use a different email or mobile number for this login, or ask the owner of the existing login to change theirs.';

export const LOGIN_OUTCOME_TEXT: Record<'CREATED' | 'LINKED' | 'REACTIVATED', string> = {
  CREATED: 'A new login was created.',
  LINKED: 'An existing login of your company was linked. That person keeps their other roles.',
  REACTIVATED: 'The existing login was switched on again.',
};

// ───────────────────────────── Editor validation ─────────────────────────────

export const MAX_EMERGENCY_CONTACTS = 3;

/** Emergency contacts as the server accepts them: at most 3, name and a phone that normalises to E.164. Blank rows dropped. */
export function validateEmergencyContacts(
  rows: { name: string; phone: string; relation?: string }[],
  country: 'IN' | 'US',
): { contacts: EmergencyContact[]; errors: { index: number; field: 'name' | 'phone'; message: string }[] } {
  const errors: { index: number; field: 'name' | 'phone'; message: string }[] = [];
  const contacts: EmergencyContact[] = [];
  rows.forEach((r, index) => {
    const name = r.name.trim();
    const phoneRaw = r.phone.trim();
    if (!name && !phoneRaw && !r.relation?.trim()) return;
    if (!name) errors.push({ index, field: 'name', message: 'Required' });
    const phone = normalisePhone(phoneRaw, country);
    if (!phone) errors.push({ index, field: 'phone', message: 'Use a valid phone number, e.g. +919876543210' });
    if (name && phone) contacts.push({ name, phone, ...(r.relation?.trim() ? { relation: r.relation.trim() } : {}) });
  });
  if (contacts.length > MAX_EMERGENCY_CONTACTS) errors.push({ index: MAX_EMERGENCY_CONTACTS, field: 'name', message: 'At most 3 emergency contacts' });
  return { contacts, errors };
}

/** Parses typed coordinates ("13.0604", "80.2497"); null when not a valid home point (finite, in range, not 0,0). */
export function parseLatLng(latText: string, lngText: string): { lat: number; lng: number } | null {
  if (!latText.trim() || !lngText.trim()) return null;
  const lat = Number(latText.trim());
  const lng = Number(lngText.trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return null;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

// ───────────────────────────── Vehicle seats ─────────────────────────────

export const SEATS_MIN = 1;
export const SEATS_MAX = 100;

/** Seat text → integer 1..100, or null when invalid. */
export function parseSeats(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text.trim());
  return n >= SEATS_MIN && n <= SEATS_MAX ? n : null;
}
