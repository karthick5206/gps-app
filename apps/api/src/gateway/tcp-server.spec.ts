import type Redis from 'ioredis';
import { connect, Socket } from 'node:net';
import { NormalizedPosition } from '@veetracer/shared';
import { decodeFrames, encodeGps22, encodeHeartbeat, encodeLogin, frameProtocol } from './gt06/codec';
import { Gt06Decoder } from './gt06/decoder';
import { BaseSession, ProtocolDecoder } from './protocol';
import { TcpGatewayServer } from './tcp-server';
import { encodeAvlPacket, encodeImei } from './teltonika/codec';
import { TeltonikaDecoder } from './teltonika/decoder';
import { UnparsedLog } from './unparsed-log';

/** Minimal Valkey stand-in: records XADD payloads and SET keys. */
function fakeRedis() {
  const published: NormalizedPosition[] = [];
  const keys = new Map<string, string>();
  const redis = {
    pipeline() {
      const queued: NormalizedPosition[] = [];
      const p = {
        xadd: (...args: unknown[]) => {
          queued.push(JSON.parse(String(args[args.indexOf('data') + 1])) as NormalizedPosition);
          return p;
        },
        exec: async () => {
          published.push(...queued);
          return [];
        },
      };
      return p;
    },
    set: async (key: string, value: string) => {
      keys.set(key, value);
      return 'OK';
    },
  };
  return { redis: redis as unknown as Redis, published, keys };
}

async function start(decoder: ProtocolDecoder<BaseSession>) {
  const fake = fakeRedis();
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
});
