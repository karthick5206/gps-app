import { PASSENGER_IMPORT_COLUMNS } from '@veetracer/shared';
import { readPassengerCsv, validateImportRows } from './passenger-import';
import { SYNTHETIC_CITIES, generateSyntheticPassengers, isSyntheticRow, toImportCsv } from './synthetic-people';

describe('WP 2.5 synthetic ETMS data', () => {
  it('is deterministic, clearly synthetic, spread over the cities and near their areas', () => {
    const a = generateSyntheticPassengers({ count: 400, seed: 7 });
    expect(generateSyntheticPassengers({ count: 400, seed: 7 })).toEqual(a);
    expect(a.every(isSyntheticRow)).toBe(true);
    expect(new Set(a.map((p) => p.employee_code)).size).toBe(400);
    expect(new Set(a.map((p) => p.mobile)).size).toBe(400);
    for (const c of SYNTHETIC_CITIES) {
      const mine = a.filter((p) => p.employee_code.startsWith(`SYN-${c.key}-`));
      expect(mine).toHaveLength(100);
      for (const p of mine) {
        const near = c.areas.some((ar) => Math.hypot(Number(p.home_lat) - ar.lat, (Number(p.home_lng) - ar.lng) * Math.cos((ar.lat * Math.PI) / 180)) * 111.32 <= ar.radiusKm + 0.01);
        expect([p.employee_code, near]).toEqual([p.employee_code, true]);
      }
    }
  });

  it('the CSV passes the import validation once the offices exist', () => {
    const rows = generateSyntheticPassengers({ count: 50, cities: ['CHE', 'AUS'] });
    const csv = toImportCsv(rows);
    expect(csv.split('\n')[0]).toBe(PASSENGER_IMPORT_COLUMNS.join(','));
    const parsed = readPassengerCsv(Buffer.from(csv, 'utf8'));
    const offices = SYNTHETIC_CITIES.flatMap((c) => c.offices.map((o) => o.name));
    const sites = new Map(offices.map((n, i) => [n.toLowerCase(), { id: `site-${i}`, name: n }]));
    const validated = validateImportRows(parsed.rows, {
      country: 'IN',
      sites: sites as never,
      stops: new Map() as never,
      branches: new Map() as never,
      existing: new Map(),
      emailOwners: new Map(),
      mobileOwners: new Map(),
    });
    expect(validated.filter((v) => v.result.errors.length).map((v) => v.result.errors)).toEqual([]);
  });
});
