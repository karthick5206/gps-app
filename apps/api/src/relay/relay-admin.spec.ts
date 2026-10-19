import { BadRequestException } from '@nestjs/common';
import { RelayTarget } from '@prisma/client';
import { AuthContext } from '../access/auth-context';
import { AppEnv } from '../config/env';
import { RelayAdminService } from './relay-admin.service';

const env = { gt06Port: 5023, teltonikaPort: 5027, jt808Port: 6808, ais140Port: 5030, mediaPort: 7612, attachPort: 7613, mediaPublicHost: 'track.example.in', webUrl: 'https://gps.example.in' } as AppEnv;

const target = (over: Partial<RelayTarget>): RelayTarget =>
  ({
    id: 't',
    name: 'T',
    type: 'RAW_TCP',
    enabled: true,
    host: 'vlt.example.gov.in',
    port: 6000,
    passDownstream: false,
    url: null,
    authType: 'NONE',
    authValue: null,
    secret: 'whsec_abcd1234',
    includeAlerts: false,
    scope: 'ALL',
    companyId: null,
    deviceIds: [],
    protocol: null,
    liveOnly: false,
    validOnly: false,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as RelayTarget;

function setup(rows: RelayTarget[] = []) {
  const written: { key: string; value: string }[] = [];
  const published: string[] = [];
  const prisma = {
    relayTarget: {
      count: async () => rows.length,
      findMany: async () => rows,
      create: async ({ data }: { data: Partial<RelayTarget> }) => target({ ...data, id: 'new' }),
    },
    company: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
    device: {
      count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length,
      findMany: async ({ where }: { where: { companyId?: string; id?: { in: string[] } } }) =>
        where.companyId ? [{ uniqueId: '111' }, { uniqueId: '222' }] : (where.id?.in ?? []).map((id) => ({ uniqueId: `u-${id}`, assignments: [{ objectId: `o-${id}` }] })),
    },
  };
  const multi = { set: (key: string, value: string) => (written.push({ key, value }), multi), publish: (ch: string) => (published.push(ch), multi), exec: async () => [] };
  const redis = { client: { multi: () => multi, get: async () => null } };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new RelayAdminService(prisma as never, redis as never, audit as never, env);
  return { service, written, published, audit };
}

const ctx = { userId: 'u1', companyId: 'c0', ip: null } as unknown as AuthContext;

describe('RelayAdminService', () => {
  it('refuses a target that loops back to a VeeTrax device port', async () => {
    const { service } = setup();
    await expect(service.create(ctx, { name: 'Loop', type: 'RAW_TCP', enabled: true, host: 'track.example.in', port: 5023, scope: 'ALL' })).rejects.toThrow(/loop/);
    await expect(service.create(ctx, { name: 'Loop', type: 'RAW_TCP', enabled: true, host: '127.0.0.1', port: 5030, scope: 'ALL' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates HTTP auth and scopes; audits and publishes on create', async () => {
    const { service, written, published, audit } = setup();
    await expect(service.create(ctx, { name: 'P', type: 'HTTP_JSON', enabled: true, url: 'http://localhost:9000/in', authType: 'BASIC', authValue: 'nocolon', scope: 'ALL' })).rejects.toThrow(/user:password/);
    await expect(service.create(ctx, { name: 'P', type: 'HTTP_JSON', enabled: true, url: 'http://localhost:9000/in', scope: 'DEVICES', deviceIds: [] })).rejects.toThrow(/device/);
    await expect(service.create(ctx, { name: 'P', type: 'HTTP_JSON', enabled: true, url: 'http://localhost:9000/in', scope: 'PROTOCOL', protocol: 'nmea' })).rejects.toThrow(/protocol/);
    const dto = await service.create(ctx, { name: 'P', type: 'HTTP_JSON', enabled: true, url: 'http://localhost:9000/in', authType: 'BEARER', authValue: 'tok', scope: 'ALL' });
    expect(dto).toMatchObject({ hasAuth: true, authType: 'BEARER', status: 'IDLE' });
    expect(JSON.stringify(dto)).not.toContain('tok"');
    expect(audit.record).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: 'CREATE', entity: 'RelayTarget' }));
    expect(written[0].key).toBe('vt:relay:rules');
    expect(published).toEqual(['vt:relay:invalidate']);
  });

  it('resolves company / device scopes into unique ids for the gateway', async () => {
    const { service } = setup([
      target({ id: 'a', scope: 'COMPANY', companyId: 'c1' }),
      target({ id: 'b', type: 'HTTP_JSON', host: null, port: null, url: 'https://p.example.com', authType: 'BEARER', authValue: 'x', scope: 'DEVICES', deviceIds: ['d1'] }),
      target({ id: 'c', scope: 'PROTOCOL', protocol: 'ais140' }),
    ]);
    const set = await service.buildRuleSet();
    expect(set.rules.map((r) => [r.id, r.uniqueIds, r.objectIds])).toEqual([
      ['a', ['111', '222'], null],
      ['b', ['u-d1'], ['o-d1']],
      ['c', null, null],
    ]);
    expect(set.rules[1].authorization).toBe('Bearer x');
  });
});
