import { assertNoFinancialSteps, Catalog, planPurge, rootCondition, stepSql } from './purge-plan';

// A small model of the real schema: restrict / cascade / set-null / self-reference / logical (no FK) links.
const cat: Catalog = {
  fks: [
    { child: 'Device', col: 'companyId', parent: 'Company', refCol: 'id', del: 'r' },
    { child: 'TrackedObject', col: 'companyId', parent: 'Company', refCol: 'id', del: 'r' },
    { child: 'User', col: 'companyId', parent: 'Company', refCol: 'id', del: 'r' },
    { child: 'User', col: 'managerId', parent: 'User', refCol: 'id', del: 'r' },
    { child: 'Session', col: 'userId', parent: 'User', refCol: 'id', del: 'c' },
    { child: 'DeviceAssignment', col: 'deviceId', parent: 'Device', refCol: 'id', del: 'r' },
    { child: 'DeviceAssignment', col: 'objectId', parent: 'TrackedObject', refCol: 'id', del: 'r' },
    { child: 'LicenceSeat', col: 'deviceId', parent: 'Device', refCol: 'id', del: 'n' },
    { child: 'IoSession', col: 'objectId', parent: 'TrackedObject', refCol: 'id', del: 'c' },
  ],
  columns: new Map([
    ['Company', new Set(['id'])],
    ['Device', new Set(['id', 'companyId'])],
    ['TrackedObject', new Set(['id', 'companyId'])],
    ['User', new Set(['id', 'companyId', 'managerId'])],
    ['Session', new Set(['id', 'userId'])],
    ['DeviceAssignment', new Set(['id', 'deviceId', 'objectId'])],
    ['LicenceSeat', new Set(['id', 'deviceId', 'companyId'])],
    ['IoSession', new Set(['id', 'objectId', 'companyId'])],
    ['Position', new Set(['deviceId', 'objectId'])],
    ['Alert', new Set(['id', 'companyId', 'objectId', 'deviceId'])],
  ]),
};

const tables = (steps: { table: string; nullCol?: string }[]) => steps.map((s) => (s.nullCol ? `${s.table}.${s.nullCol}=NULL` : s.table));

describe('planPurge', () => {
  it('device: assignments, history without FK (positions, alerts), then the device; seats are left to SET NULL', () => {
    const steps = planPurge(cat, 'Device', rootCondition('11111111-2222-3333-4444-555555555555'));
    expect(tables(steps)).toEqual(['DeviceAssignment', 'Position', 'Alert', 'Device']);
    expect(stepSql(steps[1])).toBe(`DELETE FROM "Position" WHERE "deviceId" IN (SELECT "id" FROM "Device" WHERE "id" = '11111111-2222-3333-4444-555555555555')`);
  });

  it('every child is deleted before its parent, and a parent is deleted last', () => {
    const steps = planPurge(cat, 'Company', rootCondition('aaaaaaaa-2222-3333-4444-555555555555'));
    const order = tables(steps);
    const before = (a: string, b: string) => expect(order.indexOf(a)).toBeLessThan(order.lastIndexOf(b));
    before('DeviceAssignment', 'Device');
    before('DeviceAssignment', 'TrackedObject');
    before('Position', 'Device');
    before('IoSession', 'TrackedObject');
    before('Session', 'User');
    before('User.managerId=NULL', 'User');
    expect(order[order.length - 1]).toBe('Company');
    // Logical companyId links (no FK) are cleared too.
    expect(order).toContain('Alert');
    expect(order).toContain('LicenceSeat');
  });

  describe('financial tables (R-36 stop-gap)', () => {
    // The real billing edges (schema.prisma / licences_billing migrations), on top of the model above.
    const fin: Catalog = {
      fks: [
        ...cat.fks,
        { child: 'LicenceOrder', col: 'companyId', parent: 'Company', refCol: 'id', del: 'r' },
        { child: 'Invoice', col: 'companyId', parent: 'Company', refCol: 'id', del: 'r' },
        { child: 'Invoice', col: 'orderId', parent: 'LicenceOrder', refCol: 'id', del: 'r' },
        { child: 'CreditNote', col: 'companyId', parent: 'Company', refCol: 'id', del: 'r' },
        { child: 'CreditNote', col: 'invoiceId', parent: 'Invoice', refCol: 'id', del: 'r' },
        { child: 'BillingProfile', col: 'companyId', parent: 'Company', refCol: 'id', del: 'c' },
      ],
      columns: new Map([
        ...cat.columns,
        ['LicenceOrder', new Set(['id', 'companyId', 'status', 'paidAt', 'razorpayPaymentId'])],
        ['Invoice', new Set(['id', 'companyId', 'orderId'])],
        ['CreditNote', new Set(['id', 'companyId', 'invoiceId'])],
        ['BillingProfile', new Set(['id', 'companyId'])],
        // No FK, but a companyId column: would be reached as a logical link without the guard.
        ['UpiPaymentClaim', new Set(['id', 'companyId', 'ownerId'])],
        ['InvoiceCounter', new Set(['fy', 'companyId'])],
      ]),
    };

    it('a company plan never deletes invoices, credit notes, UPI claims or counters, and only unpaid orders', () => {
      const steps = planPurge(fin, 'Company', rootCondition('aaaaaaaa-2222-3333-4444-555555555555'));
      const names = tables(steps);
      for (const t of ['Invoice', 'CreditNote', 'UpiPaymentClaim', 'InvoiceCounter', 'CreditNoteCounter']) expect(names).not.toContain(t);
      expect(steps.map(stepSql).join('\n')).not.toMatch(/DELETE FROM "(Invoice|CreditNote|UpiPaymentClaim|InvoiceCounter|CreditNoteCounter|PlatformBillingSettings)"/);
      const order = steps.find((s) => s.table === 'LicenceOrder')!;
      expect(stepSql(order)).toBe(
        `DELETE FROM "LicenceOrder" WHERE ("companyId" IN (SELECT "id" FROM "Company" WHERE "id" = 'aaaaaaaa-2222-3333-4444-555555555555')) AND NOT ("status" = 'PAID' OR "paidAt" IS NOT NULL OR "razorpayPaymentId" IS NOT NULL)`,
      );
      // Everything else is planned as before.
      expect(names).toEqual(expect.arrayContaining(['BillingProfile', 'LicenceSeat', 'Device', 'User']));
      expect(names[names.length - 1]).toBe('Company');
    });

    it('device, object and user plans are unchanged and contain no financial table', () => {
      for (const t of ['Device', 'TrackedObject', 'User']) {
        expect(tables(planPurge(fin, t, rootCondition('11111111-2222-3333-4444-555555555555')))).toEqual(tables(planPurge(cat, t, rootCondition('11111111-2222-3333-4444-555555555555'))));
      }
    });

    it('a financial table is never a purge root', () => {
      expect(() => planPurge(fin, 'Invoice', rootCondition('11111111-2222-3333-4444-555555555555'))).toThrow('never purged');
    });

    it('a plan that would delete financial records is refused', () => {
      expect(() => assertNoFinancialSteps([{ table: 'Invoice', where: 'true' }])).toThrow('financial records (Invoice)');
      expect(() => assertNoFinancialSteps([{ table: 'LicenceOrder', where: '"companyId" = 1' }])).toThrow('LicenceOrder');
      expect(() => assertNoFinancialSteps([{ table: 'Device', where: 'true' }])).not.toThrow();
    });
  });

  it('rejects anything but a uuid as root id', () => {
    expect(() => rootCondition("1' OR '1'='1")).toThrow('Invalid id');
  });
});
