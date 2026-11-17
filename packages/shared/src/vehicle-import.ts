/**
 * Super Admin "Import vehicles" (Device Inventory): one sheet with Vehicle name, IMEI, Model and SIM number (and
 * optionally Company, Branch / Location, Vendor, Driver name / mobile, Licence from / until) creates the devices, the vehicles and the device ↔ vehicle links. Rows
 * without a company / branch go to the ones chosen in the dialog. The browser reads the sheet (.xls / .xlsx / .csv)
 * and sends the rows; the API validates (preview) and writes everything in one transaction (commit). Licences: free
 * seats of each company first, then a complimentary (override) seat per device.
 */

export const VEHICLE_IMPORT_MAX_ROWS = 1000;

/** Header names accepted for each field (compared lower-case, without spaces, dots, slashes, dashes or underscores). */
export const VEHICLE_IMPORT_HEADERS = {
  vehicleName: ['vehiclename', 'vehicle', 'name', 'vehicleno', 'vehiclenumber', 'objectname', 'object'],
  plate: ['plate', 'platenumber', 'plateno', 'registration', 'registrationno', 'registrationnumber', 'regno'],
  imei: ['imeiuniqueid', 'imei', 'uniqueid', 'deviceid', 'imeino', 'imeinumber', 'deviceimei'],
  model: ['model', 'devicemodel', 'devicetype', 'type'],
  sim: ['simnumber', 'sim', 'simno', 'mobile', 'mobilenumber', 'phone', 'simcard'],
  company: ['company', 'companyname', 'customer', 'customername', 'client', 'account'],
  branch: ['branch', 'branchname', 'location', 'site', 'office', 'depot'],
  licenceFrom: ['licencefrom', 'licensefrom', 'licencestart', 'licensestart', 'licencestartdate', 'licensestartdate', 'validfrom', 'startdate', 'activationdate', 'installationdate'],
  licenceUntil: ['licenceuntil', 'licenseuntil', 'licenceend', 'licenseend', 'licenceenddate', 'licenseenddate', 'licenceexpiry', 'licenseexpiry', 'expirydate', 'expiry', 'enddate', 'validtill', 'validuntil', 'validupto'],
  driverName: ['drivername', 'driver'],
  driverMobile: ['drivermobile', 'driverphone', 'drivercontact', 'drivermobileno', 'drivernumber', 'driverno', 'drivercell'],
  vendor: ['vendor', 'vendorname', 'transporter', 'operator', 'supplier', 'cabvendor', 'travels'],
} as const;

export type VehicleImportField = keyof typeof VEHICLE_IMPORT_HEADERS;

export const headerKey = (h: unknown): string =>
  String(h ?? '')
    .toLowerCase()
    .replace(/[\s._/\\\-#()]+/g, '');

/** Map a header row to field → column index (first matching column wins). */
export function mapVehicleImportHeaders(header: unknown[]): Partial<Record<VehicleImportField, number>> {
  const keys = header.map(headerKey);
  const out: Partial<Record<VehicleImportField, number>> = {};
  for (const field of Object.keys(VEHICLE_IMPORT_HEADERS) as VehicleImportField[]) {
    const idx = keys.findIndex((k, i) => k && (VEHICLE_IMPORT_HEADERS[field] as readonly string[]).includes(k) && !Object.values(out).includes(i));
    if (idx >= 0) out[field] = idx;
  }
  return out;
}

export interface VehicleImportRowInput {
  /** Spreadsheet row number (header = 1), for messages. */
  row: number;
  vehicleName: string;
  /** Empty = same as the vehicle name. */
  plate?: string | null;
  imei: string;
  /** Device model as written in the sheet ("Concox V5"); empty = the default model chosen in the dialog. */
  model?: string | null;
  sim?: string | null;
  /** Company name (empty = the company chosen in the dialog). */
  company?: string | null;
  /** Branch / location name in that company (empty = the dialog's branch when it is that company, else none). */
  branch?: string | null;
  /** Transport vendor of the vehicle in that company (added to Vendors when new). */
  vendor?: string | null;
  /** Driver of the vehicle (matched by mobile, else by name, in that company; added to Drivers when new). */
  driverName?: string | null;
  driverMobile?: string | null;
  /** Complimentary licence of this device: from / until (YYYY-MM-DD); empty = the dialog's dates. */
  licenceFrom?: string | null;
  licenceUntil?: string | null;
}

export interface VehicleImportRequest {
  /** Company for rows without a Company value. */
  companyId?: string | null;
  /** Branch for those rows. */
  branchId?: string | null;
  /** Used when a row has no model or its model is not recognised. */
  defaultModelId?: string | null;
  rows: VehicleImportRowInput[];
  /** Needed when some devices get a complimentary licence (not enough free seats). Recorded on the seats + audit. */
  overrideReason?: string | null;
  /** Complimentary licences: valid from (YYYY-MM-DD, default today) … */
  licenceFrom?: string | null;
  /** … until (YYYY-MM-DD, default today + the platform's override days). */
  licenceUntil?: string | null;
}

/**
 * NEW = new device + new vehicle; LINK = new device fitted to a vehicle that already exists in the company;
 * STOCK = a stock device (no company) moves into the company; SKIP = already imported exactly like this; ERROR.
 */
export type VehicleImportAction = 'NEW' | 'LINK' | 'STOCK' | 'SKIP' | 'ERROR';

export interface VehicleImportRowResult {
  row: number;
  vehicleName: string;
  plate: string;
  imei: string;
  sim: string | null;
  modelLabel: string | null;
  companyName: string | null;
  branchName: string | null;
  vendorName: string | null;
  driverName: string | null;
  /** Dates a complimentary licence of this row gets (a free paid seat keeps its own dates). */
  licenceFrom: string | null;
  licenceUntil: string | null;
  action: VehicleImportAction;
  errors: string[];
  warnings: string[];
}

export interface VehicleImportLicenceSummary {
  companyName: string;
  /** Devices that need a licence seat (NEW / LINK / STOCK rows). */
  needed: number;
  /** Free, unexpired seats in the company pool now (taken first). */
  free: number;
  /** Devices that get a complimentary seat. */
  complimentary: number;
  /** Platform company: no licences needed. */
  exempt: boolean;
}

export interface VehicleImportResult {
  committed: boolean;
  rows: VehicleImportRowResult[];
  counts: Record<VehicleImportAction, number>;
  /** Per company in the sheet. */
  licences: VehicleImportLicenceSummary[];
  complimentary: number;
  /** Vendors that will be / were added (company · name). */
  newVendors: string[];
  /** Drivers that will be / were added (company · name). */
  newDrivers: string[];
  licenceFrom: string;
  licenceUntil: string;
}

/** Super Admin: change the start / end date of licence seats (with a reason, audited). */
export interface SeatDatesRequest {
  seatIds: string[];
  /** YYYY-MM-DD; empty keeps each seat's date. */
  activatedAt?: string | null;
  expiresAt?: string | null;
  reason: string;
}
