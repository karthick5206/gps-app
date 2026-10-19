/**
 * Driver behaviour events: an ADAS / DMS (or crash) alert from a dashcam, with the cabin / road snapshot the platform
 * requests (JT/T 808 0x8801) and the alarm photos / clips the dashcam uploads itself (Su-standard attachments).
 */
import type { AlertTypeCode } from './alerts';

/** Alert types that create a driver event. */
export const DRIVER_EVENT_TYPES = [
  'DRIVER_FATIGUE',
  'DRIVER_PHONE',
  'DRIVER_SMOKING',
  'DRIVER_DISTRACTED',
  'DRIVER_ABSENT',
  'FORWARD_COLLISION_WARNING',
  'LANE_DEPARTURE',
  'TAILGATING',
  'CRASH',
] as const satisfies readonly AlertTypeCode[];
export type DriverEventType = (typeof DRIVER_EVENT_TYPES)[number];

/** DMS (driver-facing) types: the snapshot comes from the cabin camera; the others from the road camera. */
export const CABIN_EVENT_TYPES: readonly DriverEventType[] = ['DRIVER_FATIGUE', 'DRIVER_PHONE', 'DRIVER_SMOKING', 'DRIVER_DISTRACTED', 'DRIVER_ABSENT'];

export const isDriverEventType = (type: string): type is DriverEventType => (DRIVER_EVENT_TYPES as readonly string[]).includes(type);

export const DRIVER_EVENT_STATUSES = ['NEW', 'REVIEWED', 'DISMISSED', 'COACHED'] as const;
export type DriverEventStatus = (typeof DRIVER_EVENT_STATUSES)[number];

export type DriverEventMediaKind = 'PHOTO' | 'VIDEO';
export type DriverEventMediaSource = 'SNAPSHOT' | 'ATTACHMENT';

/** Per-company settings (Company.settings.driverEvents). */
export interface DriverEventSettings {
  /** Request a snapshot (0x8801) when an event is raised. */
  snapshot: boolean;
  /** Camera channel facing the driver (DMS events). */
  cabinChannel: number;
  /** Camera channel facing the road (ADAS events, crash). */
  roadChannel: number;
  /** Photos kept per event (snapshot + attachments). */
  maxPhotos: number;
  /** Days media and events are kept. */
  retentionDays: number;
  /** Media storage quota for the company, MB. New media is skipped once it is full. */
  quotaMb: number;
}

export const DRIVER_EVENT_DEFAULTS: DriverEventSettings = {
  snapshot: true,
  cabinChannel: 2,
  roadChannel: 1,
  maxPhotos: 3,
  retentionDays: 90,
  quotaMb: 2048,
};

export const DRIVER_EVENT_LIMITS = {
  maxPhotos: [1, 10],
  retentionDays: [7, 730],
  quotaMb: [50, 100_000],
  channel: [1, 16],
} as const;

/** Largest stored photo / clip. */
export const DRIVER_MEDIA_MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const DRIVER_MEDIA_MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/** Normalises stored settings (unknown keys dropped, out-of-range values replaced by the default). */
export function driverEventSettings(raw: unknown): DriverEventSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const int = (key: keyof DriverEventSettings, [min, max]: readonly [number, number]) => {
    const v = r[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : (DRIVER_EVENT_DEFAULTS[key] as number);
  };
  const L = DRIVER_EVENT_LIMITS;
  return {
    snapshot: typeof r.snapshot === 'boolean' ? r.snapshot : DRIVER_EVENT_DEFAULTS.snapshot,
    cabinChannel: int('cabinChannel', L.channel),
    roadChannel: int('roadChannel', L.channel),
    maxPhotos: int('maxPhotos', L.maxPhotos),
    retentionDays: int('retentionDays', L.retentionDays),
    quotaMb: int('quotaMb', L.quotaMb),
  };
}

/** Camera channel for an event type. */
export const snapshotChannel = (type: string, s: Pick<DriverEventSettings, 'cabinChannel' | 'roadChannel'>): number =>
  (CABIN_EVENT_TYPES as readonly string[]).includes(type) ? s.cabinChannel : s.roadChannel;

export interface DriverEventMediaDto {
  id: string;
  kind: DriverEventMediaKind;
  source: DriverEventMediaSource;
  channel: number | null;
  mime: string;
  size: number;
  capturedAt: string | null;
  /** Relative URL with a short-lived signed token, usable in <img> / <video> (`/api/driver-events/media/<id>?token=…`). */
  url: string;
  /** Video the browser can play (MP4); raw H.264 clips are download-only. */
  playable: boolean;
}

export interface DriverEventDto {
  id: string;
  alertId: string | null;
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  type: DriverEventType;
  level: number | null;
  speedKph: number | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  occurredAt: string;
  status: DriverEventStatus;
  reviewedByName: string | null;
  reviewedAt: string | null;
  note: string | null;
  media: DriverEventMediaDto[];
  /** First photo's URL, for list thumbnails. */
  thumbnailUrl: string | null;
}

export interface DriverEventReviewRequest {
  status: Exclude<DriverEventStatus, 'NEW'> | 'NEW';
  note?: string | null;
}

export interface DriverRiskRow {
  driverId: string | null;
  driverName: string | null;
  events: number;
  score: number;
}

export interface DriverEventStatsDto {
  total: number;
  today: number;
  week: number;
  withPhoto: number;
  byType: { type: DriverEventType; count: number }[];
  byDay: { day: string; count: number }[];
  /** Highest-risk drivers first (lowest score). */
  drivers: DriverRiskRow[];
}

/** Penalty points per event type (scaled by level 1–3 when known). */
export const DRIVER_EVENT_WEIGHTS: Record<DriverEventType, number> = {
  DRIVER_FATIGUE: 5,
  DRIVER_PHONE: 4,
  DRIVER_SMOKING: 2,
  DRIVER_DISTRACTED: 3,
  DRIVER_ABSENT: 2,
  FORWARD_COLLISION_WARNING: 4,
  LANE_DEPARTURE: 2,
  TAILGATING: 3,
  CRASH: 10,
};

/** Simple safety score 0–100: 100 minus the weighted penalties (dismissed events don't count). */
export function driverScore(events: { type: string; level: number | null; status?: string }[]): number {
  let penalty = 0;
  for (const e of events) {
    if (e.status === 'DISMISSED') continue;
    const w = DRIVER_EVENT_WEIGHTS[e.type as DriverEventType] ?? 1;
    penalty += w * Math.min(Math.max(e.level ?? 1, 1), 3);
  }
  return Math.max(0, 100 - penalty);
}
