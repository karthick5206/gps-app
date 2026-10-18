import { Prisma } from '@prisma/client';
import { DeviceDto } from '@veetracer/shared';
import { iso, isoOrNull } from '../../common/dto';
import { CsvSpec, ListSpec } from '../../common/list-query';

/** Shared by the company Devices master and the platform Device Inventory. */
export const DEVICE_INCLUDE = {
  company: { select: { name: true } },
  model: { select: { brand: true, model: true, protocol: true } },
  assignments: { where: { toTime: null }, include: { object: { select: { id: true, name: true } } } },
} satisfies Prisma.DeviceInclude;
export type DeviceRow = Prisma.DeviceGetPayload<{ include: typeof DEVICE_INCLUDE }>;

export const DEVICE_LIST: ListSpec = {
  search: (q) => ({
    OR: [
      { uniqueId: { contains: q } },
      { simNumber: { contains: q } },
      { assignments: { some: { toTime: null, object: { name: { contains: q, mode: 'insensitive' } } } } },
    ],
  }),
  sort: {
    uniqueId: 'uniqueId',
    simNumber: 'simNumber',
    modelName: 'model.model',
    companyName: 'company.name',
    lastSeenAt: 'lastSeenAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: 'uniqueId',
};

export function deviceCsv(name: string): CsvSpec<DeviceDto> {
  return {
    name,
    columns: [
      { header: 'IMEI / Unique ID', value: (d) => d.uniqueId },
      { header: 'Model', value: (d) => d.modelName },
      { header: 'Protocol', value: (d) => d.protocol },
      { header: 'Company', value: (d) => d.companyName },
      { header: 'Object', value: (d) => d.object?.name },
      { header: 'SIM', value: (d) => d.simNumber },
      { header: 'Operator', value: (d) => d.simOperator },
      { header: 'Firmware', value: (d) => d.firmware },
      { header: 'Active', value: (d) => (d.isActive ? 'Yes' : 'No') },
      { header: 'Last seen', value: (d) => d.lastSeenAt },
    ],
  };
}

export function toDeviceDto(d: DeviceRow): DeviceDto {
  const object = d.assignments[0]?.object;
  return {
    id: d.id,
    uniqueId: d.uniqueId,
    companyId: d.companyId,
    companyName: d.company?.name ?? null,
    modelId: d.modelId,
    modelName: `${d.model.brand} ${d.model.model}`,
    protocol: d.model.protocol,
    simNumber: d.simNumber,
    simOperator: d.simOperator,
    firmware: d.firmware,
    isActive: d.isActive,
    lastSeenAt: isoOrNull(d.lastSeenAt),
    object: object ? { id: object.id, name: object.name } : null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

export function deviceSnapshot(d: DeviceRow) {
  const { company, model, assignments, ...scalars } = d;
  return { ...scalars, objectId: assignments[0]?.objectId ?? null };
}

export function assignedFilter(assigned: 'true' | 'false' | undefined): Prisma.DeviceWhereInput | null {
  if (assigned === undefined) return null;
  const open = { some: { toTime: null } };
  return assigned === 'true' ? { assignments: open } : { assignments: { none: { toTime: null } } };
}
