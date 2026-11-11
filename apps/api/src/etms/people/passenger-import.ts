import {
  PASSENGER_IMPORT_COLUMNS,
  PASSENGER_IMPORT_MAX_ROWS,
  normaliseEmail,
  normalisePhone,
  validHomePoint,
  type HomeLocationSource,
  type PassengerAccessibility,
  type PassengerImportAction,
  type PassengerImportColumn,
  type PassengerImportIssue,
  type PassengerImportRowResult,
} from '@veetracer/shared';

/**
 * Passenger bulk import (doc 05 §2.2, 12 WP 2.1): pure parsing, validation, de-duplication and diffing. The service
 * loads the lookups, optionally geocodes, and writes. Re-importing the same file is idempotent: rows are keyed on
 * (company, employee_code) and an unchanged row is never written. Empty cells leave stored values unchanged.
 */

export class ImportFormatError extends Error {}

export const NAME_MAX = 100;
export const CODE_MAX = 50;
export const ADDRESS_MAX = 300;
export const NOTES_MAX = 500;

/** RFC 4180 CSV: quoted fields with "" escapes and embedded newlines; `,` or `;` (detected on the header line). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new ImportFormatError('The file ends inside a quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const ALIASES: Record<PassengerImportColumn, string[]> = {
  employee_code: ['employeecode', 'empcode', 'code', 'employeeid', 'empid', 'employeeno', 'staffid'],
  name: ['name', 'displayname', 'fullname', 'employeename'],
  mobile: ['mobile', 'phone', 'mobileno', 'mobilenumber', 'phonenumber', 'contact'],
  email: ['email', 'emailid', 'mail', 'emailaddress'],
  home_address: ['homeaddress', 'address', 'residence'],
  home_lat: ['homelat', 'lat', 'latitude', 'homelatitude'],
  home_lng: ['homelng', 'homelon', 'lng', 'lon', 'long', 'longitude', 'homelongitude'],
  office: ['office', 'site', 'officesite', 'worklocation', 'officepoi'],
  default_stop: ['defaultstop', 'stop', 'pickupstop', 'pickuppoint', 'shuttlestop'],
  branch: ['branch', 'branchname'],
  wheelchair: ['wheelchair', 'wheelchairuser'],
  accessibility_notes: ['accessibilitynotes', 'accessibility', 'needs', 'specialneeds'],
  active: ['active', 'isactive', 'status'],
};

export interface CsvRow {
  /** 1-based data row number. */
  row: number;
  cells: Partial<Record<PassengerImportColumn, string>>;
}

/** Decode, parse and map the header to the known columns. Throws ImportFormatError for unreadable / oversized files. */
export function readPassengerCsv(buf: Buffer): { columns: PassengerImportColumn[]; rows: CsvRow[] } {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) throw new ImportFormatError('Save the file as CSV UTF-8');
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) throw new ImportFormatError('This looks like an Excel workbook: save it as CSV UTF-8 first');
  const table = parseCsv(buf.toString('utf8'));
  if (!table.length) throw new ImportFormatError('The file is empty');
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  const index = new Map<PassengerImportColumn, number>();
  for (const col of PASSENGER_IMPORT_COLUMNS) {
    const names = [col.replace(/_/g, ''), ...ALIASES[col]];
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0 && ![...index.values()].includes(i)) index.set(col, i);
  }
  if (!index.has('employee_code') || !index.has('name')) throw new ImportFormatError('The header row needs at least the columns employee_code and name');
  const data = table.slice(1);
  if (!data.length) throw new ImportFormatError('The file has a header but no rows');
  if (data.length > PASSENGER_IMPORT_MAX_ROWS) throw new ImportFormatError(`At most ${PASSENGER_IMPORT_MAX_ROWS} rows per import (the file has ${data.length})`);
  const rows = data.map<CsvRow>((r, i) => {
    const cells: CsvRow['cells'] = {};
    for (const [col, at] of index) {
      const v = (r[at] ?? '').trim();
      if (v !== '') cells[col] = v;
    }
    return { row: i + 1, cells };
  });
  return { columns: [...index.keys()], rows };
}

// ───────────────────────────── Validation ─────────────────────────────

export interface RefLookup {
  id: string;
  name: string;
}

/** Look-ups by lower-cased name and by id. */
export type RefMap = Map<string, RefLookup>;

export function refMap(items: RefLookup[]): RefMap {
  const m: RefMap = new Map();
  for (const it of items) {
    m.set(it.id.toLowerCase(), it);
    const key = it.name.trim().toLowerCase();
    if (!m.has(key)) m.set(key, it);
  }
  return m;
}

/** Stored state the import compares against (subset of EmployeeTransportProfile). */
export interface ExistingProfile {
  id: string;
  employeeCode: string;
  displayName: string;
  mobile: string | null;
  email: string | null;
  homeAddress: string | null;
  homeLat: number | null;
  homeLng: number | null;
  homeGeocodeSource: string | null;
  homeGeocodeConfidence: number | null;
  officePoiId: string | null;
  defaultStopPoiId: string | null;
  branchId: string | null;
  accessibility: PassengerAccessibility;
  isActive: boolean;
  /** The passenger's login (an import that archives the passenger disables it, L3). */
  userId?: string | null;
}

export interface ImportLookups {
  country: 'IN' | 'US';
  sites: RefMap;
  stops: RefMap;
  branches: RefMap;
  /** Existing profiles by employee code. */
  existing: Map<string, ExistingProfile>;
  /** Contacts already used by another active profile of the company: value = that profile's employee code. */
  emailOwners: Map<string, string>;
  mobileOwners: Map<string, string>;
}

/** Normalised row: only the columns that had a value. */
export interface ImportPatch {
  employeeCode: string;
  displayName: string;
  mobile?: string;
  email?: string;
  homeAddress?: string;
  homeLat?: number;
  homeLng?: number;
  homeSource?: HomeLocationSource;
  homeConfidence?: number | null;
  officePoiId?: string;
  defaultStopPoiId?: string;
  branchId?: string;
  wheelchair?: boolean;
  accessibilityNotes?: string;
  isActive?: boolean;
}

export interface ValidatedRow {
  result: PassengerImportRowResult;
  patch: ImportPatch | null;
  existing: ExistingProfile | null;
}

const issue = (column: PassengerImportColumn | null, code: PassengerImportIssue['code'], message: string): PassengerImportIssue => ({ column, code, message });

function parseBool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'active'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'inactive'].includes(s)) return false;
  return null;
}

function parseNum(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Validate every row and flag duplicates (in the file and against other profiles). Pure. */
export function validateImportRows(rows: CsvRow[], lk: ImportLookups): ValidatedRow[] {
  const seenCode = new Map<string, number>();
  const seenEmail = new Map<string, string>();
  const seenMobile = new Map<string, string>();
  return rows.map(({ row, cells }) => {
    const errors: PassengerImportIssue[] = [];
    const warnings: PassengerImportIssue[] = [];
    const employeeCode = cells.employee_code ?? '';
    const displayName = (cells.name ?? '').replace(/\s+/g, ' ');
    if (!employeeCode) errors.push(issue('employee_code', 'REQUIRED', 'Employee code is required'));
    else if (employeeCode.length > CODE_MAX) errors.push(issue('employee_code', 'TOO_LONG', `At most ${CODE_MAX} characters`));
    if (!displayName) errors.push(issue('name', 'REQUIRED', 'Name is required'));
    else if (displayName.length > NAME_MAX) errors.push(issue('name', 'TOO_LONG', `At most ${NAME_MAX} characters`));

    const patch: ImportPatch = { employeeCode, displayName };
    if (cells.mobile !== undefined) {
      const m = normalisePhone(cells.mobile, lk.country);
      if (!m) errors.push(issue('mobile', 'INVALID_MOBILE', `"${cells.mobile}" is not a valid mobile number`));
      else patch.mobile = m;
    }
    if (cells.email !== undefined) {
      const e = normaliseEmail(cells.email);
      if (!e) errors.push(issue('email', 'INVALID_EMAIL', `"${cells.email}" is not a valid email address`));
      else patch.email = e;
    }
    if (cells.home_address !== undefined) {
      const a = cells.home_address.replace(/\s+/g, ' ');
      if (a.length > ADDRESS_MAX) errors.push(issue('home_address', 'TOO_LONG', `At most ${ADDRESS_MAX} characters`));
      else patch.homeAddress = a;
    }
    if (cells.home_lat !== undefined || cells.home_lng !== undefined) {
      const lat = parseNum(cells.home_lat);
      const lng = parseNum(cells.home_lng);
      if (!validHomePoint(lat, lng)) errors.push(issue(cells.home_lat === undefined ? 'home_lat' : 'home_lng', 'INVALID_COORDINATES', 'home_lat and home_lng must both be valid coordinates (not 0,0)'));
      else {
        patch.homeLat = Number((lat as number).toFixed(6));
        patch.homeLng = Number((lng as number).toFixed(6));
        patch.homeSource = 'IMPORT';
        patch.homeConfidence = null;
      }
    }
    const ref = (col: 'office' | 'default_stop' | 'branch', map: RefMap, code: 'UNKNOWN_SITE' | 'UNKNOWN_STOP' | 'UNKNOWN_BRANCH', what: string): string | undefined => {
      const v = cells[col];
      if (v === undefined) return undefined;
      const hit = map.get(v.trim().toLowerCase());
      if (!hit) errors.push(issue(col, code, `Unknown ${what} "${v}"`));
      return hit?.id;
    };
    patch.officePoiId = ref('office', lk.sites, 'UNKNOWN_SITE', 'office / site');
    patch.defaultStopPoiId = ref('default_stop', lk.stops, 'UNKNOWN_STOP', 'stop');
    patch.branchId = ref('branch', lk.branches, 'UNKNOWN_BRANCH', 'branch');
    if (cells.wheelchair !== undefined) {
      const b = parseBool(cells.wheelchair);
      if (b === null) errors.push(issue('wheelchair', 'INVALID_VALUE', 'Use yes or no'));
      else patch.wheelchair = b;
    }
    if (cells.accessibility_notes !== undefined) {
      if (cells.accessibility_notes.length > NOTES_MAX) errors.push(issue('accessibility_notes', 'TOO_LONG', `At most ${NOTES_MAX} characters`));
      else patch.accessibilityNotes = cells.accessibility_notes;
    }
    if (cells.active !== undefined) {
      const b = parseBool(cells.active);
      if (b === null) errors.push(issue('active', 'INVALID_VALUE', 'Use yes or no'));
      else patch.isActive = b;
    }
    for (const k of Object.keys(patch) as (keyof ImportPatch)[]) if (patch[k] === undefined) delete patch[k];

    // Duplicates: a code twice in the file, or a contact shared with another employee (file or database).
    if (employeeCode) {
      const first = seenCode.get(employeeCode);
      if (first !== undefined) errors.push(issue('employee_code', 'DUPLICATE_EMPLOYEE_CODE', `Employee code already on row ${first}`));
      else seenCode.set(employeeCode, row);
    }
    const contactDup = (value: string | undefined, seen: Map<string, string>, owners: Map<string, string>, col: 'email' | 'mobile', code: 'DUPLICATE_EMAIL' | 'DUPLICATE_MOBILE') => {
      if (!value || !employeeCode) return;
      const inFile = seen.get(value);
      const inDb = owners.get(value);
      if (inFile !== undefined && inFile !== employeeCode) errors.push(issue(col, code, `Same ${col} as employee ${inFile} in this file`));
      else if (inDb !== undefined && inDb !== employeeCode) errors.push(issue(col, code, `Same ${col} as existing employee ${inDb}`));
      if (inFile === undefined) seen.set(value, employeeCode);
    };
    contactDup(patch.email, seenEmail, lk.emailOwners, 'email', 'DUPLICATE_EMAIL');
    contactDup(patch.mobile, seenMobile, lk.mobileOwners, 'mobile', 'DUPLICATE_MOBILE');

    const existing = (employeeCode && lk.existing.get(employeeCode)) || null;
    const result: PassengerImportRowResult = {
      row,
      employeeCode,
      displayName,
      action: errors.length ? 'ERROR' : existing ? 'UPDATE' : 'CREATE',
      passengerId: existing?.id ?? null,
      errors,
      warnings,
      geocode: null,
    };
    return { result, patch: errors.length ? null : patch, existing };
  });
}

/** Profile columns an import writes. */
export interface ProfileWrite {
  displayName: string;
  mobile: string | null;
  email: string | null;
  homeAddress: string | null;
  homeLat: number | null;
  homeLng: number | null;
  homeGeocodeSource: string | null;
  homeGeocodeConfidence: number | null;
  officePoiId: string | null;
  defaultStopPoiId: string | null;
  branchId: string | null;
  accessibility: PassengerAccessibility;
  isActive: boolean;
}

/**
 * Target state of a row: the stored state with the patch applied. A changed home_address without new coordinates
 * clears the old (now stale) point, so the passenger lands in "Needs location" instead of keeping a wrong pin.
 */
export function applyPatch(existing: ExistingProfile | null, patch: ImportPatch): ProfileWrite {
  const base: ProfileWrite = existing
    ? {
        displayName: existing.displayName,
        mobile: existing.mobile,
        email: existing.email,
        homeAddress: existing.homeAddress,
        homeLat: existing.homeLat,
        homeLng: existing.homeLng,
        homeGeocodeSource: existing.homeGeocodeSource,
        homeGeocodeConfidence: existing.homeGeocodeConfidence,
        officePoiId: existing.officePoiId,
        defaultStopPoiId: existing.defaultStopPoiId,
        branchId: existing.branchId,
        accessibility: { ...existing.accessibility },
        isActive: existing.isActive,
      }
    : {
        displayName: patch.displayName,
        mobile: null,
        email: null,
        homeAddress: null,
        homeLat: null,
        homeLng: null,
        homeGeocodeSource: null,
        homeGeocodeConfidence: null,
        officePoiId: null,
        defaultStopPoiId: null,
        branchId: null,
        accessibility: {},
        isActive: true,
      };
  const out: ProfileWrite = { ...base, displayName: patch.displayName };
  if (patch.mobile !== undefined) out.mobile = patch.mobile;
  if (patch.email !== undefined) out.email = patch.email;
  if (patch.officePoiId !== undefined) out.officePoiId = patch.officePoiId;
  if (patch.defaultStopPoiId !== undefined) out.defaultStopPoiId = patch.defaultStopPoiId;
  if (patch.branchId !== undefined) out.branchId = patch.branchId;
  if (patch.isActive !== undefined) out.isActive = patch.isActive;
  if (patch.wheelchair !== undefined || patch.accessibilityNotes !== undefined) {
    out.accessibility = { ...out.accessibility };
    if (patch.wheelchair !== undefined) out.accessibility.wheelchair = patch.wheelchair;
    if (patch.accessibilityNotes !== undefined) out.accessibility.notes = patch.accessibilityNotes;
  }
  if (patch.homeLat !== undefined && patch.homeLng !== undefined) {
    out.homeLat = patch.homeLat;
    out.homeLng = patch.homeLng;
    out.homeGeocodeSource = patch.homeSource ?? 'IMPORT';
    out.homeGeocodeConfidence = patch.homeConfidence ?? null;
    if (patch.homeAddress !== undefined) out.homeAddress = patch.homeAddress;
  } else if (patch.homeAddress !== undefined && patch.homeAddress !== base.homeAddress) {
    out.homeAddress = patch.homeAddress;
    out.homeLat = null;
    out.homeLng = null;
    out.homeGeocodeSource = null;
    out.homeGeocodeConfidence = null;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** Fields that would change (empty = UNCHANGED). */
export function changedFields(existing: ExistingProfile, target: ProfileWrite): (keyof ProfileWrite)[] {
  const keys = Object.keys(target) as (keyof ProfileWrite)[];
  return keys.filter((k) => (k === 'accessibility' ? !same(sortKeys(existing.accessibility), sortKeys(target.accessibility)) : !same(existing[k as keyof ExistingProfile], target[k])));
}

/** Final action of a valid row (CREATE / UPDATE / UNCHANGED) plus the "no location yet" warning. */
export function finaliseRow(v: ValidatedRow): { action: PassengerImportAction; target: ProfileWrite | null; changed: (keyof ProfileWrite)[] } {
  if (!v.patch) return { action: 'ERROR', target: null, changed: [] };
  const target = applyPatch(v.existing, v.patch);
  if (target.isActive && target.homeLat === null && !target.defaultStopPoiId) {
    v.result.warnings.push(issue(null, 'NO_LOCATION', target.homeAddress ? 'Address without coordinates: confirm the pin later ("Needs location")' : 'No home location or stop yet ("Needs location")'));
  }
  if (!v.existing) return { action: 'CREATE', target, changed: Object.keys(target) as (keyof ProfileWrite)[] };
  const changed = changedFields(v.existing, target);
  return { action: changed.length ? 'UPDATE' : 'UNCHANGED', target, changed };
}

/** "3,5, 9-11" → Set{3,5,9,10,11}; null for empty input. Throws ImportFormatError on garbage. */
export function parseRowSelection(raw: string | undefined): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p);
    if (!m) throw new ImportFormatError(`Invalid row selection "${p}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > PASSENGER_IMPORT_MAX_ROWS) throw new ImportFormatError(`Invalid row range "${p}"`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}
