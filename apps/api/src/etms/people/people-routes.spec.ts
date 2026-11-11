import { GUARDS_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'crypto';
import type { AuthContext } from '../../access/auth-context';
import { REQUIRED_PERMISSIONS } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { PassengerImportService } from './passenger-import.service';
import { DriverLoginController, MyTransportConsentController, PassengersController, TransportVehiclesController } from './people.controller';

describe('E2 routes: every handler has a menu grant and the ETMS feature guard (doc 05 §1, 11 §3.1)', () => {
  for (const C of [PassengersController, MyTransportConsentController, TransportVehiclesController, DriverLoginController]) {
    it(C.name, () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, C)).toContain(TransportFeatureGuard);
      const handlers = Object.getOwnPropertyNames(C.prototype).filter((n) => n !== 'constructor');
      expect(handlers.length).toBeGreaterThan(0);
      for (const h of handlers) {
        const grants = Reflect.getMetadata(REQUIRED_PERMISSIONS, (C.prototype as unknown as Record<string, unknown>)[h] as object) as unknown[] | undefined;
        expect({ handler: h, grants: grants?.length ?? 0 }).toEqual({ handler: h, grants: expect.any(Number) });
        expect(grants?.length).toBeGreaterThan(0);
      }
    });
  }
});

/** Import commit against an in-memory store: idempotent re-import, row selection, dry run writes nothing. */
describe('PassengerImportService', () => {
  type Obj = Record<string, unknown>;
  function store() {
    const profiles: Obj[] = [];
    const auditRows: Obj[] = [];
    const prisma: Obj = {
      company: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
      poi: { findMany: async () => [{ id: 'site-1', name: 'HQ', category: 'OFFICE' }] },
      branch: { findMany: async () => [] },
      employeeTransportProfile: {
        findMany: async ({ where }: { where: Obj }) => (where.id ? profiles.filter((p) => (where.id as { in: string[] }).in.includes(p.id as string)) : profiles.filter((p) => p.companyId === where.companyId)),
        createMany: async ({ data }: { data: Obj[] }) => {
          let n = 0;
          for (const d of data) if (!profiles.some((p) => p.companyId === d.companyId && p.employeeCode === d.employeeCode)) (profiles.push({ ...d }), n++);
          return { count: n };
        },
        update: async ({ where, data }: { where: { id: string }; data: Obj }) => Object.assign(profiles.find((p) => p.id === where.id)!, data),
      },
      auditLog: { createMany: async ({ data }: { data: Obj[] }) => auditRows.push(...data) },
    };
    prisma.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
    const summaries: Obj[] = [];
    const svc = new PassengerImportService(prisma as never, { record: async (_c: unknown, e: Obj) => summaries.push(e) } as never, { enabled: false, search: async () => [] } as never);
    return { svc, profiles, auditRows, summaries };
  }
  const admin = { userId: 'u1', companyId: 'cA', dataScope: 'COMPANY', ip: null } as unknown as AuthContext;
  const file = (s: string) => ({ buffer: Buffer.from(s, 'utf8') });
  const csv = 'employee_code,name,mobile,office,home_lat,home_lng\nE1,Asha,9876500001,HQ,13.06,80.24\nE2,Ravi,9876500002,HQ,,\nE3,Bad,123,,,\n';

  it('dry run reports and writes nothing; commit creates; re-import creates 0 rows', async () => {
    const s = store();
    const preview = await s.svc.run(admin, file(csv), { commit: false, geocode: false });
    expect(preview).toMatchObject({ committed: false, totalRows: 3, creates: 2, errors: 1, updates: 0, unchanged: 0 });
    expect(preview.rows[1].warnings.map((w) => w.code)).toEqual(['NO_LOCATION']);
    expect(s.profiles).toHaveLength(0);

    const commit = await s.svc.run(admin, file(csv), { commit: true, geocode: false });
    expect(commit).toMatchObject({ committed: true, creates: 2, errors: 1 });
    expect(s.profiles.map((p) => p.employeeCode)).toEqual(['E1', 'E2']);
    expect(s.profiles[0]).toMatchObject({ companyId: 'cA', mobile: '+919876500001', officePoiId: 'site-1', homeGeocodeSource: 'IMPORT', createdById: 'u1' });
    expect(s.auditRows.filter((a) => a.action === 'CREATE')).toHaveLength(2);
    expect(commit.rows[0].passengerId).toBe(s.profiles[0].id);

    const again = await s.svc.run(admin, file(csv), { commit: true, geocode: false });
    expect(again).toMatchObject({ creates: 0, updates: 0, unchanged: 2, errors: 1 });
    expect(s.profiles).toHaveLength(2);
  });

  it('commit of selected rows only, and updates changed rows', async () => {
    const s = store();
    await s.svc.run(admin, file(csv), { commit: true, geocode: false, rows: '1' });
    expect(s.profiles.map((p) => p.employeeCode)).toEqual(['E1']);
    s.profiles[0].id = s.profiles[0].id ?? randomUUID();
    const r = await s.svc.run(admin, file('employee_code,name\nE1,Asha Krishnan\nE2,Ravi'), { commit: true, geocode: false });
    expect(r).toMatchObject({ creates: 1, updates: 1 });
    expect(s.profiles[0].displayName).toBe('Asha Krishnan');
  });

  it('branch-scoped roles cannot import; unreadable files are 400 IMPORT_FORMAT', async () => {
    const s = store();
    await expect(s.svc.run({ ...admin, dataScope: 'ASSIGNED' } as AuthContext, file(csv), { commit: false, geocode: false })).rejects.toMatchObject({ response: { code: 'FORBIDDEN_GRANT' } });
    await expect(s.svc.run(admin, file('a,b\n1,2'), { commit: false, geocode: false })).rejects.toMatchObject({ response: { code: 'IMPORT_FORMAT' } });
    await expect(s.svc.run(admin, undefined, { commit: false, geocode: false })).rejects.toMatchObject({ response: { code: 'IMPORT_FORMAT' } });
  });
});
