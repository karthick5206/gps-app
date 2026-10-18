import type { DeviceDto, DriverDto, MenuKey, TrackedObjectDto } from '@veetracer/shared';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';

/** Masters that admins manage from the app: list + add / edit / delete. */
export type ManageKind = 'vehicles' | 'devices' | 'drivers';

interface KindDef<T> {
  title: string;
  singular: string;
  /** Full English phrases (translation keys; translated where rendered). */
  addLabel: string;
  countOne: string;
  countMany: string;
  emptyTitle: string;
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
    addLabel: 'Add vehicle',
    countOne: '1 vehicle',
    countMany: '{{n}} vehicles',
    emptyTitle: 'No vehicles',
    endpoint: '/objects',
    menu: 'objects',
    search: 'Search name or plate',
    rowTitle: (r) => r.name,
    rowSubtitle: (r) =>
      [r.plateNumber, i18n.t(humanize(r.vehicleType ?? r.type)), r.device ? `IMEI ${r.device.uniqueId}` : i18n.t('No device'), r.isActive ? null : i18n.t('Inactive')].filter(Boolean).join(' · '),
  },
  devices: {
    title: 'Devices',
    singular: 'device',
    addLabel: 'Add device',
    countOne: '1 device',
    countMany: '{{n}} devices',
    emptyTitle: 'No devices',
    endpoint: '/devices',
    menu: 'devices',
    search: 'Search IMEI or SIM',
    rowTitle: (r) => r.uniqueId,
    rowSubtitle: (r) => [r.modelName, r.object ? i18n.t('on {{name}}', { name: r.object.name }) : i18n.t('Not fitted'), r.simNumber, r.isActive ? null : i18n.t('Inactive')].filter(Boolean).join(' · '),
  },
  drivers: {
    title: 'Drivers',
    singular: 'driver',
    addLabel: 'Add driver',
    countOne: '1 driver',
    countMany: '{{n}} drivers',
    emptyTitle: 'No drivers',
    endpoint: '/drivers',
    menu: 'drivers',
    search: 'Search name, mobile or employee ID',
    rowTitle: (r) => r.name,
    rowSubtitle: (r) => [r.employeeId, r.mobile, r.current ? i18n.t('driving {{name}}', { name: r.current.objectName }) : null, r.isActive ? null : i18n.t('Inactive')].filter(Boolean).join(' · '),
  },
};

export const isKind = (k: string | undefined): k is ManageKind => k === 'vehicles' || k === 'devices' || k === 'drivers';
