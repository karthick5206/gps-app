import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ackRequiredFor, defaultRequireAck, isAckMandatory } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { LiveGateway } from '../../live/live.gateway';
import { AlertStateMessage, AlertSyncService } from '../alerts/alert-sync.service';
import { AlertsService } from '../alerts/alerts.service';
import { isAlertRead, readSql } from './alert-read';

const T = (iso: string) => new Date(iso);
const USER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const OBJ_IN = '33333333-3333-4333-8333-333333333333';
const OBJ_OUT = '44444444-4444-4444-8444-444444444444';
const ALERT = '55555555-5555-4555-8555-555555555555';

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: USER,
  homeCompanyId: COMPANY,
  companyId: COMPANY,
  isSuperAdmin: false,
  permissions: { alerts: ['view'] },
  dataScope: 'COMPANY',
  branchIds: [],
  objectIds: [],
  ip: null,
  ...over,
});

describe('isAlertRead', () => {
  const base = { status: 'NEW', occurredAt: T('2026-10-20T10:00:00Z'), explicit: false, watermark: null };

  it('a NEW alert nobody opened is unread', () => {
    expect(isAlertRead(base)).toBe(false);
  });

  it('opening it (explicit read row) makes it read for that user', () => {
    expect(isAlertRead({ ...base, explicit: true })).toBe(true);
  });

  it('acknowledged or resolved alerts are read for everyone', () => {
    expect(isAlertRead({ ...base, status: 'ACKNOWLEDGED' })).toBe(true);
    expect(isAlertRead({ ...base, status: 'RESOLVED' })).toBe(true);
  });

  it('"mark all as read" watermark covers alerts that occurred at or before it, not later ones', () => {
    expect(isAlertRead({ ...base, watermark: T('2026-10-20T10:00:00Z') })).toBe(true);
    expect(isAlertRead({ ...base, watermark: T('2026-10-20T11:00:00Z') })).toBe(true);
    expect(isAlertRead({ ...base, watermark: T('2026-10-20T09:59:59Z') })).toBe(false);
  });
});

describe('default require-acknowledgement rule', () => {
  it('emergencies and device disconnection need acknowledgement at any severity', () => {
    for (const type of ['SOS', 'CRASH', 'POWER_CUT', 'DEVICE_OFFLINE']) expect(defaultRequireAck(type, 'INFO')).toBe(true);
  });

  it('every CRITICAL alert needs acknowledgement; other alerts do not', () => {
    expect(defaultRequireAck('OVERSPEED', 'CRITICAL')).toBe(true);
    expect(defaultRequireAck('OVERSPEED', 'WARNING')).toBe(false);
    expect(defaultRequireAck('IGNITION_ON', 'INFO')).toBe(false);
    expect(defaultRequireAck('GEOFENCE_EXIT', 'WARNING')).toBe(false);
  });

  it('ackRequiredFor: a configured value wins, the default follows the alert\'s own severity, SOS/crash always', () => {
    const inherited = { alertType: 'OVERSPEED' as const, requireAck: false, sources: { requireAck: 'DEFAULT' as const } };
    expect(ackRequiredFor(inherited, 'OVERSPEED', 'WARNING')).toBe(false);
    expect(ackRequiredFor(inherited, 'OVERSPEED', 'CRITICAL')).toBe(true); // escalated by the rule
    const off = { alertType: 'OVERSPEED' as const, requireAck: false, sources: { requireAck: 'COMPANY' as const } };
    expect(ackRequiredFor(off, 'OVERSPEED', 'CRITICAL')).toBe(false);
    const on = { alertType: 'IGNITION_ON' as const, requireAck: true, sources: { requireAck: 'OBJECT' as const } };
    expect(ackRequiredFor(on, 'IGNITION_ON', 'INFO')).toBe(true);
    expect(ackRequiredFor({ alertType: 'SOS', requireAck: false, sources: { requireAck: 'COMPANY' } }, 'SOS', 'INFO')).toBe(true);
    expect(ackRequiredFor(undefined, 'POWER_CUT', 'WARNING')).toBe(true);
    expect(isAckMandatory('CRASH')).toBe(true);
    expect(isAckMandatory('POWER_CUT')).toBe(false);
  });
});

describe('readSql', () => {
  it('combines status, watermark and the per-user read row, bound to the user id', () => {
    const sql = readSql(USER);
    expect(sql.sql).toContain(`a."status" <> 'NEW'`);
    expect(sql.sql).toContain(`"alertsReadBefore"`);
    expect(sql.sql).toContain(`a."occurredAt" <= COALESCE(`);
    expect(sql.sql).toContain(`COALESCE(`);
    expect(sql.text).toMatch(/EXISTS \(SELECT 1 FROM "AlertRead" r WHERE r\."alertId" = a\.id AND r\."userId" = \$\d+::uuid\)/);
    expect(sql.values).toEqual([USER, USER]);
  });
});

/** Prisma stub: records raw SQL, scoped finds and writes. */
function setup(opts: { objectsInScope?: string[]; alert?: Record<string, unknown> | null; type?: string; severity?: string; ackRequired?: boolean } = {}) {
  const raw: Prisma.Sql[] = [];
  const published: AlertStateMessage[] = [];
  const alertRow = opts.alert === undefined ? { id: ALERT, objectId: OBJ_IN, status: 'NEW', type: opts.type ?? 'OVERSPEED', severity: opts.severity ?? 'WARNING', ackRequired: opts.ackRequired ?? false, ackById: null, geofenceId: null, occurredAt: T('2026-10-20T10:00:00Z') } : opts.alert;
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      raw.push(sql);
      return sql.sql.includes('count(*)') ? [{ n: 3, p: 2 }] : [];
    }),
    trackedObject: { findMany: jest.fn(async () => (opts.objectsInScope ?? []).map((id) => ({ id }))) },
    alert: {
      findFirst: jest.fn(async () => alertRow),
      findMany: jest.fn(async ({ where }: { where: { AND: { objectId?: { in: string[] }; id?: { in: string[] } }[] } }) => {
        const scope = where.AND[0].objectId?.in;
        const ids = where.AND.find((w) => w.id)?.id?.in ?? [];
        const objectOf = (id: string) => (id === ALERT ? OBJ_IN : OBJ_OUT);
        return ids.filter((id) => !scope || scope.includes(objectOf(id))).map((id) => ({ id, objectId: objectOf(id) }));
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...alertRow, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    alertRead: { createMany: jest.fn(async () => ({ count: 1 })) },
    user: { update: jest.fn(async () => ({})), findUnique: jest.fn(async () => ({ name: 'Admin' })), findMany: jest.fn(async () => [{ id: USER, name: 'Admin' }]) },
    geofence: { findMany: jest.fn(async () => []) },
  };
  const redis = { client: { publish: jest.fn(async (_c: string, m: string) => published.push(JSON.parse(m) as AlertStateMessage)) } };
  const service = new AlertsService(prisma as never, new AlertSyncService(redis as never));
  return { service, prisma, raw, published };
}

describe('AlertsService read state', () => {
  it('unread count: per user, NEW only, last 7 days, company scope; pendingAck alongside', async () => {
    const { service, raw } = setup();
    await expect(service.unreadCount(ctx())).resolves.toEqual({ count: 3, pendingAck: 2 });
    expect(raw[0].sql).toContain(`count(*) FILTER (WHERE a."ackRequired")`);
    const sql = raw[0];
    expect(sql.sql).toContain(`a."status" = 'NEW'`);
    expect(sql.sql).toContain('NOT (a."status"');
    expect(sql.sql).not.toContain('"objectId" = ANY');
    expect(sql.values).toContain(COMPANY);
    expect(sql.values.filter((v) => v === USER)).toHaveLength(2);
    const since = sql.values.find((v) => v instanceof Date) as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThan(7 * 86_400_000 - 5000);
  });

  it('unread count: assigned scope is limited to the user\'s objects', async () => {
    const { service, raw } = setup({ objectsInScope: [OBJ_IN] });
    await service.unreadCount(ctx({ dataScope: 'ASSIGNED', objectIds: [OBJ_IN] }));
    expect(raw[0].sql).toContain('a."objectId" = ANY(');
    expect(raw[0].values).toContainEqual([OBJ_IN]);
  });

  it('list: read=false / read=true filter on the same per-user expression', async () => {
    const { service, raw } = setup();
    await service.list(ctx(), { read: false });
    expect(raw[0].sql).toContain('NOT (a."status"');
    expect(raw[0].sql).toContain('AS "read"');
    await service.list(ctx(), { read: true });
    expect(raw[2].text).toMatch(/WHERE a\."companyId" = \$\d+::uuid AND \(a\."status" <> 'NEW'/);
  });

  it('mark read: idempotent insert for the caller, synced to the caller\'s sockets', async () => {
    const { service, prisma, published } = setup();
    await expect(service.markRead(ctx(), ALERT)).resolves.toEqual({ ok: true });
    expect(prisma.alertRead.createMany).toHaveBeenCalledWith({ data: [{ alertId: ALERT, userId: USER }], skipDuplicates: true });
    expect(published).toEqual([{ kind: 'read', userId: USER, event: { ids: [ALERT] } }]);
  });

  it('mark read: an alert outside the caller\'s scope is not found and nothing is written', async () => {
    const { service, prisma, published } = setup({ alert: null });
    await expect(service.markRead(ctx({ dataScope: 'ASSIGNED' }), ALERT)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.alertRead.createMany).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('read all without ids moves the caller\'s watermark (no rows per alert)', async () => {
    const { service, prisma, published } = setup();
    await service.readAll(ctx(), {});
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER }, data: { alertsReadBefore: expect.any(Date) } });
    expect(prisma.alertRead.createMany).not.toHaveBeenCalled();
    expect(published).toEqual([{ kind: 'read', userId: USER, event: { all: true } }]);
  });

  it('read all with ids marks only alerts in scope', async () => {
    const { service, prisma } = setup({ objectsInScope: [OBJ_IN] });
    const other = '66666666-6666-4666-8666-666666666666';
    await expect(service.readAll(ctx({ dataScope: 'ASSIGNED' }), { ids: [ALERT, other] })).resolves.toEqual({ ok: true, count: 1 });
    expect(prisma.alertRead.createMany).toHaveBeenCalledWith({ data: [{ alertId: ALERT, userId: USER }], skipDuplicates: true });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('list: pendingAck=true = NEW and needs acknowledgement', async () => {
    const { service, raw } = setup();
    await service.list(ctx(), { pendingAck: true });
    expect(raw[0].sql).toContain(`a."status" = 'NEW' AND a."ackRequired"`);
  });

  it('acknowledge is refused for alerts stored with ackRequired=false, whatever their type (nothing written)', async () => {
    const { service, prisma, published } = setup({ type: 'POWER_CUT', severity: 'CRITICAL', ackRequired: false });
    await expect(service.ack(ctx(), ALERT)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.alert.update).not.toHaveBeenCalled();
    expect(prisma.alertRead.createMany).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('acknowledge all only touches alerts that need acknowledgement', async () => {
    const { service, prisma } = setup();
    await service.ackAll(ctx(), {});
    const where = (prisma.alert.updateMany.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND).toContainEqual({ ackRequired: true });
  });

  it('acknowledge also marks read for the acknowledging user and tells in-scope sockets', async () => {
    const { service, prisma, published } = setup({ type: 'OVERSPEED', severity: 'WARNING', ackRequired: true });
    const dto = await service.ack(ctx(), ALERT, 'called driver');
    expect(prisma.alertRead.createMany).toHaveBeenCalledWith({ data: [{ alertId: ALERT, userId: USER }], skipDuplicates: true });
    expect(dto.status).toBe('ACKNOWLEDGED');
    expect(published).toEqual([{ kind: 'acked', companyId: COMPANY, items: [{ id: ALERT, objectId: OBJ_IN }], ackByName: 'Admin', ackAt: dto.ackAt }]);
  });
});

describe('LiveGateway alert state fan-out', () => {
  type Fake = { socket: { emit: jest.Mock }; ctx: AuthContext; allowed: Set<string> | null };
  function gateway(clients: Fake[]) {
    const gw = new LiveGateway({} as never, {} as never, {} as never);
    const internals = gw as unknown as { clients: Map<string, Fake>; byCompany: Map<string, Set<Fake>>; onAlertState(m: string): void };
    clients.forEach((c, i) => internals.clients.set(String(i), c));
    internals.byCompany.set(COMPANY, new Set(clients));
    return (m: AlertStateMessage) => internals.onAlertState(JSON.stringify(m));
  }
  const client = (over: Partial<AuthContext>, allowed: Set<string> | null = null): Fake => ({ socket: { emit: jest.fn() }, ctx: ctx(over), allowed });

  it('alerts:read reaches only the reading user\'s sockets', () => {
    const web = client({});
    const phone = client({});
    const other = client({ userId: '77777777-7777-4777-8777-777777777777' });
    gateway([web, phone, other])({ kind: 'read', userId: USER, event: { ids: [ALERT] } });
    expect(web.socket.emit).toHaveBeenCalledWith('alerts:read', { ids: [ALERT] });
    expect(phone.socket.emit).toHaveBeenCalledWith('alerts:read', { ids: [ALERT] });
    expect(other.socket.emit).not.toHaveBeenCalled();
  });

  it('alerts:acked reaches in-scope sockets with alerts:view only', () => {
    const all = client({ userId: 'a' });
    const scoped = client({ userId: 'b', dataScope: 'ASSIGNED' }, new Set([OBJ_OUT]));
    const noView = client({ userId: 'c', permissions: { live_map: ['view'] } });
    const send = gateway([all, scoped, noView]);
    send({ kind: 'acked', companyId: COMPANY, items: [{ id: ALERT, objectId: OBJ_IN }], ackByName: 'Admin', ackAt: '2026-10-20T10:00:00.000Z' });
    expect(all.socket.emit).toHaveBeenCalledWith('alerts:acked', { ids: [ALERT], ackByName: 'Admin', ackAt: '2026-10-20T10:00:00.000Z' });
    expect(scoped.socket.emit).not.toHaveBeenCalled();
    expect(noView.socket.emit).not.toHaveBeenCalled();
    send({ kind: 'acked', companyId: COMPANY, items: null, ackByName: null, ackAt: '2026-10-20T10:00:00.000Z' });
    expect(scoped.socket.emit).toHaveBeenCalledWith('alerts:acked', { ackByName: null, ackAt: '2026-10-20T10:00:00.000Z' });
  });
});
