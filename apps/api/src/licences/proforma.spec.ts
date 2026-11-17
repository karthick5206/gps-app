import { PROFORMA_VALID_DAYS, selectionOf } from './billing.service';

describe('pro-forma ↔ payment matching', () => {
  it('ignores the order of seats and items, and zero quantities', () => {
    const a = selectionOf({ renewSeatIds: ['s2', 's1', 's1'], items: [{ type: 'DASHCAM', quantity: 1 }, { type: 'GPS_DEVICE', quantity: 2 }, { type: 'FUEL_SENSOR', quantity: 0 }] }, 95_000);
    const b = selectionOf({ renewSeatIds: ['s1', 's2'], items: [{ type: 'GPS_DEVICE', quantity: 2 }, { type: 'DASHCAM', quantity: 1 }] }, 95_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual({ renewSeatIds: ['s1', 's2'], items: [{ type: 'DASHCAM', quantity: 1, plan: null }, { type: 'GPS_DEVICE', quantity: 2, plan: null }], discountPaise: 95_000 });
  });

  it('a different discount or seat set is a different selection', () => {
    const base = { renewSeatIds: ['s1'], items: [] };
    expect(JSON.stringify(selectionOf(base, 0))).not.toBe(JSON.stringify(selectionOf(base, 100)));
    expect(JSON.stringify(selectionOf(base, 0))).not.toBe(JSON.stringify(selectionOf({ renewSeatIds: ['s2'], items: [] }, 0)));
    expect(PROFORMA_VALID_DAYS).toBe(15);
  });
});
