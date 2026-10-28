/** Drivers, RFID / iButton identification and driver ↔ vehicle sessions. */

export type DriverAssignmentSource = 'MANUAL' | 'RFID';

export interface DriverDto {
  id: string;
  companyId: string;
  name: string;
  mobile: string | null;
  employeeId: string | null;
  licenseNo: string | null;
  /** YYYY-MM-DD */
  licenseExpiry: string | null;
  /** RFID card / iButton id as the tracker reports it (hex, upper case). */
  rfidTag: string | null;
  branchId: string | null;
  branchName: string | null;
  notes: string | null;
  isActive: boolean;
  /** Vehicle the driver is on right now (open session), if any. */
  current: { objectId: string; objectName: string; since: string; source: DriverAssignmentSource } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriverAssignmentDto {
  id: string;
  driverId: string;
  driverName: string;
  objectId: string;
  objectName: string;
  fromTime: string;
  toTime: string | null;
  source: DriverAssignmentSource;
  createdByName: string | null;
}

/** POST /drivers/assign: put a driver on a vehicle (driverId null = vehicle has no driver now). */
export interface AssignDriverRequest {
  objectId: string;
  driverId: string | null;
}

/** Days before licence expiry when the UI starts warning. */
export const LICENSE_WARN_DAYS = 30;

/** Normalises an RFID / iButton id the way trackers report it: hex digits, upper case, no separators or leading zeros. */
export function normalizeRfidTag(raw: string): string {
  const hex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase().replace(/^0+(?=.)/, '');
  return hex;
}

/** DRIVERS report: one row per driver for the period. */
export interface DriverReportRow {
  driverId: string;
  driverName: string;
  employeeId: string | null;
  vehicles: string;
  sessions: number;
  tripCount: number;
  distanceKm: number;
  drivingSec: number;
  maxSpeedKph: number;
  overspeedCount: number;
  firstStart: string | null;
  lastEnd: string | null;
}
