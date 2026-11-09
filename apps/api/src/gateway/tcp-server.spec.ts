import type Redis from 'ioredis';
import { connect, Socket } from 'node:net';
import { NormalizedPosition } from '@veetracer/shared';
import { decodeFrames, decodeMessage, encodeAlarm, encodeFrame, encodeGps22, encodeHeartbeat, encodeLogin, frameProtocol, Gt06Protocol } from './gt06/codec';
import { Gt06Decoder } from './gt06/decoder';
import { BaseSession, ProtocolDecoder } from './protocol';
import { matchUnreferencedReply, PendingCommand, TcpGatewayServer, UNREFERENCED_REPLY_TIMEOUT_MS } from './tcp-server';
import { encodeAvlPacket, encodeCodec12, encodeImei } from './teltonika/codec';
import { TeltonikaDecoder } from './teltonika/decoder';
import { UnparsedLog } from './unparsed-log';

/** XADD behaviour of the fake: succeed, fail every entry, or wait for `hold` first. */
interface XaddMode {
  fail?: boolean;
  hold?: Promise<void>;
}

/** Minimal Valkey stand-in: records XADD payloads and SET keys. */
function fakeRedis(queued: Record<string, string[]> = {}, mode: XaddMode = {}) {
  const published: NormalizedPosition[] = [];
  const keys = new Map<string, string>();
  const messages: { channel: string; message: string }[] = [];
  const redis = {
    multi() {
      const ops: (() => void)[] = [];
      const m = {
        set: (key: string, value: string) => (ops.push(() => keys.set(key, value)), m),
        publish: (channel: string, message: string) => (ops.push(() => messages.push({ channel, message })), m),
        rpush: () => m,
        expire: () => m,
        exec: async () => {
          ops.forEach((op) => op());
          return [];
        },
      };
      return m;
    },
    lpop: async (key: string) => {
      const items = queued[key] ?? [];
      delete queued[key];
      return items.length ? items : null;
    },
    pipeline() {
      const queued: NormalizedPosition[] = [];
      const p = {
        xadd: (...args: unknown[]) => {
          queued.push(JSON.parse(String(args[args.indexOf('data') + 1])) as NormalizedPosition);
          return p;
        },
        exec: async () => {
          if (mode.hold) await mode.hold;
          if (mode.fail) return queued.map(() => [new Error('OOM command not allowed'), null]);
          published.push(...queued);
          return queued.map(() => [null, '1-0']);
        },
      };
      return p;
    },
    set: async (key: string, value: string) => {
      keys.set(key, value);
      return 'OK';
    },
  };
  return { redis: redis as unknown as Redis, published, keys, messages };
}

async function start(decoder: ProtocolDecoder<BaseSession>, queued: Record<string, string[]> = {}, mode: XaddMode = {}) {
  const fake = fakeRedis(queued, mode);
  const server = new TcpGatewayServer(decoder, { redis: fake.redis, gatewayId: 'gw-test', unparsed: new UnparsedLog({ dir: null }) });
  await server.listen(0);
  return { server, ...fake };
}

function client(port: number): Promise<{ socket: Socket; received: Buffer[] }> {
  return new Promise((resolve) => {
    const received: Buffer[] = [];
    const socket = connect({ host: '127.0.0.1', port }, () => resolve({ socket, received }));
    socket.on('data', (d) => received.push(d));
  });
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const fix = { time: new Date(), gpsInfoLength: 12, satellites: 9, lat: 13.08, lng: 80.27, speedKph: 40, course: 90, positioned: true };
const lbs = { mcc: 404, mnc: 45, lac: 1, cellId: 2 };

describe('TcpGatewayServer', () => {
  it('GT06: fragmented stream with garbage → ACKs, published positions and connection key', async () => {
    const { server, published, keys } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>);
    const { socket, received } = await client(server.port!);
    const stream = Buffer.concat([
      Buffer.from('deadbeef', 'hex'),
      encodeLogin('359647091912738', 1),
      encodeHeartbeat({ ignition: true, charging: false, oilCut: false, voltageLevel: 6, gsmSignal: 4 }, 2),
      encodeGps22({ fix, lbs, acc: true }, 3),
      encodeGps22({ fix: { ...fix, time: new Date(Date.now() + 1000) }, lbs, acc: true }, 4),
    ]);
    for (let i = 0; i < stream.length; i += 5) socket.write(stream.subarray(i, i + 5));
    await until(() => published.length === 2);
    await until(() => decodeFrames(Buffer.concat(received)).frames.length === 2);
    expect(decodeFrames(Buffer.concat(received)).frames.map(frameProtocol)).toEqual([0x01, 0x13]);
    expect(published[0]).toMatchObject({ protocol: 'gt06', uniqueId: '359647091912738', ignition: true, attributes: { batteryLevel: 100 } });
    expect(keys.get('vt:conn:359647091912738')).toBe('gw-test');
    expect(server.stats.dropped).toBeGreaterThan(0);
    socket.destroy();
    await server.close();
  });

  it('Teltonika on its own port: handshake reply, record ACK and positions', async () => {
    const { server, published } = await start(new TeltonikaDecoder());
    const { socket, received } = await client(server.port!);
    socket.write(encodeImei('356307042441013'));
    await until(() => Buffer.concat(received).length >= 1);
    expect(Buffer.concat(received)[0]).toBe(0x01);
    socket.write(encodeAvlPacket([{ timestamp: new Date(), lat: 13, lng: 80, satellites: 7, speedKph: 20, io: { 239: 1, 66: 12500 }, sizes: { 66: 2 } }]));
    await until(() => published.length === 1);
    await until(() => Buffer.concat(received).length >= 5);
    expect(Buffer.concat(received).subarray(1, 5)).toEqual(Buffer.from([0, 0, 0, 1]));
    expect(published[0]).toMatchObject({ protocol: 'teltonika', uniqueId: '356307042441013', ignition: true, attributes: { extVoltage: 12.5 } });
    socket.destroy();
    await server.close();
  });

  it('Teltonika: a client that does not send the IMEI handshake is disconnected', async () => {
    const { server } = await start(new TeltonikaDecoder());
    const { socket } = await client(server.port!);
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    socket.write(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    await closed;
    await server.close();
  });

  it('GT06 command round trip: 0x80 out, 0x15 reply with the same server flag → ACKED', async () => {
    const { server, messages } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>);
    const { socket, received } = await client(server.port!);
    socket.write(encodeLogin('359647091912738', 1));
    await until(() => server.has('359647091912738'));
    expect(server.sendCommand({ commandId: 'cmd-1', uniqueId: '359647091912738', text: 'RELAY,1#' })).toBe(true);
    await until(() => decodeFrames(Buffer.concat(received)).frames.some((f) => frameProtocol(f) === 0x80));
    const out = decodeFrames(Buffer.concat(received)).frames.find((f) => frameProtocol(f) === 0x80)!;
    expect(out.subarray(9, 17).toString('latin1')).toBe('RELAY,1#');
    const serverFlag = out.readUInt32BE(5);
    const text = Buffer.from('Cut off the fuel supply: Success!', 'latin1');
    const content = Buffer.concat([Buffer.from([4 + text.length]), Buffer.alloc(4), text, Buffer.from('0002', 'hex')]);
    content.writeUInt32BE(serverFlag, 1);
    socket.write(encodeFrame(Gt06Protocol.COMMAND_RESPONSE, content, 2));
    await until(() => messages.some((m) => JSON.parse(m.message).status === 'ACKED'));
    const updates = messages.map((m) => JSON.parse(m.message));
    expect(updates.map((u) => u.status)).toEqual(['SENT', 'ACKED']);
    expect(updates[1]).toMatchObject({ commandId: 'cmd-1', response: 'Cut off the fuel supply: Success!' });
    expect(decodeMessage(out).type).toBe('unknown'); // 0x80 is server → device only
    expect(server.sendCommand({ commandId: 'x', uniqueId: 'not-connected', text: 'WHERE#' })).toBe(false);
    socket.destroy();
    await server.close();
  });

  it('delivers commands queued while the device was offline as soon as it logs in', async () => {
    const queued = { 'vt:cmd:queue:359647091912738': [JSON.stringify({ commandId: 'cmd-q', uniqueId: '359647091912738', text: 'WHERE#' })] };
    const { server, messages } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>, queued);
    const { socket, received } = await client(server.port!);
    socket.write(encodeLogin('359647091912738', 1));
    await until(() => decodeFrames(Buffer.concat(received)).frames.some((f) => frameProtocol(f) === 0x80));
    await until(() => messages.length > 0);
    expect(JSON.parse(messages[0].message)).toMatchObject({ commandId: 'cmd-q', status: 'SENT' });
    socket.destroy();
    await server.close();
  });

  it('Q-01: never delivers a queued engine stop on reconnect (flagged or legacy) but still delivers other queued commands', async () => {
    const id = '359647091912738';
    const queued = {
      [`vt:cmd:queue:${id}`]: [
        JSON.stringify({ commandId: 'stop-new', uniqueId: id, text: 'RELAY,1#', critical: true, issuedAt: new Date().toISOString() }),
        JSON.stringify({ commandId: 'stop-legacy', uniqueId: id, text: 'RELAY,1#' }),
        JSON.stringify({ commandId: 'where', uniqueId: id, text: 'WHERE#' }),
      ],
    };
    const { server, messages } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>, queued);
    const { socket, received } = await client(server.port!);
    socket.write(encodeLogin(id, 1));
    await until(() => messages.length >= 3, 10_000); // generous: the full suite runs many socket tests in parallel
    const updates = messages.map((m) => JSON.parse(m.message) as { commandId: string; status: string; error?: string });
    expect(updates.find((u) => u.commandId === 'stop-new')).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/not delivered/) });
    expect(updates.find((u) => u.commandId === 'stop-legacy')).toMatchObject({ status: 'FAILED' });
    expect(updates.find((u) => u.commandId === 'where')).toMatchObject({ status: 'SENT' });
    const sentTexts = decodeFrames(Buffer.concat(received))
      .frames.filter((f) => frameProtocol(f) === 0x80)
      .map((f) => f.subarray(9, f.length - 6).toString('latin1'));
    expect(sentTexts.join('|')).not.toContain('RELAY,1#');
    expect(sentTexts.join('|')).toContain('WHERE#');
    socket.destroy();
    await server.close();
  });

  // ── ACK only after the positions are queued ──

  const status = { ignition: true, charging: false, oilCut: false, voltageLevel: 6, gsmSignal: 4 };
  const protocols = (received: Buffer[]) => decodeFrames(Buffer.concat(received)).frames.map(frameProtocol);

  it('Teltonika: the record ACK waits for the XADD to complete', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { server, published } = await start(new TeltonikaDecoder(), {}, { hold });
    const { socket, received } = await client(server.port!);
    socket.write(encodeImei('356307042441013'));
    await until(() => Buffer.concat(received).length >= 1);
    socket.write(encodeAvlPacket([{ timestamp: new Date(), lat: 13, lng: 80, satellites: 7, speedKph: 20, io: {} }]));
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(received).length).toBe(1); // handshake only, no record ACK yet
    release();
    await until(() => Buffer.concat(received).length >= 5);
    expect(published).toHaveLength(1);
    socket.destroy();
    await server.close();
  });

  it('Teltonika: XADD failure → no record ACK, failure counted, connection closed so the device resends', async () => {
    const { server, published } = await start(new TeltonikaDecoder(), {}, { fail: true });
    const { socket, received } = await client(server.port!);
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    socket.write(encodeImei('356307042441013'));
    await until(() => Buffer.concat(received).length >= 1);
    socket.write(encodeAvlPacket([{ timestamp: new Date(), lat: 13, lng: 80, satellites: 7, speedKph: 20, io: {} }]));
    await closed;
    expect(Buffer.concat(received)).toEqual(Buffer.from([0x01]));
    expect(published).toHaveLength(0);
    expect(server.stats.enqueueFailures).toBe(1);
    await server.close();
  });

  it('GT06: XADD failure → alarm not ACKed, login/heartbeat ACKs still sent in order, connection kept', async () => {
    const { server } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>, {}, { fail: true });
    const { socket, received } = await client(server.port!);
    socket.write(
      Buffer.concat([
        encodeLogin('359647091912738', 1),
        encodeAlarm({ fix, lbs, status, alarm: 0x01 }, 2),
        encodeHeartbeat(status, 3),
      ]),
    );
    await until(() => protocols(received).length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(protocols(received)).toEqual([0x01, 0x13]);
    expect(server.stats.enqueueFailures).toBe(1);
    expect(socket.destroyed).toBe(false);
    socket.write(encodeHeartbeat(status, 4));
    await until(() => protocols(received).length === 3);
    socket.destroy();
    await server.close();
  });

  it('GT06: a slow XADD keeps per-connection ACK order (alarm ACK before the following heartbeat ACK)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { server } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>, {}, { hold });
    const { socket, received } = await client(server.port!);
    socket.write(encodeLogin('359647091912738', 1));
    await until(() => protocols(received).length === 1);
    socket.write(encodeAlarm({ fix, lbs, status, alarm: 0x01 }, 2));
    await new Promise((r) => setTimeout(r, 30));
    socket.write(encodeHeartbeat(status, 3));
    await new Promise((r) => setTimeout(r, 50));
    expect(protocols(received)).toEqual([0x01]); // heartbeat ACK waits behind the alarm ACK
    release();
    await until(() => protocols(received).length === 3);
    expect(protocols(received)).toEqual([0x01, 0x26, 0x13]);
    socket.destroy();
    await server.close();
  });
});

// ── Reply matching without protocol references (Teltonika Codec 12) and never-queued position requests ──

describe('engine-stop reply matching (anti-theft proposal, Option 1)', () => {
  const IMEI = '356307042441013';
  const updatesOf = (messages: { message: string }[]) => messages.map((m) => JSON.parse(m.message) as { commandId: string; status: string; response?: string; error?: string });
  const acked = (messages: { message: string }[]) => updatesOf(messages).filter((u) => u.status === 'ACKED');

  async function teltonika() {
    const ctx = await start(new TeltonikaDecoder());
    const c = await client(ctx.server.port!);
    c.socket.write(encodeImei(IMEI));
    await until(() => ctx.server.has(IMEI));
    return { ...ctx, ...c };
  }
  const stop = (id = 'stop') => ({ commandId: id, uniqueId: IMEI, text: 'setdigout 1', critical: true, issuedAt: new Date().toISOString() });
  const probe = (id = 'probe') => ({ commandId: id, uniqueId: IMEI, text: 'getrecord', noQueue: true });

  it('an unanswered position request is NOT credited with the engine-stop reply', async () => {
    const { server, socket, messages } = await teltonika();
    expect(server.sendCommand(probe())).toBe(true);
    expect(server.sendCommand(stop())).toBe(true);
    socket.write(encodeCodec12('DOUT1:1 Timeout:INFINITY', 0x06));
    await until(() => acked(messages).length === 1);
    expect(acked(messages)).toEqual([expect.objectContaining({ commandId: 'stop', response: 'DOUT1:1 Timeout:INFINITY' })]);
    socket.destroy();
    await server.close();
  });

  it('a position-request reply goes to the request, and the engine-stop reply to the engine stop', async () => {
    const { server, socket, messages } = await teltonika();
    server.sendCommand(probe());
    server.sendCommand(stop());
    socket.write(Buffer.concat([encodeCodec12('Record generated', 0x06), encodeCodec12('DOUT1:1 Timeout:INFINITY', 0x06)]));
    await until(() => acked(messages).length === 2);
    expect(Object.fromEntries(acked(messages).map((u) => [u.commandId, u.response]))).toEqual({ probe: 'Record generated', stop: 'DOUT1:1 Timeout:INFINITY' });
    socket.destroy();
    await server.close();
  });

  it('an unrecognised reply while a position request is outstanding never confirms the engine stop', async () => {
    const { server, socket, messages } = await teltonika();
    server.sendCommand(probe());
    server.sendCommand(stop());
    socket.write(encodeCodec12('Some other text', 0x06));
    socket.write(encodeCodec12('More text', 0x06));
    await until(() => acked(messages).length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(acked(messages).map((u) => u.commandId)).toEqual(['probe']); // the engine stop stays SENT (unconfirmed)
    socket.destroy();
    await server.close();
  });

  it('an engine stop sent alone still takes its reply whatever the text (unchanged behaviour)', async () => {
    const { server, socket, messages } = await teltonika();
    server.sendCommand(stop());
    socket.write(encodeCodec12('Digital Outputs are set to: 1X', 0x06));
    await until(() => acked(messages).length === 1);
    expect(acked(messages)[0]).toMatchObject({ commandId: 'stop' });
    socket.destroy();
    await server.close();
  });

  it('a never-queued position request found in the offline queue is failed, not delivered', async () => {
    const id = '359647091912738';
    const queued = { [`vt:cmd:queue:${id}`]: [JSON.stringify({ commandId: 'probe-q', uniqueId: id, text: 'WHERE#', noQueue: true })] };
    const { server, messages } = await start(new Gt06Decoder() as ProtocolDecoder<BaseSession>, queued);
    const { socket, received } = await client(server.port!);
    socket.write(encodeLogin(id, 1));
    await until(() => messages.length >= 1, 10_000);
    expect(updatesOf(messages)[0]).toMatchObject({ commandId: 'probe-q', status: 'FAILED', error: expect.stringMatching(/never queued/) });
    expect(decodeFrames(Buffer.concat(received)).frames.some((f) => frameProtocol(f) === 0x80)).toBe(false);
    socket.destroy();
    await server.close();
  });
});

describe('matchUnreferencedReply', () => {
  const now = 1_000_000;
  const entry = (commandId: string, ageMs: number, critical = false, clean = false): PendingCommand => ({ commandId, sentAt: now - ageMs, critical, clean });

  it('evicts entries older than the reply timeout instead of crediting them', () => {
    const pending = new Map([[1, entry('old', UNREFERENCED_REPLY_TIMEOUT_MS + 1)]]);
    expect(matchUnreferencedReply(pending, 'anything', now)).toBeNull();
    expect(pending.size).toBe(0);
  });

  it('keeps FIFO order for ordinary commands', () => {
    const pending = new Map([
      [1, entry('a', 2000)],
      [2, entry('b', 1000)],
    ]);
    expect(matchUnreferencedReply(pending, 'x', now)).toBe('a');
    expect(matchUnreferencedReply(pending, 'y', now)).toBe('b');
  });

  it('an engine stop that is not "clean" never takes an unrecognised reply', () => {
    const pending = new Map([[1, entry('stop', 1000, true, false)]]);
    expect(matchUnreferencedReply(pending, 'Record generated', now)).toBeNull();
    expect(pending.size).toBe(1);
    expect(matchUnreferencedReply(pending, 'DOUT1:1 Timeout:INFINITY', now)).toBe('stop');
  });

  it('a position request is never credited with an engine-cut reply while an engine stop is pending', () => {
    const pending = new Map([
      [1, entry('probe', 30_000)],
      [2, entry('stop', 1000, true, false)],
    ]);
    expect(matchUnreferencedReply(pending, 'DOUT1:1 DOUT2:IGNORED', now)).toBe('stop');
    expect([...pending.values()].map((p) => p.commandId)).toEqual(['probe']);
  });

  it('a clean engine stop sent before another command is no longer clean (no false confirmation)', () => {
    // Engine stop first, a locate after it: an unrecognised reply goes to the locate, the next can't confirm the stop.
    const pending = new Map([
      [1, entry('stop', 2000, true, false)],
      [2, entry('locate', 1000)],
    ]);
    expect(matchUnreferencedReply(pending, 'text A', now)).toBe('locate');
    expect(matchUnreferencedReply(pending, 'text B', now)).toBeNull();
  });
});
