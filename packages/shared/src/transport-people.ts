/**
 * Employee transport (ETMS) contracts, phase E2: passengers (employee transport profiles), consent, passenger app access,
 * bulk import and vehicle seat capacity. Docs: docs/employee-transport/05 §2.2–2.3, 02 §7, 10 §2 / §4, 15 §4.
 * Kept apart from transport.ts (E1a, agreements) so the two phases can change independently.
 */
import type { PermissionMap } from './permissions';

// ───────────────────────────── Passengers ─────────────────────────────

/**
 * How the stored (original) home point was obtained (doc 15 §4.1 `homeGeocodeSource`):
 * PIN = placed / confirmed on the map; PHOTON = geocoded from the typed address by the self-hosted Photon;
 * IMPORT = coordinates from an HR import file; TYPED = coordinates typed into the editor.
 */
export const HOME_LOCATION_SOURCES = ['PIN', 'PHOTON', 'IMPORT', 'TYPED'] as const;
export type HomeLocationSource = (typeof HOME_LOCATION_SOURCES)[number];

/**
 * Which passenger fields the caller sees; chosen by the server, never by the client (doc 02 §4.2 passengerProjection):
 * FULL = corporate admin of the passenger's own company (whole-company role), home address and contacts revealed (audited);
 * STANDARD = corporate dispatcher (branch / site scoped role): home address hidden, home point rounded to 4 decimals;
 * MINIMAL = transport provider under an agreement granting VIEW_PASSENGER_MINIMAL (doc 10 §2): short name, office,
 * pickup point only (and only while the passenger's routing consent is active); contacts only with VIEW_PASSENGER_CONTACT.
 */
export const PASSENGER_PROJECTIONS = ['FULL', 'STANDARD', 'MINIMAL'] as const;
export type PassengerProjection = (typeof PASSENGER_PROJECTIONS)[number];

export interface PlaceRef {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface PassengerAccessibility {
  wheelchair?: boolean;
  notes?: string;
}

export interface EmergencyContact {
  name: string;
  /** E.164. */
  phone: string;
  relation?: string;
}

export interface PassengerHomeDto {
  /** Original text; null for STANDARD (masked) or when none was given. */
  address: string | null;
  /** FULL: 6 decimals as stored; STANDARD: rounded to 4 decimals (≈ 11 m). null when the passenger has no point yet. */
  lat: number | null;
  lng: number | null;
  source: HomeLocationSource | null;
  /** Photon confidence (0..1) when source = PHOTON. */
  confidence: number | null;
}

/**
 * The point routing may use for this passenger: the default stop when one is set, else the home point. Always null
 * while the passenger has no active TRANSPORT_PROFILE consent (doc 02 §7.3 purpose limitation). Home points are rounded
 * to 4 decimals except in the FULL projection.
 */
export interface PassengerPickupDto {
  kind: 'STOP' | 'HOME';
  lat: number;
  lng: number;
  /** Stop name, or null for a home pickup (the address is never part of the pickup). */
  label: string | null;
  poiId: string | null;
}

export interface PassengerAppAccessDto {
  userId: string;
  /** Login enabled (User active and still holding the Passenger role). */
  active: boolean;
  email: string | null;
  mobile: string | null;
  lastLoginAt: string | null;
  /** The User also holds other (fleet) roles: P3 dual-role, fleet shell + "My commute". */
  otherRoles: boolean;
}

export interface PassengerDto {
  id: string;
  projection: PassengerProjection;
  customerCompanyId: string;
  employeeCode: string;
  /** FULL / STANDARD: the full name; MINIMAL: first name + last initial ("Asha K."). */
  displayName: string;
  isActive: boolean;
  branchId: string | null;
  branchName: string | null;
  office: PlaceRef | null;
  defaultStop: PlaceRef | null;
  /** List rows: always masked ("+91•••••43210"); detail: FULL / STANDARD in clear (ACCESS-audited); MINIMAL: masked
   *  or clear per the agreement (VIEW_PASSENGER_CONTACT; clear only with the STANDARD data profile), else null. */
  mobile: string | null;
  email: string | null;
  /** null in MINIMAL. */
  home: PassengerHomeDto | null;
  hasHomeLocation: boolean;
  /** Active profile without a home point and without a default stop: the "Needs location" queue. */
  needsLocation: boolean;
  pickup: PassengerPickupDto | null;
  /** Passenger has an active TRANSPORT_PROFILE consent: its location may be used for routing. */
  routingConsent: boolean;
  /** Any accessibility need recorded (all projections). */
  accessibilityNeeds: boolean;
  /** Detail of the needs; null in MINIMAL. */
  accessibility: PassengerAccessibility | null;
  /** FULL detail only (null elsewhere and in list rows). */
  emergencyContacts: EmergencyContact[] | null;
  /** FULL / STANDARD only. */
  appAccess: PassengerAppAccessDto | null;
  /** FULL / STANDARD only: current consent per purpose. */
  consents: PassengerConsentStateDto[] | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Home location in create / update. lat and lng together, or `geocode: true` with an address (Photon only). */
export interface PassengerHomeInput {
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** How the client obtained lat / lng (PHOTON = a candidate from GET /passengers/geocode the user confirmed); ignored
   *  when the server geocodes (then PHOTON). Default PIN. */
  source?: HomeLocationSource;
  /** Photon confidence of a confirmed candidate, when known. */
  confidence?: number | null;
  /** Geocode `address` on the server with the self-hosted Photon when no lat / lng is given. */
  geocode?: boolean;
}

/** POST /api/transport/passengers */
export interface CreatePassengerInput {
  employeeCode: string;
  displayName: string;
  /** E.164, or a local number normalised with the company's default country (India → +91, US → +1). */
  mobile?: string | null;
  email?: string | null;
  branchId?: string | null;
  officePoiId?: string | null;
  defaultStopPoiId?: string | null;
  /** null clears the home location (update only). */
  home?: PassengerHomeInput | null;
  accessibility?: PassengerAccessibility;
  emergencyContacts?: EmergencyContact[];
}

/** PATCH /api/transport/passengers/:id (dispatchers may not change `home`). */
export type UpdatePassengerInput = Partial<CreatePassengerInput> & { isActive?: boolean };

/** GET /api/transport/passengers (ListQuery + filters). `status` ACTIVE / INACTIVE = isActive. */
export interface PassengerListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'displayName' | 'employeeCode' | 'createdAt' | 'updatedAt';
  order?: 'asc' | 'desc';
  status?: 'ACTIVE' | 'INACTIVE';
  format?: 'json' | 'csv';
  /** Office site (Poi) id. */
  siteId?: string;
  branchId?: string;
  /** 'true' = only the "Needs location" queue. */
  needsLocation?: 'true' | 'false';
  /** 'true' = has a passenger login; 'false' = none. */
  appAccess?: 'true' | 'false';
  /** 'true' = routing consent active; 'false' = missing / withdrawn. */
  routingConsent?: 'true' | 'false';
}

// ───────────────────────────── Passenger app access (D5, P3) ─────────────────────────────

/** POST /api/transport/passengers/:id/app-access — create or link the passenger's login. */
export interface PassengerAppAccessInput {
  /** Defaults to the profile's email / mobile; at least one of the two is needed. */
  email?: string | null;
  mobile?: string | null;
  /** Initial password (same rules as Users); omitted = no password yet (password reset / manual invite). */
  password?: string;
}

export interface PassengerAppAccessResult {
  passenger: PassengerDto;
  /** CREATED = new User; LINKED = an existing User of the same company got the Passenger role; REACTIVATED. */
  outcome: 'CREATED' | 'LINKED' | 'REACTIVATED';
  /** E2 has no SMS / mail activation (owner approval pending): the admin shares the login; MANUAL always. */
  invite: { channel: 'MANUAL'; passwordSet: boolean };
}

// ───────────────────────────── Consent (doc 10 §4.2, 15 §4.2) ─────────────────────────────

/**
 * Consent purposes (open set in the database; this is the list the API accepts in E2). TRANSPORT_PROFILE = the
 * employee's home location and profile may be used to plan their transport: without an active one, no location of the
 * passenger is used for routing.
 */
export const CONSENT_PURPOSES = ['TRANSPORT_PROFILE', 'PICKUP_LOCATION_SHARE', 'SOS_LOCATION', 'NOTIFICATIONS_SMS'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const ROUTING_CONSENT_PURPOSE: ConsentPurpose = 'TRANSPORT_PROFILE';

export const CONSENT_CHANNELS = ['WEB', 'PASSENGER_APP', 'ADMIN_ON_BEHALF'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export interface ConsentRecordDto {
  id: string;
  purpose: string;
  granted: boolean;
  noticeVersion: string;
  locale: string | null;
  channel: string;
  subjectUserId: string | null;
  actorUserId: string | null;
  occurredAt: string;
}

export interface PassengerConsentStateDto {
  purpose: string;
  /** Latest row is a grant. */
  active: boolean;
  noticeVersion: string | null;
  /** Time of the latest grant still in force, else null. */
  grantedAt: string | null;
  /** Time of the latest withdrawal when the consent is not active, else null. */
  revokedAt: string | null;
  channel: string | null;
}

/** GET /api/transport/passengers/:id/consents and GET /api/me/transport/consent/history. */
export interface PassengerConsentsDto {
  current: PassengerConsentStateDto[];
  history: ConsentRecordDto[];
}

/** POST /api/transport/passengers/:id/consents (admin on behalf) and POST /api/me/transport/consent (own). */
export interface RecordConsentInput {
  purpose: ConsentPurpose;
  granted: boolean;
  noticeVersion: string;
  locale?: string;
}

// ───────────────────────────── Bulk import (doc 05 §2.2) ─────────────────────────────

/**
 * CSV columns (header row required, case / spaces / dashes ignored; `,` or `;` separated; UTF-8, BOM allowed).
 * employee_code and name are required; everything else optional. office / default_stop / branch accept a name (case-
 * insensitive) or an id of the company's active place / branch. home_lat + home_lng together, or home_address alone
 * (geocoded with Photon when `geocode=true`). active: yes / no / true / false / 1 / 0 (default yes).
 */
export const PASSENGER_IMPORT_COLUMNS = [
  'employee_code',
  'name',
  'mobile',
  'email',
  'home_address',
  'home_lat',
  'home_lng',
  'office',
  'default_stop',
  'branch',
  'wheelchair',
  'accessibility_notes',
  'active',
] as const;
export type PassengerImportColumn = (typeof PASSENGER_IMPORT_COLUMNS)[number];
export const PASSENGER_IMPORT_MAX_ROWS = 10_000;
export const PASSENGER_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export type PassengerImportAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'ERROR' | 'SKIPPED';

export type PassengerImportIssueCode =
  | 'REQUIRED'
  | 'INVALID_MOBILE'
  | 'INVALID_EMAIL'
  | 'INVALID_COORDINATES'
  | 'INVALID_VALUE'
  | 'TOO_LONG'
  | 'UNKNOWN_SITE'
  | 'UNKNOWN_STOP'
  | 'UNKNOWN_BRANCH'
  | 'DUPLICATE_EMPLOYEE_CODE'
  | 'DUPLICATE_EMAIL'
  | 'DUPLICATE_MOBILE'
  | 'GEOCODE_NO_RESULT'
  | 'GEOCODE_LOW_CONFIDENCE'
  | 'NO_LOCATION';

export interface PassengerImportIssue {
  /** CSV column, or null for the whole row. */
  column: PassengerImportColumn | null;
  code: PassengerImportIssueCode;
  message: string;
}

export interface PassengerImportRowResult {
  /** 1-based data row number (the header is row 0). */
  row: number;
  employeeCode: string;
  displayName: string;
  action: PassengerImportAction;
  /** Existing profile updated / unchanged. */
  passengerId: string | null;
  /** Blocking: the row is not imported. */
  errors: PassengerImportIssue[];
  /** Non-blocking (e.g. no location yet → "Needs location"). */
  warnings: PassengerImportIssue[];
  /** Geocode result for a home_address without coordinates (geocode=true). */
  geocode: { lat: number; lng: number; label: string; confidence: number | null } | null;
}

export interface PassengerImportResult {
  /** false = dry run (preview): nothing written. */
  committed: boolean;
  totalRows: number;
  creates: number;
  updates: number;
  unchanged: number;
  errors: number;
  /** Rows left out on commit because they were not in `rows`. */
  skipped: number;
  /** Rows with at least one DUPLICATE_* error. */
  duplicates: number;
  rows: PassengerImportRowResult[];
}

/**
 * POST /api/transport/passengers/import/preview (dry run) and /import/commit: multipart `file` (CSV) plus these fields.
 * Commit re-validates the same file and writes only rows without errors (optionally only `rows`); idempotent on
 * (company, employee_code): unchanged rows are not touched, so re-importing a file creates 0 new rows.
 */
export interface PassengerImportOptions {
  /** 'true' = geocode home_address rows without coordinates with Photon. */
  geocode?: 'true' | 'false';
  /** Commit only: comma-separated data row numbers to commit (default every valid row). */
  rows?: string;
}

// ───────────────────────────── Vehicle capacity (doc 15 §4.3) ─────────────────────────────

export const TRANSPORT_VEHICLE_CATEGORIES = ['SEDAN', 'HATCHBACK', 'SUV', 'MUV', 'VAN', 'TEMPO_TRAVELLER', 'MINIBUS', 'BUS', 'OTHER'] as const;
export type TransportVehicleCategory = (typeof TRANSPORT_VEHICLE_CATEGORIES)[number];

export interface TransportVehicleProfileDto {
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  /** Passenger seats, driver excluded (1..100). */
  seats: number;
  wheelchairSpaces: number;
  hasAc: boolean | null;
  category: string | null;
  notes: string | null;
  updatedAt: string;
}

/** GET /api/transport/vehicles/:objectId/profile — profile null while seats were never set. */
export interface TransportVehicleProfileResponse {
  objectId: string;
  profile: TransportVehicleProfileDto | null;
}

/** GET /api/transport/passengers/geocode?q= — Photon candidates (self-hosted only; [] when no geocoder is configured). */
export interface GeocodeCandidate {
  label: string;
  lat: number;
  lng: number;
}

/** PUT /api/transport/vehicles/:objectId/profile */
export interface TransportVehicleProfileInput {
  seats: number;
  wheelchairSpaces?: number;
  hasAc?: boolean | null;
  category?: TransportVehicleCategory | null;
  notes?: string | null;
}

// ───────────────────────────── Driver login (doc 05 §2.3, 15 §7.2) ─────────────────────────────

/** POST /api/drivers/:id/login — create or link the driver's login (Driver role template). */
export interface DriverLoginInput {
  email?: string | null;
  /** Defaults to the driver's mobile. */
  mobile?: string | null;
  password?: string;
}

export interface DriverLoginDto {
  driverId: string;
  userId: string | null;
  active: boolean;
  email: string | null;
  mobile: string | null;
  outcome?: 'CREATED' | 'LINKED' | 'REACTIVATED';
}

/** Error `code` values added in E2 (doc 05 §4). */
export type TransportPeopleErrorCode = 'IDENTITY_IN_USE' | 'PASSENGER_DUPLICATE' | 'CONSENT_REQUIRED' | 'GEOCODER_UNAVAILABLE' | 'IMPORT_FORMAT';

// ───────────────────────────── Pure helpers (shared by API, web and mobile) ─────────────────────────────

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalise a phone number to E.164. Spaces, dashes, dots and brackets are dropped; "00" becomes "+". A number without
 * a country code takes `defaultCountry` (IN: 10 digits starting 6–9, optional leading 0; US: 10 digits, optional 1).
 * Returns null when the result is not a valid E.164 number.
 */
export function normalisePhone(raw: string | null | undefined, defaultCountry: 'IN' | 'US' = 'IN'): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/[\s\-.()/]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    if (!/^\d+$/.test(s)) return null;
    if (defaultCountry === 'IN') {
      if (/^0?[6-9]\d{9}$/.test(s)) s = `+91${s.slice(-10)}`;
      else if (/^91[6-9]\d{9}$/.test(s)) s = `+${s}`;
      else return null;
    } else {
      if (/^1?\d{10}$/.test(s)) s = `+1${s.slice(-10)}`;
      else return null;
    }
  }
  return E164.test(s) ? s : null;
}

/** Default phone country from the company time zone (America/* → US, else India). */
export function phoneCountryForTimezone(timezone: string | null | undefined): 'IN' | 'US' {
  return timezone?.startsWith('America/') || timezone?.startsWith('US/') ? 'US' : 'IN';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normaliseEmail(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase();
  return s && EMAIL.test(s) && s.length <= 254 ? s : null;
}

/** Original home point validity (doc 02 §7.2 / CHECK in etms_people): finite, in range, not (0,0). No service-area check in E2. */
export function validHomePoint(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** Round a coordinate (6 decimals stored, 4 for non-FULL projections). */
export const roundCoord = (v: number, decimals: 4 | 6): number => Number(v.toFixed(decimals));

/** "+919876543210" → "+91•••••43210" (country code and last 5 digits kept). */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 7) return '•'.repeat(phone.length);
  const cc = phone.startsWith('+91') ? 3 : phone.startsWith('+1') ? 2 : 3;
  return phone.slice(0, cc) + '•'.repeat(Math.max(0, phone.length - cc - 5)) + phone.slice(-5);
}

/** "asha.k@corp.com" → "a•••@corp.com". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/** "Asha Krishnan" → "Asha K." (MINIMAL projection). */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Current consent per purpose from history rows (any order): the latest row per purpose wins. */
export function currentConsents(rows: { purpose: string; granted: boolean; noticeVersion: string; channel: string; occurredAt: string | Date }[]): PassengerConsentStateDto[] {
  const sorted = [...rows].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const by = new Map<string, PassengerConsentStateDto>();
  for (const r of sorted) {
    const at = new Date(r.occurredAt).toISOString();
    by.set(r.purpose, {
      purpose: r.purpose,
      active: r.granted,
      noticeVersion: r.noticeVersion,
      grantedAt: r.granted ? at : null,
      revokedAt: r.granted ? null : at,
      channel: r.channel,
    });
  }
  return [...by.values()].sort((a, b) => a.purpose.localeCompare(b.purpose));
}

/** Whether `purpose` is currently granted. */
export function consentActive(rows: Parameters<typeof currentConsents>[0], purpose: string): boolean {
  return currentConsents(rows).find((c) => c.purpose === purpose)?.active ?? false;
}

// ───────────────────────────── Role templates: E2 additions (P6) ─────────────────────────────

/**
 * Menus E2 adds to the ETMS role templates (ETMS_ROLE_TEMPLATES in transport.ts, keyed by template name). Merged in when
 * the templates are seeded, i.e. for companies that switch `etms` on from now; existing roles are never changed.
 * Corporate admin: passengers V/C/E/D/X (doc 05 §6); dispatcher: V/E (site-scoped, home address masked).
 */
export const ETMS_E2_TEMPLATE_PERMISSIONS: Record<string, PermissionMap> = {
  'Transport admin': { etms_passengers: ['view', 'create', 'edit', 'delete', 'export'] },
  'Transport dispatcher': { etms_passengers: ['view', 'edit'] },
};

/** Name of the role template a passenger login gets (D5). */
export const ETMS_PASSENGER_ROLE_NAME = 'Transport passenger';
/** Name of the role template a driver login gets (D5). */
export const ETMS_DRIVER_ROLE_NAME = 'Transport driver';
