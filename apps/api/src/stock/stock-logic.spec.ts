import { checkMoves, cleanSerials, fyOf, planMoves, planStatus, type PlanLine, type SerialNow } from './stock-logic';

const STORE = 'store';
const DAMAGED = 'damaged';
const ctx = { damagedLocationId: DAMAGED, partnerLocationId: 'reseller-1' };
const device = (serials: string[], condition: 'OK' | 'DAMAGED' = 'OK'): PlanLine => ({ itemId: 'gt06', serialTracked: true, qty: serials.length, serials, condition });
const cable = (qty: number): PlanLine => ({ itemId: 'relay', serialTracked: false, qty, serials: [], condition: 'OK' });
const names = { item: (id: string) => id, location: (id: string | null) => id ?? '—' };

describe('planMoves', () => {
  it('a receipt puts good units in the store and damaged ones on the damaged shelf', () => {
    const m = planMoves({ kind: 'RECEIPT', status: 'DONE', saleTo: null, locationId: STORE }, [device(['111', '222']), device(['333'], 'DAMAGED'), cable(5)], ctx);
    expect(m).toEqual([
      { itemId: 'gt06', locationId: STORE, qty: 1, serial: '111', effect: 'IN_STOCK' },
      { itemId: 'gt06', locationId: STORE, qty: 1, serial: '222', effect: 'IN_STOCK' },
      { itemId: 'gt06', locationId: DAMAGED, qty: 1, serial: '333', effect: 'DAMAGED' },
      { itemId: 'relay', locationId: STORE, qty: 5, serial: null, effect: 'IN_STOCK' },
    ]);
  });

  it('drafts, purchase orders and customer orders move nothing', () => {
    expect(planMoves({ kind: 'RECEIPT', status: 'DRAFT', saleTo: null, locationId: STORE }, [device(['111'])], ctx)).toEqual([]);
    expect(planMoves({ kind: 'PO', status: 'DONE', saleTo: null, locationId: STORE }, [device(['111'])], ctx)).toEqual([]);
  });

  it('a sale to a reseller leaves the store and lands in the reseller store, still in stock', () => {
    const m = planMoves({ kind: 'SALE', status: 'DONE', saleTo: 'PARTNER', locationId: STORE }, [device(['111'])], ctx);
    expect(m.map((x) => [x.locationId, x.qty, x.effect])).toEqual([
      [STORE, -1, 'SOLD'],
      ['reseller-1', 1, 'IN_STOCK'],
    ]);
  });

  it('own use and write-offs leave stock with their own status', () => {
    expect(planMoves({ kind: 'SALE', status: 'DONE', saleTo: 'OWN', locationId: STORE }, [cable(2)], ctx)[0]).toMatchObject({ qty: -2, effect: 'USED' });
    expect(planMoves({ kind: 'ADJUSTMENT', status: 'DONE', saleTo: null, locationId: STORE }, [cable(-3)], ctx)[0]).toMatchObject({ qty: -3, effect: 'SCRAPPED' });
  });

  it('cleans serials: trims, upper-cases, drops blanks and repeats', () => {
    expect(cleanSerials([' 86a1 ', '86A1', '', '9'])).toEqual(['86A1', '9']);
  });
});

describe('checkMoves', () => {
  const where = new Map<string, SerialNow>([
    ['gt06|111', { status: 'IN_STOCK', locationId: STORE }],
    ['gt06|222', { status: 'SOLD', locationId: null }],
    ['gt06|333', { status: 'DAMAGED', locationId: DAMAGED }],
  ]);
  const now = (i: string, s: string) => where.get(`${i}|${s}`);
  const onHand = (i: string, l: string | null) => (i === 'relay' && l === STORE ? 4 : 0);

  it('lets a sale take what is in the store and refuses what is not', () => {
    const ok = planMoves({ kind: 'SALE', status: 'DONE', saleTo: 'CUSTOMER', locationId: STORE }, [device(['111'])], ctx);
    expect(checkMoves('SALE', ok, now, onHand, names)).toEqual([]);
    const bad = planMoves({ kind: 'SALE', status: 'DONE', saleTo: 'CUSTOMER', locationId: STORE }, [device(['222', '999', '333'])], ctx);
    expect(checkMoves('SALE', bad, now, onHand, names)).toHaveLength(3);
  });

  it('refuses receiving an IMEI that is already in stock', () => {
    const m = planMoves({ kind: 'RECEIPT', status: 'DONE', saleTo: null, locationId: STORE }, [device(['111'])], ctx);
    expect(checkMoves('RECEIPT', m, now, onHand, names)[0]).toContain('already in stock');
  });

  it('only sold units can come back as a customer return; damaged units can go back to the supplier', () => {
    const ret = planMoves({ kind: 'SALES_RETURN', status: 'DONE', saleTo: null, locationId: STORE }, [device(['222']), device(['111'])], ctx);
    expect(checkMoves('SALES_RETURN', ret, now, onHand, names)).toHaveLength(1);
    const back = planMoves({ kind: 'PURCHASE_RETURN', status: 'DONE', saleTo: null, locationId: DAMAGED }, [device(['333'])], ctx);
    expect(checkMoves('PURCHASE_RETURN', back, now, onHand, names)).toEqual([]);
  });

  it('counted items: can not take more than the store holds', () => {
    const m = planMoves({ kind: 'SALE', status: 'DONE', saleTo: 'CUSTOMER', locationId: STORE }, [cable(3), cable(2)], ctx);
    expect(checkMoves('SALE', m, now, onHand, names)[0]).toBe('Only 4 of relay at store; 5 needed.');
  });
});

describe('planStatus and fyOf', () => {
  it('PO is open, then part received, then done', () => {
    const po = [{ itemId: 'gt06', qty: 10 }, { itemId: 'relay', qty: 5 }];
    expect(planStatus(po, []).status).toBe('OPEN');
    expect(planStatus(po, [{ itemId: 'gt06', qty: 4 }])).toEqual({ status: 'PARTIAL', pending: [{ itemId: 'gt06', qty: 6 }, { itemId: 'relay', qty: 5 }] });
    expect(planStatus(po, [{ itemId: 'gt06', qty: 10 }, { itemId: 'relay', qty: 5 }]).status).toBe('DONE');
  });

  it('financial year runs April to March', () => {
    expect(fyOf('2026-11-09')).toBe('26-27');
    expect(fyOf('2027-03-31')).toBe('26-27');
    expect(fyOf('2027-04-01')).toBe('27-28');
  });
});
