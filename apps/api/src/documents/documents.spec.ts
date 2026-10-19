import { NotFoundException } from '@nestjs/common';
import { addDays, documentStatus, DocumentsReportRow, serviceDue, serviceStatus } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { documentScopeWhere, DocumentsService } from './documents.service';
import { sortDocumentsReport } from '../reports/documents-report';
import { documentTransition, serviceTransition } from './reminder-logic';

const TODAY = '2026-10-19';

describe('documentStatus', () => {
  it('is valid outside the reminder window, expiring inside it and expired the day after expiry', () => {
    expect(documentStatus('2027-01-01', 30, TODAY)).toEqual({ status: 'VALID', daysLeft: 74 });
    expect(documentStatus('2026-11-18', 30, TODAY)).toEqual({ status: 'EXPIRING', daysLeft: 30 });
    expect(documentStatus('2026-11-19', 30, TODAY)).toEqual({ status: 'VALID', daysLeft: 31 });
    expect(documentStatus(TODAY, 30, TODAY)).toEqual({ status: 'EXPIRING', daysLeft: 0 });
    expect(documentStatus('2026-10-18', 30, TODAY)).toEqual({ status: 'EXPIRED', daysLeft: -1 });
  });

  it('honours the per-document reminder window and handles a missing expiry', () => {
    expect(documentStatus('2026-10-26', 7, TODAY).status).toBe('EXPIRING');
    expect(documentStatus('2026-10-27', 7, TODAY).status).toBe('VALID');
    expect(documentStatus('2026-10-20', 0, TODAY).status).toBe('VALID');
    expect(documentStatus(null, 30, TODAY)).toEqual({ status: 'NO_EXPIRY', daysLeft: null });
  });

  it('counts calendar days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(documentStatus('2027-01-01', 30, '2026-12-31').daysLeft).toBe(1);
  });
});

describe('service due computation', () => {
  const notify = { notifyBeforeDays: 7, notifyBeforeKm: 500 };

  it('adds each interval to the last service', () => {
    expect(serviceDue({ intervalKm: 10_000, intervalDays: 180, lastDoneAt: '2026-06-01', lastDoneOdometerKm: 42_000 })).toEqual({ dueAt: '2026-11-28', dueOdometerKm: 52_000 });
    expect(serviceDue({ intervalKm: 5000, intervalDays: null, lastDoneAt: '2026-06-01', lastDoneOdometerKm: 100.25 })).toEqual({ dueAt: null, dueOdometerKm: 5100.3 });
    expect(serviceDue({ intervalKm: null, intervalDays: 90, lastDoneAt: null, lastDoneOdometerKm: null })).toEqual({ dueAt: null, dueOdometerKm: null });
  });

  it('by km: ok, due soon inside notifyBeforeKm, overdue once the odometer passes it', () => {
    const s = { dueAt: null, dueOdometerKm: 52_000, ...notify };
    expect(serviceStatus(s, TODAY, 51_000)).toEqual({ status: 'OK', daysLeft: null, kmLeft: 1000 });
    expect(serviceStatus(s, TODAY, 51_600)).toMatchObject({ status: 'DUE_SOON', kmLeft: 400 });
    expect(serviceStatus(s, TODAY, 52_000)).toMatchObject({ status: 'OVERDUE', kmLeft: 0 });
    expect(serviceStatus(s, TODAY, null)).toMatchObject({ status: 'OK', kmLeft: null });
  });

  it('by days: due soon inside notifyBeforeDays, overdue after the due date', () => {
    const s = { dueAt: '2026-10-30', dueOdometerKm: null, ...notify };
    expect(serviceStatus(s, TODAY, 1000)).toMatchObject({ status: 'OK', daysLeft: 11 });
    expect(serviceStatus(s, '2026-10-23', 1000)).toMatchObject({ status: 'DUE_SOON', daysLeft: 7 });
    expect(serviceStatus(s, '2026-10-30', 1000)).toMatchObject({ status: 'DUE_SOON', daysLeft: 0 });
    expect(serviceStatus(s, '2026-10-31', 1000)).toMatchObject({ status: 'OVERDUE', daysLeft: -1 });
  });

  it('date and odometer: whichever comes first', () => {
    const s = { dueAt: '2027-03-01', dueOdometerKm: 52_000, ...notify };
    expect(serviceStatus(s, TODAY, 52_100).status).toBe('OVERDUE');
    expect(serviceStatus(s, '2027-03-02', 10_000).status).toBe('OVERDUE');
    expect(serviceStatus(s, '2027-02-25', 10_000).status).toBe('DUE_SOON');
  });
});

describe('reminder transitions', () => {
  it('documents: one alert per state, silent reset when renewed', () => {
    expect(documentTransition('EXPIRING', null)).toEqual({ next: 'EXPIRING', alert: 'DOCUMENT_EXPIRING' });
    expect(documentTransition('EXPIRING', 'EXPIRING')).toBeNull();
    expect(documentTransition('EXPIRED', 'EXPIRING')).toEqual({ next: 'EXPIRED', alert: 'DOCUMENT_EXPIRED' });
    expect(documentTransition('EXPIRED', null)).toEqual({ next: 'EXPIRED', alert: 'DOCUMENT_EXPIRED' });
    expect(documentTransition('EXPIRED', 'EXPIRED')).toBeNull();
    expect(documentTransition('VALID', 'EXPIRED')).toEqual({ next: null, alert: null });
    expect(documentTransition('VALID', null)).toBeNull();
    expect(documentTransition('NO_EXPIRY', null)).toBeNull();
  });

  it('services: due soon, then overdue, once each', () => {
    expect(serviceTransition('DUE_SOON', null)).toEqual({ next: 'DUE_SOON', alert: 'SERVICE_DUE' });
    expect(serviceTransition('DUE_SOON', 'DUE_SOON')).toBeNull();
    expect(serviceTransition('OVERDUE', 'DUE_SOON')).toEqual({ next: 'OVERDUE', alert: 'SERVICE_DUE' });
    expect(serviceTransition('OVERDUE', 'OVERDUE')).toBeNull();
    expect(serviceTransition('OK', 'OVERDUE')).toEqual({ next: null, alert: null });
  });
});

// ───────────── scoping ─────────────

/** Tiny evaluator for the Prisma where shapes the scope helpers produce (AND / OR / equals / in / is / relations). */
type Rec = Record<string, unknown>;
function matches(row: Rec | null | undefined, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  if (!row) return false;
  return Object.entries(where as Rec).every(([key, cond]) => {
    if (key === 'AND') return (cond as unknown[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as unknown[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Rec;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('is' in c) return matches(value as Rec | null, c.is);
      return matches(value as Rec | null, c);
    }
    return value === cond;
  });
}

const COMPANY = 'c1';
const vehicle = (id: string, branchId: string | null) => ({ id, companyId: COMPANY, branchId });
const driver = (id: string, branchId: string | null) => ({ id, companyId: COMPANY, branchId });
const DOCS: Rec[] = [
  { id: 'doc-north-truck', companyId: COMPANY, object: vehicle('v-north', 'b-north'), driver: null },
  { id: 'doc-south-truck', companyId: COMPANY, object: vehicle('v-south', 'b-south'), driver: null },
  { id: 'doc-mapped-truck', companyId: COMPANY, object: vehicle('v-mapped', 'b-south'), driver: null },
  { id: 'doc-north-driver', companyId: COMPANY, object: null, driver: driver('d-north', 'b-north') },
  { id: 'doc-south-driver', companyId: COMPANY, object: null, driver: driver('d-south', 'b-south') },
  { id: 'doc-pool-driver', companyId: COMPANY, object: null, driver: driver('d-pool', null) },
  { id: 'doc-other-company', companyId: 'c2', object: { id: 'v-x', companyId: 'c2', branchId: 'b-north' }, driver: null },
];

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'u1',
  homeCompanyId: COMPANY,
  companyId: COMPANY,
  isSuperAdmin: false,
  permissions: { documents: ['view'] },
  dataScope: 'ASSIGNED',
  branchIds: ['b-north'],
  objectIds: ['v-mapped'],
  ip: null,
  ...over,
});

describe('document scoping', () => {
  const visible = (c: AuthContext) => DOCS.filter((d) => matches(d, documentScopeWhere(c))).map((d) => d.id);

  it('a branch-scoped user sees only their branches\' (and mapped) vehicles and drivers, plus company-wide drivers', () => {
    expect(visible(ctx())).toEqual(['doc-north-truck', 'doc-mapped-truck', 'doc-north-driver', 'doc-pool-driver']);
  });

  it('whole-company scope sees every document of the company, never another company', () => {
    expect(visible(ctx({ dataScope: 'COMPANY' }))).toEqual(DOCS.filter((d) => d.companyId === COMPANY).map((d) => d.id));
  });

  it('get() of another branch\'s document is "not found"', async () => {
    const prisma = {
      company: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
      user: { findMany: async () => [] },
      document: {
        findFirst: async ({ where }: { where: unknown }) => {
          const hit = DOCS.find((d) => matches(d, where));
          return hit ? { ...hit, objectId: (hit.object as Rec | null)?.id ?? null, driverId: (hit.driver as Rec | null)?.id ?? null, type: 'PUC', number: null, issuedOn: null, expiresOn: null, reminderDays: 30, notes: null, fileName: null, filePath: null, fileType: null, fileSize: null, createdById: null, createdAt: new Date(), updatedAt: new Date() } : null;
        },
      },
    };
    const service = new DocumentsService(prisma as never, {} as never);
    await expect(service.get(ctx(), 'doc-south-truck')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(ctx(), 'doc-south-driver')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(ctx(), 'doc-north-truck')).resolves.toMatchObject({ id: 'doc-north-truck', owner: 'VEHICLE' });
  });
});

describe('documents report ordering', () => {
  it('lists expired / overdue first, then due soon, then valid, nearest first', () => {
    const row = (status: DocumentsReportRow['status'], daysLeft: number | null, kmLeft: number | null = null): DocumentsReportRow => ({
      kind: 'DOCUMENT', vehicle: 'Truck', driver: null, item: status, number: null, dueOn: null, dueOdometerKm: null, daysLeft, kmLeft, status,
    });
    const sorted = sortDocumentsReport([row('VALID', 90), row('DUE_SOON', null, 300), row('EXPIRED', -3), row('EXPIRING', 10), row('OVERDUE', -10), row('NO_EXPIRY', null)]);
    expect(sorted.map((r) => r.status)).toEqual(['OVERDUE', 'EXPIRED', 'DUE_SOON', 'EXPIRING', 'VALID', 'NO_EXPIRY']);
  });
});
