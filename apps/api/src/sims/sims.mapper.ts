import { Prisma } from '@prisma/client';
import {
  normalizeIccid,
  normalizeMsisdn,
  renewalState,
  SimCardDto,
  SimEventDto,
  SimEventKind,
  SimOwnership,
  SimPlanDto,
  SimProviderDto,
  SimProviderKind,
  SimReconcileFlag,
  SimStatus,
  SimUsageDto,
} from '@veetracer/shared';
import { iso, isoOrNull } from '../common/dto';
import { CsvSpec } from '../common/list-query';

export const RENEWAL_WINDOW_DAYS = 30;

export const PROVIDER_INCLUDE = { _count: { select: { sims: true } } } satisfies Prisma.SimProviderInclude;
export type ProviderRow = Prisma.SimProviderGetPayload<{ include: typeof PROVIDER_INCLUDE }>;

export const PLAN_INCLUDE = { provider: { select: { name: true } } } satisfies Prisma.SimPlanInclude;
export type PlanRow = Prisma.SimPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export const SIM_INCLUDE = {
  provider: { select: { id: true, name: true } },
  plan: { select: { id: true, name: true, validityDays: true, costPaise: true } },
  location: { select: { id: true, code: true, name: true } },
  assignments: {
    where: { toTime: null },
    take: 1,
    select: {
      id: true,
      fromTime: true,
      deviceId: true,
      device: { select: { id: true, uniqueId: true, iccid: true, simNumber: true, company: { select: { name: true } } } },
    },
  },
} satisfies Prisma.SimCardInclude;
export type SimRow = Prisma.SimCardGetPayload<{ include: typeof SIM_INCLUDE }>;

const contact = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {};

export function toProviderDto(p: ProviderRow): SimProviderDto {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind as SimProviderKind,
    supportContact: contact(p.supportContact),
    isActive: p.isActive,
    simCount: p._count.sims,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function toPlanDto(p: PlanRow): SimPlanDto {
  return {
    id: p.id,
    providerId: p.providerId,
    providerName: p.provider.name,
    name: p.name,
    dataMbPerMonth: p.dataMbPerMonth,
    smsPerMonth: p.smsPerMonth,
    validityDays: p.validityDays,
    costPaise: p.costPaise,
    pricePaise: p.pricePaise,
    isActive: p.isActive,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

const last10 = (v: string) => v.slice(-10);

/** Report-only comparison of the managed SIM with what the device row says (tracker ICCID, tenant SIM number). */
export function reconcileFlags(sim: { iccid: string; msisdn: string | null }, device: { iccid: string | null; simNumber: string | null } | null): SimReconcileFlag[] {
  if (!device) return [];
  const flags: SimReconcileFlag[] = [];
  const reported = normalizeIccid(device.iccid ?? '') ?? (device.iccid ? device.iccid.replace(/\D/g, '') : null);
  if (reported && reported !== sim.iccid) flags.push('ICCID_DIFFERS');
  const deviceNumber = normalizeMsisdn(device.simNumber ?? '');
  if (deviceNumber && sim.msisdn && last10(deviceNumber) !== last10(sim.msisdn)) flags.push('MSISDN_DIFFERS');
  return flags;
}

export const dateOnlyIso = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

export function toSimDto(s: SimRow, now = new Date()): SimCardDto {
  const a = s.assignments[0];
  const device = a?.device ?? null;
  return {
    id: s.id,
    iccid: s.iccid,
    msisdn: s.msisdn,
    imsi: s.imsi,
    provider: s.provider,
    plan: s.plan,
    status: s.status as SimStatus,
    ownership: s.ownership as SimOwnership,
    location: s.location,
    activatedAt: isoOrNull(s.activatedAt),
    renewalDueAt: dateOnlyIso(s.renewalDueAt),
    renewalState: ['DEACTIVATED', 'DAMAGED'].includes(s.status) ? 'NONE' : renewalState(s.renewalDueAt, RENEWAL_WINDOW_DAYS, now),
    statusChangedAt: iso(s.statusChangedAt),
    note: s.note,
    device:
      a && device
        ? { id: device.id, uniqueId: device.uniqueId, companyName: device.company?.name ?? null, reportedIccid: device.iccid, simNumber: device.simNumber, assignedAt: iso(a.fromTime) }
        : null,
    reconcile: reconcileFlags(s, device),
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export type EventRow = Prisma.SimEventGetPayload<object>;

export function toEventDto(e: EventRow, users: Map<string, string>): SimEventDto {
  return {
    id: e.id,
    simId: e.simId,
    iccidRef: e.iccidRef,
    kind: e.kind as SimEventKind,
    fromStatus: (e.fromStatus as SimStatus | null) ?? null,
    toStatus: (e.toStatus as SimStatus | null) ?? null,
    deviceId: e.deviceId,
    deviceRef: e.deviceRef,
    reason: e.reason,
    note: e.note,
    changes: (e.changes as Record<string, { from: unknown; to: unknown }> | null) ?? null,
    at: iso(e.at),
    createdByName: e.createdById ? (users.get(e.createdById) ?? null) : null,
  };
}

export function toUsageDto(u: Prisma.SimUsageGetPayload<object>, users: Map<string, string>): SimUsageDto {
  return {
    id: u.id,
    simId: u.simId,
    periodStart: dateOnlyIso(u.periodStart)!,
    periodEnd: dateOnlyIso(u.periodEnd)!,
    dataMb: u.dataMb,
    smsCount: u.smsCount,
    costPaise: u.costPaise,
    note: u.note,
    createdAt: iso(u.createdAt),
    createdByName: u.createdById ? (users.get(u.createdById) ?? null) : null,
  };
}

const rupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : (p / 100).toFixed(2));

export const SIM_CSV: CsvSpec<SimCardDto> = {
  name: 'sim-cards',
  columns: [
    { header: 'ICCID', value: (s) => s.iccid },
    { header: 'MSISDN', value: (s) => s.msisdn },
    { header: 'IMSI', value: (s) => s.imsi },
    { header: 'Provider', value: (s) => s.provider.name },
    { header: 'Plan', value: (s) => s.plan?.name },
    { header: 'Plan cost (INR)', value: (s) => rupees(s.plan?.costPaise) },
    { header: 'Status', value: (s) => s.status },
    { header: 'Ownership', value: (s) => s.ownership },
    { header: 'Location', value: (s) => s.location?.code },
    { header: 'Device IMEI', value: (s) => s.device?.uniqueId },
    { header: 'Customer', value: (s) => s.device?.companyName },
    { header: 'Activated at', value: (s) => s.activatedAt },
    { header: 'Renewal due', value: (s) => s.renewalDueAt },
    { header: 'Renewal state', value: (s) => s.renewalState },
    { header: 'Reconcile', value: (s) => s.reconcile.join(' ') },
    { header: 'Note', value: (s) => s.note },
  ],
};

export const PROVIDER_CSV: CsvSpec<SimProviderDto> = {
  name: 'sim-providers',
  columns: [
    { header: 'Name', value: (p) => p.name },
    { header: 'Kind', value: (p) => p.kind },
    { header: 'SIMs', value: (p) => p.simCount },
    { header: 'Active', value: (p) => (p.isActive ? 'Yes' : 'No') },
  ],
};

export const PLAN_CSV: CsvSpec<SimPlanDto> = {
  name: 'sim-plans',
  columns: [
    { header: 'Provider', value: (p) => p.providerName },
    { header: 'Name', value: (p) => p.name },
    { header: 'Data MB / month', value: (p) => p.dataMbPerMonth },
    { header: 'SMS / month', value: (p) => p.smsPerMonth },
    { header: 'Validity days', value: (p) => p.validityDays },
    { header: 'Cost (INR)', value: (p) => rupees(p.costPaise) },
    { header: 'Price (INR)', value: (p) => rupees(p.pricePaise) },
    { header: 'Active', value: (p) => (p.isActive ? 'Yes' : 'No') },
  ],
};

export const EVENT_CSV: CsvSpec<SimEventDto> = {
  name: 'sim-history',
  columns: [
    { header: 'At', value: (e) => e.at },
    { header: 'ICCID', value: (e) => e.iccidRef },
    { header: 'Kind', value: (e) => e.kind },
    { header: 'From', value: (e) => e.fromStatus },
    { header: 'To', value: (e) => e.toStatus },
    { header: 'Device', value: (e) => e.deviceRef },
    { header: 'Reason', value: (e) => e.reason },
    { header: 'Note', value: (e) => e.note },
    { header: 'By', value: (e) => e.createdByName },
  ],
};
