import { AlertTypeCode, EffectiveAlertSetting } from '@veetracer/shared';
import { ReminderAlert, RemindersJob } from './reminders-job';

const D = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
/** 2026-10-19 10:00 IST */
const NOW = Date.UTC(2026, 9, 19, 4, 30);
const DAY = 86_400_000;

const truck = { id: 'v1', name: 'Truck 01', plateNumber: 'TN01AB1234', branchId: 'b1', isActive: true };

interface World {
  documents: Record<string, unknown>[];
  drivers: Record<string, unknown>[];
  services: Record<string, unknown>[];
  distanceKm: number;
  odometerOffsetKm: number;
}

/** In-memory stand-in for the Prisma calls the job makes; updateMany honours the `notifiedState` claim condition. */
function fakePrisma(w: World) {
  const claim = (rows: Record<string, unknown>[], field: string) => async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const row = rows.find((r) => r.id === where.id && r[field] === where[field]);
    if (!row) return { count: 0 };
    row[field] = data[field];
    return { count: 1 };
  };
  return {
    company: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
    document: { findMany: async () => w.documents.map((d) => ({ ...d })), updateMany: claim(w.documents, 'notifiedState') },
    driver: { findMany: async () => w.drivers.map((d) => ({ ...d })), updateMany: claim(w.drivers, 'licenseNotifiedState') },
    serviceReminder: { findMany: async () => w.services.map((s) => ({ ...s })), updateMany: claim(w.services, 'notifiedState') },
    dailySummary: { groupBy: async () => [{ objectId: 'v1', _sum: { distanceKm: w.distanceKm } }] },
    trackedObject: { findMany: async () => [{ id: 'v1', odometerOffsetKm: w.odometerOffsetKm }] },
  };
}

function setup(world: Partial<World> = {}, settings: Partial<Record<AlertTypeCode, Partial<EffectiveAlertSetting>>> = {}) {
  const w: World = { documents: [], drivers: [], services: [], distanceKm: 0, odometerOffsetKm: 0, ...world };
  const raised: ReminderAlert[] = [];
  const setting = (type: AlertTypeCode): EffectiveAlertSetting =>
    ({ alertType: type, supported: true, enabled: true, severity: type === 'DOCUMENT_EXPIRED' ? 'CRITICAL' : 'WARNING', snoozedUntil: null, ...settings[type] }) as EffectiveAlertSetting;
  const job = new RemindersJob({
    prisma: fakePrisma(w) as never,
    rules: async () => ({ effective: () => new Map((['DOCUMENT_EXPIRING', 'DOCUMENT_EXPIRED', 'SERVICE_DUE'] as AlertTypeCode[]).map((t) => [t, setting(t)])) }),
    raise: async (a) => {
      raised.push(a);
    },
  });
  return { w, raised, job };
}

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'doc1',
  companyId: 'c1',
  objectId: 'v1',
  driverId: null,
  type: 'INSURANCE',
  number: 'POL-77',
  expiresOn: D('2026-11-01'),
  reminderDays: 30,
  notifiedState: null,
  object: truck,
  driver: null,
  ...over,
});

describe('RemindersJob', () => {
  it('raises DOCUMENT_EXPIRING once, however often it runs (idempotent)', async () => {
    const { w, raised, job } = setup({ documents: [doc()] });
    expect(await job.runCompany('c1', NOW)).toMatchObject({ raised: 1 });
    await job.runCompany('c1', NOW + 3600_000);
    await job.runCompany('c1', NOW + DAY);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: 'DOCUMENT_EXPIRING', severity: 'WARNING', object: { id: 'v1' }, message: 'Insurance (POL-77) expires on 2026-11-01 (in 13 days)' });
    expect(raised[0].data).toMatchObject({ documentId: 'doc1', expiresOn: '2026-11-01', daysLeft: 13 });
    expect(w.documents[0].notifiedState).toBe('EXPIRING');
  });

  it('then DOCUMENT_EXPIRED once, the day after expiry', async () => {
    const { raised, job } = setup({ documents: [doc({ notifiedState: 'EXPIRING' })] });
    await job.runCompany('c1', Date.UTC(2026, 10, 1, 12)); // expiry day: still valid
    expect(raised).toHaveLength(0);
    await job.runCompany('c1', Date.UTC(2026, 10, 2, 4));
    await job.runCompany('c1', Date.UTC(2026, 10, 5, 4));
    expect(raised.map((a) => [a.type, a.severity])).toEqual([['DOCUMENT_EXPIRED', 'CRITICAL']]);
  });

  it('two instances racing on the same row alert only once (conditional claim)', async () => {
    const { raised, job } = setup({ documents: [doc()] });
    await Promise.all([job.runCompany('c1', NOW), job.runCompany('c1', NOW)]);
    expect(raised).toHaveLength(1);
  });

  it('a disabled alert type advances the state without alerting (no backlog later)', async () => {
    const { w, raised, job } = setup({ documents: [doc()] }, { DOCUMENT_EXPIRING: { enabled: false } });
    await job.runCompany('c1', NOW);
    expect(raised).toHaveLength(0);
    expect(w.documents[0].notifiedState).toBe('EXPIRING');
  });

  it('renewed documents reset silently; documents outside the window do nothing', async () => {
    const { w, raised, job } = setup({ documents: [doc({ id: 'renewed', expiresOn: D('2027-11-01'), notifiedState: 'EXPIRED' }), doc({ id: 'far', expiresOn: D('2027-05-01') })] });
    expect(await job.runCompany('c1', NOW)).toMatchObject({ raised: 0, cleared: 1 });
    expect(raised).toHaveLength(0);
    expect(w.documents.map((d) => d.notifiedState)).toEqual([null, null]);
  });

  it('driver documents alert on the driver\'s vehicle; without one they wait (unclaimed)', async () => {
    const withVehicle = doc({ id: 'dl1', objectId: null, driverId: 'd1', type: 'DRIVING_LICENCE', number: 'TN01 2020', object: null, driver: { name: 'Arun', isActive: true, assignments: [{ object: truck }] } });
    const noVehicle = doc({ id: 'dl2', objectId: null, driverId: 'd2', type: 'DRIVING_LICENCE', number: null, object: null, driver: { name: 'Bala', isActive: true, assignments: [] } });
    const { w, raised, job } = setup({ documents: [withVehicle, noVehicle] });
    expect(await job.runCompany('c1', NOW)).toMatchObject({ raised: 1, noVehicle: 1 });
    expect(raised[0]).toMatchObject({ object: { id: 'v1' }, message: 'Driving licence of driver Arun (TN01 2020) expires on 2026-11-01 (in 13 days)', data: { driverId: 'd1' } });
    expect(w.documents[1].notifiedState).toBeNull();
  });

  it('licence expiry on the driver record is reminded too', async () => {
    const drv = { id: 'd1', name: 'Arun', isActive: true, licenseNo: 'DL-9', licenseExpiry: D('2026-10-10'), licenseNotifiedState: null, assignments: [{ object: truck }] };
    const { w, raised, job } = setup({ drivers: [drv] });
    await job.runCompany('c1', NOW);
    await job.runCompany('c1', NOW + DAY);
    expect(raised.map((a) => a.type)).toEqual(['DOCUMENT_EXPIRED']);
    expect(w.drivers[0].licenseNotifiedState).toBe('EXPIRED');
  });

  it('SERVICE_DUE by odometer: once when due soon, once more when overdue', async () => {
    const service = { id: 's1', companyId: 'c1', objectId: 'v1', title: 'Engine oil', isActive: true, dueAt: null, dueOdometerKm: 52_000, notifyBeforeDays: 7, notifyBeforeKm: 500, notifiedState: null, object: truck };
    const { w, raised, job } = setup({ services: [service], distanceKm: 51_000, odometerOffsetKm: 0 });
    await job.runCompany('c1', NOW);
    expect(raised).toHaveLength(0);
    w.distanceKm = 51_600;
    await job.runCompany('c1', NOW);
    await job.runCompany('c1', NOW);
    w.odometerOffsetKm = 500; // odometer = recorded distance + offset
    await job.runCompany('c1', NOW);
    expect(raised.map((a) => a.message)).toEqual(['Engine oil due at 52,000 km — 400 km left', 'Engine oil overdue (was due at 52,000 km)']);
    expect(w.services[0].notifiedState).toBe('OVERDUE');
  });

  it('SERVICE_DUE by date', async () => {
    const service = { id: 's1', companyId: 'c1', objectId: 'v1', title: 'Annual service', isActive: true, dueAt: D('2026-10-24'), dueOdometerKm: null, notifyBeforeDays: 7, notifyBeforeKm: 500, notifiedState: null, object: truck };
    const { raised, job } = setup({ services: [service] });
    await job.runCompany('c1', NOW);
    expect(raised[0]).toMatchObject({ type: 'SERVICE_DUE', message: 'Annual service due on 2026-10-24 — in 5 days', data: { daysLeft: 5 } });
  });
});
