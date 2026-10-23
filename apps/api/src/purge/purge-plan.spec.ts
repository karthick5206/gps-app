import { Catalog, planPurge, rootCondition, stepSql } from './purge-plan';

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

  it('rejects anything but a uuid as root id', () => {
    expect(() => rootCondition("1' OR '1'='1")).toThrow('Invalid id');
  });
});
