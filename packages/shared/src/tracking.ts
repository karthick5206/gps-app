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

export const OBJECT_TYPES = ['VEHICLE', 'PERSON', 'ASSET', 'PET'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const VEHICLE_TYPES = ['CAR', 'BIKE', 'TRUCK', 'BUS', 'SCHOOL_BUS', 'VAN', 'AUTO', 'OTHER'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** Default speed limit (km/h) per vehicle type, used when the object has no own limit. */
export const DEFAULT_SPEED_LIMIT_KPH: Record<VehicleType, number> = {
  CAR: 80, BIKE: 60, TRUCK: 60, BUS: 60, SCHOOL_BUS: 40, VAN: 70, AUTO: 50, OTHER: 80,
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
  fixTime: string | null;
  serverTime: string | null;
  speedLimitKph: number | null;
}
