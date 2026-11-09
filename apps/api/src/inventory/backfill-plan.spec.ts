import { readFileSync } from 'fs';
import { join } from 'path';
import { BackfillDevice, planBackfill } from './backfill-plan';

const base: BackfillDevice = {
  id: 'd',
  uniqueId: '000',
  companyId: null,
  companyName: null,
  isActive: true,
  shippedAt: null,
  claimedAt: null,
  openObjectId: null,
  openObjectName: null,
  hasStock: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('inventory backfill plan (dry run)', () => {
  const devices: BackfillDevice[] = [
    { ...base, id: '1', uniqueId: 'A1' },
    { ...base, id: '2', uniqueId: 'A2', shippedAt: new Date() },
    { ...base, id: '3', uniqueId: 'A3', companyId: 'c', companyName: 'Acme' },
    { ...base, id: '4', uniqueId: 'A4', companyId: 'c', companyName: 'Acme', openObjectId: 'o', openObjectName: 'TN01', isActive: false },
    { ...base, id: '5', uniqueId: 'A5', hasStock: true },
  ];

  it('derives status from the existing assignment and skips tracked devices', () => {
    const plan = planBackfill(devices, { stockLocationCode: 'WH1' });
    expect(plan.skipped).toBe(1);
    expect(plan.rows.map((r) => [r.uniqueId, r.status, r.locationCode])).toEqual([
      ['A1', 'IN_STOCK', 'WH1'],
      ['A2', 'RESERVED', 'WH1'],
      ['A3', 'ASSIGNED', null],
      ['A4', 'ACTIVE', null],
    ]);
    expect(plan.rows[3].notes.join()).toMatch(/deactivated/);
    expect(plan.byStatus).toMatchObject({ IN_STOCK: 1, RESERVED: 1, ASSIGNED: 1, ACTIVE: 1, FAULTY: 0 });
    expect(plan.wouldInsert).toEqual({ deviceStock: 4, stockMovement: 4 });
    expect(plan.warnings.join()).toMatch(/Dry run only/);
  });

  it('warns when platform stock has no location', () => {
    const plan = planBackfill(devices, { stockLocationCode: null });
    expect(plan.warnings[0]).toMatch(/--location/);
    expect(plan.rows[0].notes.join()).toMatch(/without a location/);
  });

  it('the script has no write path', () => {
    const script = readFileSync(join(__dirname, '../../scripts/inventory-backfill-dry-run.ts'), 'utf8');
    expect(script).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction/);
    expect(script).toMatch(/--apply/);
  });
});
