/** Movement statuses, object types and tracking defaults shared by backend, web and mobile. */

export const MOVEMENT_STATUSES = ['RUNNING', 'IDLE', 'OFF', 'OVERSPEED', 'OFFLINE', 'NO_DATA'] as const;
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

export const STATUS_META: Record<MovementStatus, { label: string; light: string; dark: string }> = {
  RUNNING: { label: 'Running', light: '#16a34a', dark: '#22c55e' },
  IDLE: { label: 'Idle', light: '#d97706', dark: '#fbbf24' },
  OFF: { label: 'Off', light: '#dc2626', dark: '#f87171' },
  OVERSPEED: { label: 'Overspeeding', light: '#9333ea', dark: '#c084fc' },
  OFFLINE: { label: 'Offline', light: '#6b7280', dark: '#9ca3af' },
  NO_DATA: { label: 'No data', light: '#94a3b8', dark: '#64748b' },
};

/**
 * What a tracked person is doing, derived from speed (phones and ID cards have no ignition, so the vehicle
 * statuses would say "Off" / "Idle"). Display only: the stored status, alerts and reports are unchanged.
 * `status` is the movement status whose colour the activity uses on the map and in lists.
 */
export const PERSON_ACTIVITIES = ['STILL', 'WALKING', 'RUNNING', 'IN_VEHICLE'] as const;
export type PersonActivity = (typeof PERSON_ACTIVITIES)[number];

export const ACTIVITY_META: Record<PersonActivity, { label: string; maxKph: number; status: MovementStatus }> = {
  STILL: { label: 'Still', maxKph: 1.5, status: 'IDLE' },
  WALKING: { label: 'Walking', maxKph: 7, status: 'RUNNING' },
  RUNNING: { label: 'Running (on foot)', maxKph: 16, status: 'RUNNING' },
  IN_VEHICLE: { label: 'In vehicle', maxKph: Infinity, status: 'RUNNING' },
};

export function activityFromSpeed(speedKph: number): PersonActivity {
  return PERSON_ACTIVITIES.find((a) => speedKph < ACTIVITY_META[a].maxKph) ?? 'IN_VEHICLE';
}

/** The person's activity while reporting; null for other object types and when offline / no data. */
export function personActivity(o: { type: string; status: MovementStatus; speedKph: number }): PersonActivity | null {
  if (o.type !== 'PERSON' || o.status === 'OFFLINE' || o.status === 'NO_DATA') return null;
  return activityFromSpeed(o.speedKph);
}

/** Status to colour an object by: a person's activity colour, otherwise its own status. */
export function displayStatus(o: { type: string; status: MovementStatus; speedKph: number }): MovementStatus {
  const a = personActivity(o);
  return a ? ACTIVITY_META[a].status : o.status;
}

/** Label (untranslated i18n key) for an object's state: the activity for people, the movement status otherwise. */
export function displayStatusLabel(o: { type: string; status: MovementStatus; speedKph: number }): string {
  const a = personActivity(o);
  return a ? ACTIVITY_META[a].label : STATUS_META[o.status].label;
}

export const OBJECT_TYPES = ['VEHICLE', 'PERSON', 'ASSET', 'PET'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const VEHICLE_TYPES = ['CAR', 'BIKE', 'TRUCK', 'BUS', 'SCHOOL_BUS', 'VAN', 'AUTO', 'OTHER'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * Default speed limit (km/h) per vehicle type, used when the object has no own limit. Fleet default: overspeed above
 * 80 km/h for every type; set a lower limit on individual vehicles (e.g. school buses) under Vehicles & Objects.
 */
export const DEFAULT_SPEED_LIMIT_KPH: Record<VehicleType, number> = {
  CAR: 80, BIKE: 80, TRUCK: 80, BUS: 80, SCHOOL_BUS: 80, VAN: 80, AUTO: 80, OTHER: 80,
};

/** Highest plausible speed (km/h) per object type; faster implied jumps are flagged as GPS jumps. */
export const MAX_PLAUSIBLE_SPEED_KPH: Record<ObjectType, number> = {
  VEHICLE: 200, PERSON: 150, ASSET: 200, PET: 50,
};

/** Company-level status thresholds (configurable per company in settings). */
export interface StatusThresholds {
  runningSpeedKph: number; // above this = moving
  idleAfterSec: number; // ignition on and not moving for this long = IDLE
  offlineAfterSec: number; // no data for this long = OFFLINE
  driftRadiusM: number; // parked movement under this is ignored
}

export const DEFAULT_THRESHOLDS: StatusThresholds = {
  runningSpeedKph: 5,
  idleAfterSec: 120,
  offlineAfterSec: 600,
  driftRadiusM: 30,
};

/** Bit flags stored on every position (Position.flags). A flagged point is kept but not used for map/distance. */
export const POSITION_FLAGS = {
  INVALID_FIX: 1, // no GPS fix / 0,0 / too few satellites
  JUMP: 2, // implied speed impossible for object type
  DRIFT: 4, // parked drift, coordinates frozen to last valid
  FUTURE: 8, // timestamp in the future
  LATE: 16, // arrived out of order (older than latest)
  LBS: 32, // approximate location from cell tower / Wi-Fi
} as const;

/** Position produced by any protocol decoder, before processing. */
export interface NormalizedPosition {
  protocol: string;
  uniqueId: string; // IMEI or phone id
  fixTime: string; // ISO UTC
  receivedAt: string; // ISO UTC
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  altitude: number | null;
  satellites: number | null;
  valid: boolean;
  ignition: boolean | null;
  attributes: Record<string, unknown>; // gsmSignal, batteryLevel, extVoltage, charging, alarm, ...
  raw?: string; // hex of raw packet
}

/** Current state of one tracked object, as shown on the live map. */
export interface LiveObject {
  /** In maintenance: alerts are suppressed. */
  inMaintenance?: boolean;
  objectId: string;
  companyId: string;
  branchId: string | null;
  name: string;
  plateNumber: string | null;
  type: ObjectType;
  vehicleType: VehicleType | null;
  deviceId: string | null;
  uniqueId: string | null;
  /** Mobile number of the SIM in the tracker (Devices), e.g. to call an ID card or a vehicle tracker. */
  simNumber?: string | null;
  status: MovementStatus;
  statusSince: string | null;
  lat: number | null;
  lng: number | null;
  speedKph: number;
  course: number;
  ignition: boolean | null;
  satellites: number | null;
  batteryLevel: number | null;
  gsmSignal: number | null;
  extVoltage: number | null;
  /** Fuel in the tank (calibrated litres) and % of the tank, when the vehicle has a fuel sensor configured. */
  fuelL?: number | null;
  fuelPct?: number | null;
  /** AC / door sensor state when configured on the vehicle (null = configured but no reading yet; absent = not configured). */
  acOn?: boolean | null;
  doorOpen?: boolean | null;
  /** Latest analog reading (V) of an analog AC / door sensor, for display and calibration. */
  acVoltage?: number | null;
  doorVoltage?: number | null;
  fixTime: string | null;
  serverTime: string | null;
  speedLimitKph: number | null;
  /** Driver on the vehicle now (RFID swipe or manual assignment). */
  driverId?: string | null;
  driverName?: string | null;
  /** RFID = card swipe on the tracker (ends at ignition off), MANUAL = assigned in the app. */
  driverSource?: 'MANUAL' | 'RFID' | null;
  /** The vehicle's licence expired past the grace period: position and history are hidden until it is renewed. */
  licenceLocked?: boolean;
}
