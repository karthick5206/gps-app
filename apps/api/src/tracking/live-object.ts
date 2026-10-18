import { DEFAULT_SPEED_LIMIT_KPH, LiveObject, ObjectType, VehicleType } from '@veetracer/shared';

/** Static object/device facts copied into every LiveObject. */
export interface ObjectMeta {
  objectId: string;
  companyId: string;
  branchId: string | null;
  name: string;
  plateNumber: string | null;
  type: ObjectType;
  vehicleType: VehicleType | null;
  deviceId: string | null;
  uniqueId: string | null;
  speedLimitKph: number | null;
}

/** Object limit, else the vehicle-type default; non-vehicles without a limit never overspeed. */
export function effectiveSpeedLimit(
  speedLimitKph: number | null,
  type: ObjectType,
  vehicleType: VehicleType | null,
): number | null {
  if (speedLimitKph !== null) return speedLimitKph;
  if (vehicleType) return DEFAULT_SPEED_LIMIT_KPH[vehicleType];
  return type === 'VEHICLE' ? DEFAULT_SPEED_LIMIT_KPH.OTHER : null;
}

export function noDataLive(meta: ObjectMeta): LiveObject {
  return {
    ...meta,
    status: 'NO_DATA',
    statusSince: null,
    lat: null,
    lng: null,
    speedKph: 0,
    course: 0,
    ignition: null,
    satellites: null,
    batteryLevel: null,
    gsmSignal: null,
    extVoltage: null,
    fixTime: null,
    serverTime: null,
  };
}

export function parseLive(json: string | null): LiveObject | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as LiveObject;
  } catch {
    return null;
  }
}
