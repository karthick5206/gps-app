/** A vehicle of one company shown, view only, to another. The owner keeps the vehicle, device and licence. */

/** Super Admin's view of a share. */
export interface VehicleShareDto {
  id: string;
  objectId: string;
  sharedWithId: string;
  sharedWithName: string;
  /** The other company sees the vehicle from this time; nothing earlier. */
  startAt: string;
  /** null = until removed. */
  endAt: string | null;
  alertsOn: boolean;
}

/** What the company a vehicle is shared with may know about the share. */
export interface SharedVehicleDto {
  objectId: string;
  name: string;
  plateNumber: string | null;
  startAt: string;
  endAt: string | null;
  alertsOn: boolean;
}

/** Reports a shared vehicle can be run in: its movement only. Not the owner's geofences, drivers, documents or fuel. */
export const SHARED_VEHICLE_REPORTS = ['SUMMARY', 'DISTANCE', 'ENGINE_HOURS', 'TRIPS', 'STOPS', 'IDLE', 'HALT', 'OVERSPEED', 'IGNITION', 'CONTINUOUS_DRIVING', 'POSITIONS'] as const;
