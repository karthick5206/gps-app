import type Redis from 'ioredis';
import { AddressInfo, connect, createServer, Server, Socket } from 'node:net';
import { RelayRuleSet, RelayRuleSpec } from '@veetracer/shared';
import { RelayPolicy } from '../../relay/guard';
import { decodeFrames, encodeHeartbeat, encodeLogin, frameProtocol } from '../gt06/codec';
import { Gt06Decoder } from '../gt06/decoder';
import { BaseSession, ProtocolDecoder } from '../protocol';
import { TcpGatewayServer } from '../tcp-server';
import { UnparsedLog } from '../unparsed-log';
import { RelayManager } from './relay-manager';

const policy: RelayPolicy = { production: false, allowPrivate: true, ownHosts: ['localhost'], devicePorts: [5023] };

function fakeRedis(): Redis {
  const m = { set: () => m, publish: () => m, exec: async () => [] };
  return {
    multi: () => m,
    lpop: async () => null,
    pipeline() {
      let n = 0;
      const p = { xadd: () => (n++, p), exec: async () => Array.from({ length: n }, () => [null, '1-0']) };
      return p;
    },
    set: async () => 'OK',
  } as unknown as Redis;
}

/** Test upstream: collects everything received per connection and answers with junk. */
async function upstream(port = 0): Promise<{ server: Server; port: number; conns: Buffer[][]; sockets: Socket[] }> {
  const conns: Buffer[][] = [];
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    const got: Buffer[] = [];
    conns.push(got);
    sockets.push(s);
    s.on('data', (d) => {
      got.push(d);
      s.write(Buffer.from('UPSTREAM-REPLY'));
    });
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port, conns, sockets };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const rule = (over: Partial<RelayRuleSpec> = {}): RelayRuleSpec => ({
  id: 't1',
  name: 'State backend',
  type: 'RAW_TCP',
  host: '127.0.0.1',
  port: 1,
  passDownstream: false,
  url: null,
  authorization: null,
  secret: 'whsec_x',
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
const set = (...rules: RelayRuleSpec[]): RelayRuleSet => ({ at: new Date().toISOString(), rules });

function manager(limits: Partial<{ maxSocketsPerTarget: number; bufferBytes: number; bufferFrames: number }> = {}) {
  return new RelayManager({
    policy,
    limits: { maxSocketsPerTarget: 100, bufferBytes: 64 * 1024, bufferFrames: 500, ...limits },
    upstream: { minBackoffMs: 20, maxBackoffMs: 50, connectTimeoutMs: 1000 },
    localAddresses: new Set(['127.0.0.1']),
  });
}

describe('RAW_TCP relay', () => {
  it('mirrors the exact device bytes through the gateway; upstream replies are discarded', async () => {
    const up = await upstream();
    const relay = manager();
    relay.setRules(set(rule({ port: up.port })));
    const server = new TcpGatewayServer(new Gt06Decoder() as ProtocolDecoder<BaseSession>, { redis: fakeRedis(), gatewayId: 'gw', unparsed: new UnparsedLog({ dir: null }), relay });
    await server.listen(0);
    const received: Buffer[] = [];
    const device = await new Promise<Socket>((r) => {
      const s = connect({ host: '127.0.0.1', port: server.port! }, () => r(s));
      s.on('data', (d) => received.push(d));
    });
    const login = encodeLogin('359647091912738', 1);
    const hb = encodeHeartbeat({ ignition: true, charging: false, oilCut: false, voltageLevel: 6, gsmSignal: 4 }, 2);
    device.write(login);
    await until(() => received.length > 0);
    device.write(hb);
    await until(() => Buffer.concat(up.conns[0] ?? []).length === login.length + hb.length);
    expect(Buffer.concat(up.conns[0])).toEqual(Buffer.concat([login, hb]));
    await until(() => decodeFrames(Buffer.concat(received)).frames.length === 2);
    // Only VeeTrax's own ACKs reached the device.
    expect(decodeFrames(Buffer.concat(received)).frames.map(frameProtocol)).toEqual([0x01, 0x13]);
    expect(Buffer.concat(received).includes('UPSTREAM-REPLY')).toBe(false);
    const stats = relay.snapshot()[0];
    expect(stats).toMatchObject({ id: 't1', connected: 1, sessions: 1, frames: 2, bytes: login.length + hb.length });
    device.destroy();
    await until(() => relay.snapshot()[0].sessions === 0);
    await server.close();
    up.server.close();
  });

  it('replays pre-identification chunks first, then forwards later ones', async () => {
    const up = await upstream();
    const relay = manager();
    relay.setRules(set(rule({ port: up.port, scope: 'PROTOCOL', protocol: 'jt808' })));
    const s = relay.open('jt808', () => undefined);
    s.data(Buffer.from('REGISTER;'), null);
    s.data(Buffer.from('AUTH;'), '013800000001');
    s.data(Buffer.from('LOC1;'), '013800000001');
    await until(() => Buffer.concat(up.conns[0] ?? []).toString() === 'REGISTER;AUTH;LOC1;');
    // Another protocol is out of scope: no upstream.
    const other = relay.open('gt06', () => undefined);
    other.data(Buffer.from('X'), '1');
    expect(relay.snapshot()[0].sessions).toBe(1);
    s.close();
    other.close();
    up.server.close();
  });

  it('buffers while the upstream is down, drops the oldest, reconnects and replays the login', async () => {
    const port = await freePort();
    const relay = manager({ bufferFrames: 3 });
    relay.setRules(set(rule({ port })));
    const s = relay.open('gt06', () => undefined);
    s.data(Buffer.from('LOGIN;'), 'dev1');
    for (let i = 1; i <= 5; i++) s.data(Buffer.from(`P${i};`), 'dev1');
    await until(() => relay.snapshot()[0].lastError !== null);
    expect(relay.snapshot()[0]).toMatchObject({ connected: 0, dropped: 2, queued: 9 });
    expect(relay.snapshot()[0].failingSince).not.toBeNull();
    const up = await upstream(port);
    await until(() => Buffer.concat(up.conns[0] ?? []).toString() === 'LOGIN;P3;P4;P5;');
    await until(() => relay.snapshot()[0].connected === 1);
    expect(relay.snapshot()[0]).toMatchObject({ queued: 0, failingSince: null });
    // Upstream drops the connection: the next connection gets the login again.
    up.sockets[0].destroy();
    await until(() => up.conns.length === 2 && Buffer.concat(up.conns[1]).toString() === 'LOGIN;');
    s.data(Buffer.from('P6;'), 'dev1');
    await until(() => Buffer.concat(up.conns[1]).toString() === 'LOGIN;P6;');
    s.close();
    up.server.close();
  });

  it('passes upstream replies downstream only when enabled and allowed for the protocol', async () => {
    const up = await upstream();
    const relay = manager();
    relay.setRules(set(rule({ port: up.port, passDownstream: true })));
    const toAis: Buffer[] = [];
    const toGt06: Buffer[] = [];
    const a = relay.open('ais140', (d) => toAis.push(d));
    const g = relay.open('gt06', (d) => toGt06.push(d));
    a.data(Buffer.from('$LGN,1*'), '861'); // identified on the first chunk
    g.data(Buffer.from('7878'), '359');
    await until(() => toAis.length > 0 && up.conns.length === 2 && up.conns.every((c) => c.length > 0));
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(toAis).toString()).toContain('UPSTREAM-REPLY');
    expect(toGt06).toHaveLength(0);
    a.close();
    g.close();
    up.server.close();
  });

  it('applies rule changes to open connections and enforces the socket limit', async () => {
    const up = await upstream();
    const relay = manager({ maxSocketsPerTarget: 1 });
    const s1 = relay.open('gt06', () => undefined);
    s1.data(Buffer.from('L1;'), 'a');
    expect(relay.snapshot()).toHaveLength(0);
    relay.setRules(set(rule({ port: up.port, scope: 'DEVICES', uniqueIds: ['a', 'b'] })));
    await until(() => Buffer.concat(up.conns[0] ?? []).toString() === 'L1;');
    const s2 = relay.open('gt06', () => undefined);
    s2.data(Buffer.from('L2;'), 'b');
    expect(relay.snapshot()[0]).toMatchObject({ sessions: 1, dropped: 1 });
    expect(relay.snapshot()[0].lastError?.message).toMatch(/limit/);
    relay.setRules(set());
    expect(relay.snapshot()).toHaveLength(0);
    s1.close();
    s2.close();
    up.server.close();
  });

  it('loop guard: never connects back to a VeeTrax device port', async () => {
    const relay = manager();
    relay.setRules(set(rule({ port: 5023 })));
    const s = relay.open('gt06', () => undefined);
    s.data(Buffer.from('L;'), 'x');
    await until(() => relay.snapshot()[0].lastError !== null);
    expect(relay.snapshot()[0].lastError?.message).toMatch(/loop/);
    expect(relay.snapshot()[0].connected).toBe(0);
    s.close();
  });
});
