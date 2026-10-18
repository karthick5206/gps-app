import type { DeviceDto, DriverDto, MenuKey, TrackedObjectDto } from '@veetracer/shared';
import { humanize } from '@/lib/format';

/** Masters that admins manage from the app: list + add / edit / delete. */
export type ManageKind = 'vehicles' | 'devices' | 'drivers';

interface KindDef<T> {
  title: string;
  singular: string;
  endpoint: string;
  menu: MenuKey;
  search: string;
  rowTitle: (r: T) => string;
  rowSubtitle: (r: T) => string;
}

export const KINDS: { vehicles: KindDef<TrackedObjectDto>; devices: KindDef<DeviceDto>; drivers: KindDef<DriverDto> } = {
  vehicles: {
    title: 'Vehicles',
    singular: 'vehicle',
    endpoint: '/objects',
    menu: 'objects',
    search: 'Search name or plate',
    rowTitle: (r) => r.name,
    rowSubtitle: (r) =>
      [r.plateNumber, humanize(r.vehicleType ?? r.type), r.device ? `IMEI ${r.device.uniqueId}` : 'No device', r.isActive ? null : 'Inactive'].filter(Boolean).join(' · '),
  },
  devices: {
    title: 'Devices',
    singular: 'device',
    endpoint: '/devices',
    menu: 'devices',
    search: 'Search IMEI or SIM',
    rowTitle: (r) => r.uniqueId,
    rowSubtitle: (r) => [r.modelName, r.object ? `on ${r.object.name}` : 'Not fitted', r.simNumber, r.isActive ? null : 'Inactive'].filter(Boolean).join(' · '),
  },
  drivers: {
    title: 'Drivers',
    singular: 'driver',
    endpoint: '/drivers',
    menu: 'drivers',
    search: 'Search name, mobile or employee ID',
    rowTitle: (r) => r.name,
    rowSubtitle: (r) => [r.employeeId, r.mobile, r.current ? `driving ${r.current.objectName}` : null, r.isActive ? null : 'Inactive'].filter(Boolean).join(' · '),
  },
};

export const isKind = (k: string | undefined): k is ManageKind => k === 'vehicles' || k === 'devices' || k === 'drivers';
