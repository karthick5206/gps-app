import type { LiveObject, MovementStatus } from '@veetracer/shared';
import { VEHICLE_ICON_IMAGES } from './vehicle-icon-images';

/** Marker kinds drawn by scripts/gen-vehicle-icons.mjs (same set as the web map). */
export type IconKind = 'CAR' | 'BIKE' | 'TRUCK' | 'BUS' | 'SCHOOL_BUS' | 'VAN' | 'AUTO' | 'OTHER' | 'PERSON' | 'RUNNER' | 'ASSET' | 'PET';

/** A person moving faster than this (km/h) is drawn running instead of walking (same as the web map). */
export const PERSON_RUN_KPH = 10;
/** Moving people swap step pictures: runners every tick, walkers every other tick (450 ms). */
export const STEP_MS = 225;

const ROTATING = new Set<IconKind>(['CAR', 'BIKE', 'TRUCK', 'BUS', 'SCHOOL_BUS', 'VAN', 'AUTO', 'OTHER']);

export function iconKind(o: Pick<LiveObject, 'type' | 'vehicleType'> & { speedKph?: number }): IconKind {
  if (o.type === 'PERSON' && (o.speedKph ?? 0) > PERSON_RUN_KPH) return 'RUNNER';
  if (o.type === 'PERSON' || o.type === 'ASSET' || o.type === 'PET') return o.type;
  return (o.vehicleType as IconKind | null) ?? 'OTHER';
}

export const rotates = (kind: IconKind) => ROTATING.has(kind);

export type IconName = keyof typeof VEHICLE_ICON_IMAGES;

const isPerson = (kind: IconKind) => kind === 'PERSON' || kind === 'RUNNER';
const moving = (status: MovementStatus) => status === 'RUNNING' || status === 'OVERSPEED';

/** Image name; `tick` (a counter that advances every STEP_MS) animates moving people between their two steps. */
export function iconName(kind: IconKind, status: MovementStatus, tick = 0): IconName {
  const base = `${kind}-${status}`.toLowerCase();
  if (!isPerson(kind) || !moving(status)) return base as IconName;
  const second = kind === 'RUNNER' ? tick % 2 === 1 : Math.floor(tick / 2) % 2 === 1;
  return (second ? `${base}-b` : base) as IconName;
}

/** Whether any of these people is walking or running (so the map needs the step timer). */
export const hasMovingPeople = (objects: Pick<LiveObject, 'type' | 'status'>[]) => objects.some((o) => o.type === 'PERSON' && moving(o.status));

export function vehicleImage(o: Pick<LiveObject, 'type' | 'vehicleType' | 'status'>) {
  return VEHICLE_ICON_IMAGES[iconName(iconKind(o), o.status)];
}
