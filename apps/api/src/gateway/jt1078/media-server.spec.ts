import { get } from 'node:http';
import { connect } from 'node:net';
import { MediaHub } from './hub';
import { MediaServer } from './media-server';

/** Atomic I-frame packet (SIM 013912345678, channel 1) carrying SPS + PPS + IDR. */
function keyframePacket(seq: number, ts: number): Buffer {
  const body = Buffer.concat([Buffer.from('00000001', 'hex'), Buffer.from('6742c01e95a0280f68', 'hex'), Buffer.from('0000000168ce3c80', 'hex'), Buffer.from('000000016588', 'hex'), Buffer.alloc(20, 0xaa)]);
  const h = Buffer.alloc(30);
  h.writeUInt32BE(0x30316364, 0);
  h[4] = 0x81;
  h[5] = 0x80 | 98;
  h.writeUInt16BE(seq, 6);
  Buffer.from('013912345678', 'hex').copy(h, 8);
  h[14] = 1;
  h[15] = 0x00;
  h.writeBigUInt64BE(BigInt(ts), 16);
  h.writeUInt16BE(body.length, 28);
  return Buffer.concat([h, body]);
}

describe('MediaServer (sockets)', () => {
  it('streams device media to an HTTP-FLV viewer and reports status', async () => {
    const hub = new MediaHub({ maxStreams: 2 });
    const server = new MediaServer(hub);
    await server.listen(0, 0);
    try {
      const { stream } = hub.open({ uniqueId: '13912345678', channel: 1, kind: 'live', streamType: 'sub' });
      const { media, http } = server.ports;

      const flv = new Promise<Buffer>((resolve, reject) => {
        get({ host: '127.0.0.1', port: http!, path: `/live/${stream.id}.flv` }, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toBe('video/x-flv');
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => {
            chunks.push(c);
            const all = Buffer.concat(chunks);
            if (all.length > 13 + 15 + 20) {
              res.destroy();
              resolve(all);
            }
          });
        }).on('error', reject);
      });
      await new Promise((r) => setTimeout(r, 50));
      const device = connect(media!, '127.0.0.1');
      await new Promise((r) => device.once('connect', r));
      device.write(keyframePacket(1, 1000));
      const bytes = await flv;
      expect(bytes.subarray(0, 3).toString()).toBe('FLV');
      expect(bytes[13]).toBe(9); // first tag is video (AVC sequence header)

      const status = await new Promise<string>((resolve) =>
        get({ host: '127.0.0.1', port: http!, path: `/status/${stream.id}` }, (res) => {
          let s = '';
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve(s));
        }),
      );
      expect(JSON.parse(status)).toMatchObject({ state: 'streaming', codec: 'h264', frames: 1 });
      device.destroy();
    } finally {
      await server.close();
    }
  });

  it('answers 404 for unknown streams', async () => {
    const server = new MediaServer(new MediaHub({ maxStreams: 1 }));
    await server.listen(0, 0);
    try {
      const code = await new Promise<number>((resolve) => get({ host: '127.0.0.1', port: server.ports.http!, path: '/live/nope.flv' }, (res) => resolve(res.statusCode!)));
      expect(code).toBe(404);
    } finally {
      await server.close();
    }
  });
});
