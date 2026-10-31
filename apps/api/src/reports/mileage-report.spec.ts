import { fullTankRuns, kmBetween } from '@veetracer/shared';
import { runsKmPerLitre } from '../expenses/mileage';
import { mileageRows, mileageTotals } from './mileage-report';
import { ObjInfo } from './report-queries';

const H = 3_600_000;
const D1 = Date.UTC(2026, 9, 1, 4); // day 1, 09:30 IST
const fill = (at: number, litres: number, fullTank = true, rupees = litres * 100) => ({ at, litres, amountPaise: rupees * 100, fullTank });

describe('mileage — full-tank method (manual fuel entries)', () => {
  it("user's example: 20 L full, drive 200 km, 10 L full next day → 20 km/L (not 250 ÷ 30)", () => {
    const runs = fullTankRuns([fill(D1, 20), fill(D1 + 24 * H, 10)]);
    expect(runs).toEqual([{ from: D1, to: D1 + 24 * H, litres: 10, amountPaise: 100_000, fills: 1 }]);
    // 200 km between the fill-ups; the 50 km driven after the second fill-up belongs to the next run.
    const trips = [
      { start: D1 + 1 * H, end: D1 + 5 * H, km: 200 },
      { start: D1 + 26 * H, end: D1 + 27 * H, km: 50 },
    ];
    const km = kmBetween(trips, runs[0].from, runs[0].to);
    expect(km).toBe(200);
    expect(runsKmPerLitre([{ ...runs[0], km }])).toBe(20);
  });

  it('partial fill-ups are added to the next full one; fills before the first full tank are ignored', () => {
    const runs = fullTankRuns([fill(D1 - H, 5, false), fill(D1, 30), fill(D1 + 10 * H, 8, false), fill(D1 + 20 * H, 12)]);
    expect(runs).toEqual([{ from: D1, to: D1 + 20 * H, litres: 20, amountPaise: 200_000, fills: 2 }]);
  });

  it('a partial fill-up not yet followed by a full one gives no run', () => {
    expect(fullTankRuns([fill(D1, 30), fill(D1 + H, 5, false)])).toEqual([]);
    expect(fullTankRuns([fill(D1, 30)])).toEqual([]);
  });

  it('trips crossing a fill-up count by time overlap', () => {
    expect(kmBetween([{ start: D1 - H, end: D1 + H, km: 40 }], D1, D1 + 10 * H)).toBe(20);
  });

  it('rows and fleet totals (km/L from sums, not averaged)', () => {
    const obj: ObjInfo = { name: 'Car A', plateNumber: 'TN 01', branchId: null, branchName: null, type: 'VEHICLE', vehicleType: null, speedLimitKph: null };
    const rows = mileageRows(
      new Map([['a', obj]]),
      new Map([['a', [
        { from: D1, to: D1 + 24 * H, litres: 10, amountPaise: 100_000, fills: 1, km: 200 },
        { from: D1 + 24 * H, to: D1 + 72 * H, litres: 20, amountPaise: 200_000, fills: 2, km: 250 },
      ]]]),
    );
    expect(rows.map((r) => [r.kmPerL, r.costPerKm])).toEqual([[20, 5], [12.5, 8]]);
    expect(mileageTotals(rows)).toMatchObject({ runs: 2, vehicles: 1, fillUps: 3, litres: 30, distanceKm: 450, kmPerL: 15, costPerKm: 6.67 });
  });
});
