import type { MovementStatus, ObjectType, VehicleType } from './tracking';

/**
 * Live location share: a link anyone can open in a browser (no app, no sign-in) to watch one vehicle / person move,
 * valid for the number of hours chosen when it was created. The link carries a random token (stored hashed).
 */
export const LIVE_SHARE_MAX_HOURS = 168;
export const LIVE_SHARE_DEFAULT_HOURS = 2;
/** How often the public page asks for the position (seconds). */
export const LIVE_SHARE_POLL_SEC = 5;

export interface LiveShareCreateInput {
  objectId: string;
  hours: number;
  note?: string;
}

export interface LiveShareDto {
  id: string;
  objectId: string;
  note: string | null;
  hours: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  createdByName: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  active: boolean;
}

/** Created share: the link is only returned now (the token is not stored in clear). */
export interface LiveShareCreatedDto extends LiveShareDto {
  url: string;
}

/** Public page payload (GET /public/live-share/:token). */
export interface PublicLiveShareDto {
  name: string;
  plateNumber: string | null;
  type: ObjectType;
  vehicleType: VehicleType | null;
  companyName: string;
  sharedByName: string | null;
  note: string | null;
  expiresAt: string;
  live: {
    lat: number | null;
    lng: number | null;
    speedKph: number;
    course: number;
    status: MovementStatus;
    statusSince: string | null;
    ignition: boolean | null;
    fixTime: string | null;
    serverTime: string | null;
    batteryLevel: number | null;
    /** Charger / main power connected (null = not reported). */
    charging: boolean | null;
    satellites: number | null;
    address: string | null;
  };
  /** Recent path [t, lat, lng] since the share started (at most the last hour). */
  trail: [number, number, number][];
  /** Today's distance (km), when known. */
  todayKm: number | null;
}
