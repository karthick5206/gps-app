import type { LiveObject, MovementStatus } from '@veetracer/shared';
import { VEHICLE_ICON_IMAGES } from './vehicle-icon-images';

/** Marker kinds drawn by scripts/gen-vehicle-icons.mjs (same set as the web map). */
export type IconKind = 'CAR' | 'BIKE' | 'TRUCK' | 'BUS' | 'SCHOOL_BUS' | 'VAN' | 'AUTO' | 'OTHER' | 'PERSON' | 'ASSET' | 'PET';

const ROTATING = new Set<IconKind>(['CAR', 'BIKE', 'TRUCK', 'BUS', 'SCHOOL_BUS', 'VAN', 'AUTO', 'OTHER']);

export function iconKind(o: Pick<LiveObject, 'type' | 'vehicleType'>): IconKind {
  if (o.type === 'PERSON' || o.type === 'ASSET' || o.type === 'PET') return o.type;
  return (o.vehicleType as IconKind | null) ?? 'OTHER';
}

export const rotates = (kind: IconKind) => ROTATING.has(kind);

export type IconName = keyof typeof VEHICLE_ICON_IMAGES;

export function iconName(kind: IconKind, status: MovementStatus): IconName {
  return `${kind}-${status}`.toLowerCase() as IconName;
}

export function vehicleImage(o: Pick<LiveObject, 'type' | 'vehicleType' | 'status'>) {
  return VEHICLE_ICON_IMAGES[iconName(iconKind(o), o.status)];
}
