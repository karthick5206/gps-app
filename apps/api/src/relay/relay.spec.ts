import { AlertDto, NormalizedPosition, RelayRuleSpec } from '@veetracer/shared';
import { verifySignature } from '../webhooks/signing';
import { checkAddresses, checkHttpTarget, checkTcpHost, RelayPolicy } from './guard';
import { authorizationHeader, HttpForwarder, RelayBatchBody } from './http-forwarder';
import { alertMatches, inScope, passesFilters, RuleIndex } from './rules';
import { isFailing, mergeStats, TargetStats } from './stats';

const rule = (over: Partial<RelayRuleSpec> = {}): RelayRuleSpec => ({
  id: 'r1',
  name: 'Partner',
  type: 'HTTP_JSON',
  host: null,
  port: null,
  passDownstream: false,
  url: 'https://partner.example.com/in',
  authorization: 'Bearer tok',
  secret: 'whsec_test',
  includeAlerts: false,
  scope: 'ALL',
  protocol: null,
  companyId: null,
  uniqueIds: null,
  objectIds: null,
  liveOnly: false,
  validOnly: false,
  ...over,
});

const pos = (over: Partial<NormalizedPosition> = {}): NormalizedPosition => ({
  protocol: 'gt06',
  uniqueId: '111',
  fixTime: '2026-10-20T00:00:00.000Z',
  receivedAt: '2026-10-20T00:00:01.000Z',
  lat: 13,
  lng: 80,
  speedKph: 10,
  course: 0,
  altitude: null,
  satellites: 8,
  valid: true,
  ignition: true,
  attributes: {},
  raw: 'abcd',
  ...over,
});

describe('relay rule matching', () => {
  it('scopes: all / protocol / company & devices (resolved unique ids)', () => {
    expect(inScope(rule(), 'jt808', 'x')).toBe(true);
    expect(inScope(rule({ scope: 'PROTOCOL', protocol: 'ais140' }), 'ais140', 'x')).toBe(true);
    expect(inScope(rule({ scope: 'PROTOCOL', protocol: 'ais140' }), 'gt06', 'x')).toBe(false);
    expect(inScope(rule({ scope: 'COMPANY', uniqueIds: ['111', '222'] }), 'gt06', '222')).toBe(true);
    expect(inScope(rule({ scope: 'DEVICES', uniqueIds: ['111'] }), 'gt06', '333')).toBe(false);
    expect(inScope(rule({ scope: 'COMPANY', uniqueIds: null }), 'gt06', '111')).toBe(false);
    const index = new RuleIndex({ at: '', rules: [rule({ id: 'a' }), rule({ id: 'b', scope: 'DEVICES', uniqueIds: ['9'] }), rule({ id: 'c', type: 'RAW_TCP' })] }, 'HTTP_JSON');
    expect(index.forDevice('gt06', '9').map((r) => r.id)).toEqual(['a', 'b']);
    expect(index.forDevice('gt06', '8').map((r) => r.id)).toEqual(['a']);
  });

  it('filters: live only skips re-uploads, valid only skips invalid fixes', () => {
    expect(passesFilters(rule({ liveOnly: true }), pos({ attributes: { reupload: true } }))).toBe(false);
    expect(passesFilters(rule({ liveOnly: true }), pos())).toBe(true);
    expect(passesFilters(rule({ validOnly: true }), pos({ valid: false }))).toBe(false);
    expect(passesFilters(rule(), pos({ valid: false, attributes: { reupload: true } }))).toBe(true);
  });

  it('alerts: only with includeAlerts; company / device-object scopes', () => {
    const a = { companyId: 'c1', objectId: 'o1' };
    expect(alertMatches(rule(), a)).toBe(false);
    expect(alertMatches(rule({ includeAlerts: true }), a)).toBe(true);
    expect(alertMatches(rule({ includeAlerts: true, scope: 'COMPANY', companyId: 'c2' }), a)).toBe(false);
    expect(alertMatches(rule({ includeAlerts: true, scope: 'DEVICES', objectIds: ['o1'] }), a)).toBe(true);
    expect(alertMatches(rule({ includeAlerts: true, scope: 'PROTOCOL', protocol: 'gt06' }), a)).toBe(false);
  });
});

describe('relay guards', () => {
  const prod: RelayPolicy = { production: true, allowPrivate: false, ownHosts: ['localhost', 'track.example.in'], devicePorts: [5023, 5027, 6808, 5030] };
  const dev: RelayPolicy = { ...prod, production: false, allowPrivate: true };

  it('loop guard: own hosts and loopback on device ports are refused', () => {
    expect(checkTcpHost('track.example.in', 5023, prod)).toMatch(/loop/);
    expect(checkTcpHost('127.0.0.1', 5030, dev)).toMatch(/loop/);
    expect(checkTcpHost('localhost', 6808, dev)).toMatch(/loop/);
    expect(checkTcpHost('127.0.0.1', 9000, dev)).toBeNull();
    expect(checkTcpHost('vlt.state.gov.in', 5030, prod)).toBeNull();
    expect(checkAddresses(['10.1.1.5'], 5023, dev, new Set(['10.1.1.5']))).toMatch(/loop/);
    expect(checkAddresses(['::ffff:127.0.0.1'], 5027, dev, new Set())).toMatch(/loop/);
    expect(checkAddresses(['203.0.114.9'], 5023, prod, new Set(['10.0.0.2']))).toBeNull();
  });

  it('SSRF guard: private targets refused in production, https only for HTTP_JSON', () => {
    expect(checkTcpHost('192.168.1.10', 9000, prod)).toMatch(/public/);
    expect(checkAddresses(['10.0.0.8'], 9000, prod, new Set())).toMatch(/private/);
    expect(checkTcpHost('bad host!', 9000, prod)).toMatch(/valid/);
    expect(checkTcpHost('example.com', 70000, prod)).toMatch(/port/);
    expect(checkHttpTarget('http://partner.example.com/in', prod)).toMatch(/https/);
    expect(checkHttpTarget('https://10.0.0.1/in', prod)).toMatch(/public/);
    expect(checkHttpTarget('https://track.example.in/api/ingest', prod)).toMatch(/loop/);
    expect(checkHttpTarget('https://partner.example.com/in', prod)).toBeNull();
    expect(checkHttpTarget('http://localhost:9999/in', dev)).toBeNull();
  });
});

describe('relay stats', () => {
  it('merges instances; failing only when every instance fails', () => {
    const a = new TargetStats('t', 'T', 'RAW_TCP');
    const b = new TargetStats('t', 'T', 'RAW_TCP');
    a.connected = 2;
    b.connected = 3;
    a.error('down', Date.parse('2026-10-20T00:00:00Z'));
    a.error('down', Date.parse('2026-10-20T00:01:00Z'));
    expect(a.recentErrors).toHaveLength(1);
    b.success();
    const merged = mergeStats([a.snapshot(), b.snapshot()])!;
    expect(merged.connected).toBe(5);
    expect(merged.failingSince).toBeNull();
    expect(isFailing(a.snapshot(), Date.parse('2026-10-20T00:06:00Z'))).toBe(true);
    expect(isFailing(a.snapshot(), Date.parse('2026-10-20T00:04:00Z'))).toBe(false);
  });
});

describe('HTTP_JSON forwarder', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it('batches up to the batch size, signs the body and strips raw', async () => {
    const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
    const f = new HttpForwarder({ post: async (url, body, headers) => (posts.push({ url, body, headers }), { status: 200, body: '' }), batchSize: 3, flushMs: 60_000 });
    f.setRules({ at: '', rules: [rule({ liveOnly: true })] });
    for (let i = 0; i < 4; i++) f.addPosition(pos({ uniqueId: String(i) }));
    f.addPosition(pos({ attributes: { reupload: true } })); // filtered
    await tick();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0].body) as RelayBatchBody;
    expect(body.positions.map((p) => p.uniqueId)).toEqual(['0', '1', '2']);
    expect('raw' in body.positions[0]).toBe(false);
    expect(posts[0].headers.Authorization).toBe('Bearer tok');
    expect(verifySignature('whsec_test', posts[0].headers['X-VeeTrax-Signature'], posts[0].body)).toBe(true);
    expect(f.snapshot()[0]).toMatchObject({ frames: 3, queued: 1 });
    f.flushAll();
    await tick();
    expect(posts).toHaveLength(2);
    f.stop();
  });

  it('sends a partial batch after flushMs', async () => {
    jest.useFakeTimers();
    try {
      const posts: string[] = [];
      const f = new HttpForwarder({ post: async (_u, body) => (posts.push(body), { status: 204, body: '' }), batchSize: 100, flushMs: 5000 });
      f.setRules({ at: '', rules: [rule()] });
      f.addPosition(pos());
      jest.advanceTimersByTime(4999);
      expect(posts).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(posts).toHaveLength(1);
      f.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a failed batch with backoff, keeps order and drops the oldest when full', async () => {
    const statuses = [500, 0, 200];
    const bodies: RelayBatchBody[] = [];
    const f = new HttpForwarder({
      post: async (_u, body) => {
        const status = statuses.shift() ?? 200;
        if (status === 0) throw new Error('ECONNREFUSED');
        bodies.push(JSON.parse(body) as RelayBatchBody);
        return { status, body: 'oops' };
      },
      batchSize: 2,
      flushMs: 60_000,
      maxQueue: 3,
      retryDelaysMs: [5, 5],
    });
    f.setRules({ at: '', rules: [rule()] });
    f.addPosition(pos({ uniqueId: 'a' }));
    f.addPosition(pos({ uniqueId: 'b' }));
    await tick();
    expect(f.snapshot()[0].lastError?.message).toMatch(/HTTP 500/);
    f.addPosition(pos({ uniqueId: 'c' }));
    f.addPosition(pos({ uniqueId: 'd' })); // queue a b c d > 3 → a dropped
    expect(f.snapshot()[0]).toMatchObject({ queued: 3, dropped: 1 });
    await new Promise((r) => setTimeout(r, 60));
    const sent = bodies.filter((_b, i) => i > 0).flatMap((b) => b.positions.map((p) => p.uniqueId));
    expect(sent).toEqual(['b', 'c', 'd']);
    expect(f.snapshot()[0]).toMatchObject({ queued: 0, failingSince: null, frames: 3 });
    expect(f.snapshot()[0].recentErrors.map((e) => e.message)).toEqual(['ECONNREFUSED', expect.stringMatching(/HTTP 500/)]);
    f.stop();
  });

  it('forwards matching alerts with positions when enabled', async () => {
    const bodies: RelayBatchBody[] = [];
    const f = new HttpForwarder({ post: async (_u, body) => (bodies.push(JSON.parse(body) as RelayBatchBody), { status: 200, body: '' }), batchSize: 2, flushMs: 60_000 });
    f.setRules({ at: '', rules: [rule({ includeAlerts: true, scope: 'COMPANY', companyId: 'c1', uniqueIds: ['111'] })] });
    f.addAlert('c2', { id: 'x', objectId: 'o' } as AlertDto);
    f.addAlert('c1', { id: 'al1', objectId: 'o' } as AlertDto);
    f.addPosition(pos());
    await tick();
    expect(bodies[0].alerts.map((a) => a.id)).toEqual(['al1']);
    expect(bodies[0].alerts[0].companyId).toBe('c1');
    expect(bodies[0].positions).toHaveLength(1);
    f.stop();
  });

  it('builds Bearer / Basic authorization values', () => {
    expect(authorizationHeader('BEARER', 'abc')).toBe('Bearer abc');
    expect(authorizationHeader('BASIC', 'u:p')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(authorizationHeader('NONE', 'abc')).toBeNull();
  });
});
