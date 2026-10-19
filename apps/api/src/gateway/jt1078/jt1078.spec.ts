import { avcDecoderConfig, flvHeader, flvTag, splitAnnexB } from './flv';
import { MediaHub, StreamLimitError } from './hub';
import { Jt1078Reassembler, Jt1078Splitter, parsePacketAt } from './packet';
import { FlvSink, MediaStream } from './stream';

interface PacketOpts {
  pt?: number;
  seq?: number;
  sim?: string;
  channel?: number;
  dataType?: number;
  sub?: number;
  ts?: number;
  body: Buffer;
  simBytes?: 6 | 10;
}

/** Builds a JT/T 1078 media packet (table 19). */
function packet(o: PacketOpts): Buffer {
  const simBytes = o.simBytes ?? 6;
  const dataType = o.dataType ?? 0;
  const parts: Buffer[] = [Buffer.from('30316364', 'hex'), Buffer.from([0x81, 0x80 | (o.pt ?? 98)])];
  const seq = Buffer.alloc(2);
  seq.writeUInt16BE(o.seq ?? 1);
  parts.push(seq, Buffer.from((o.sim ?? '13912345678').padStart(simBytes * 2, '0'), 'hex'), Buffer.from([o.channel ?? 1, (dataType << 4) | (o.sub ?? 0)]));
  if (dataType !== 4) {
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(o.ts ?? 1000));
    parts.push(ts);
  }
  if (dataType <= 2) parts.push(Buffer.from([0, 40, 0, 40]));
  const len = Buffer.alloc(2);
  len.writeUInt16BE(o.body.length);
  parts.push(len, o.body);
  return Buffer.concat(parts);
}

const SC = Buffer.from([0, 0, 0, 1]);
const SPS = Buffer.from('6742c01e95a0280f68', 'hex');
const PPS = Buffer.from('68ce3c80', 'hex');
const IDR = Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(30, 0xaa)]);
const NONIDR = Buffer.concat([Buffer.from([0x41, 0x9a]), Buffer.alloc(10, 0xbb)]);
const keyframe = Buffer.concat([SC, SPS, SC, PPS, SC, IDR]);
const pframe = Buffer.concat([SC, NONIDR]);

class FakeSink implements FlvSink {
  chunks: Buffer[] = [];
  ended = false;
  destroyed = false;
  writableLength = 0;
  write(chunk: Buffer): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  get bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Parses an FLV byte stream into tags (after the 13-byte header). */
function tags(flv: Buffer): { type: number; ts: number; data: Buffer }[] {
  const out: { type: number; ts: number; data: Buffer }[] = [];
  let o = 13;
  while (o + 11 <= flv.length) {
    const size = flv.readUIntBE(o + 1, 3);
    const ts = flv.readUIntBE(o + 4, 3) | (flv[o + 7] << 24);
    out.push({ type: flv[o], ts, data: flv.subarray(o + 11, o + 11 + size) });
    expect(flv.readUInt32BE(o + 11 + size)).toBe(11 + size);
    o += 11 + size + 4;
  }
  return out;
}

const frame = (data: Buffer, ts: number, pt = 98) => ({ sim: '13912345678', channel: 1, payloadType: pt, kind: 'video' as const, dataType: 0, timestamp: ts, data });

describe('JT/T 1078 packets', () => {
  it('parses the header of a video packet', () => {
    const r = parsePacketAt(packet({ seq: 7, channel: 2, dataType: 0, ts: 123456, body: Buffer.from('abcd', 'hex') }), 0);
    if (!r || r === 'bad') throw new Error('not parsed');
    const p = r.packet;
    expect(p).toMatchObject({ marker: true, payloadType: 98, sequence: 7, sim: '13912345678', channel: 2, dataType: 0, subpackage: 0, timestamp: 123456, lastIFrameInterval: 40, lastFrameInterval: 40 });
    expect(p.body.toString('hex')).toBe('abcd');
  });

  it('audio has no frame intervals and transparent data has no timestamp', () => {
    const s = new Jt1078Splitter();
    const out = s.push(Buffer.concat([packet({ pt: 6, dataType: 3, ts: 500, body: Buffer.from('0102', 'hex') }), packet({ dataType: 4, body: Buffer.from('ff', 'hex') })]));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ dataType: 3, payloadType: 6, timestamp: 500, lastIFrameInterval: null });
    expect(out[0].body.toString('hex')).toBe('0102');
    expect(out[1]).toMatchObject({ dataType: 4, timestamp: 0 });
    expect(out[1].body.toString('hex')).toBe('ff');
  });

  it('splits across chunks, skips garbage and rejects malformed packets', () => {
    const s = new Jt1078Splitter();
    const a = packet({ seq: 1, body: Buffer.alloc(100, 1) });
    const b = packet({ seq: 2, body: Buffer.alloc(50, 2) });
    const stream = Buffer.concat([Buffer.from('deadbeef', 'hex'), a, b]);
    const got = [...s.push(stream.subarray(0, 60)), ...s.push(stream.subarray(60, 130)), ...s.push(stream.subarray(130))];
    expect(got.map((p) => p.sequence)).toEqual([1, 2]);
    expect(s.dropped).toBe(4);
    // Bad data type nibble (5) → resync to the next magic.
    const bad = Buffer.from(a);
    bad[15] = 0x50;
    expect(parsePacketAt(bad, 0)).toBe('bad');
    expect(new Jt1078Splitter().push(Buffer.concat([a, bad, b])).map((p) => p.sequence)).toEqual([1, 2]);
    expect(parsePacketAt(Buffer.from('3031', 'hex'), 0)).toBeNull();
  });

  it('detects 10-byte SIM fields (2019 firmware)', () => {
    const s = new Jt1078Splitter();
    const out = s.push(Buffer.concat([packet({ simBytes: 10, body: Buffer.alloc(8) }), packet({ simBytes: 10, seq: 2, body: Buffer.alloc(8) })]));
    expect(s.simLength).toBe(10);
    expect(out.map((p) => [p.sim, p.sequence])).toEqual([
      ['13912345678', 1],
      ['13912345678', 2],
    ]);
  });

  it('reassembles first / middle / last subpackages and drops orphans', () => {
    const r = new Jt1078Reassembler();
    const s = new Jt1078Splitter();
    const parts = s.push(
      Buffer.concat([
        packet({ sub: 3, body: Buffer.from('ee', 'hex') }), // orphan middle
        packet({ sub: 1, ts: 10, body: Buffer.from('0102', 'hex') }),
        packet({ pt: 6, dataType: 3, body: Buffer.from('aa', 'hex') }), // audio interleaved
        packet({ sub: 3, body: Buffer.from('0304', 'hex') }),
        packet({ sub: 2, body: Buffer.from('05', 'hex') }),
      ]),
    );
    const frames = parts.map((p) => r.push(p)).filter((f) => f !== null);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: 'audio' });
    expect(frames[1]).toMatchObject({ kind: 'video', timestamp: 10, channel: 1 });
    expect(frames[1].data.toString('hex')).toBe('0102030405');
    expect(r.discarded).toBe(1);
  });
});

describe('FLV muxer', () => {
  it('writes the FLV header and tags with sizes and extended timestamps', () => {
    expect(flvHeader(true, false).toString('hex')).toBe('464c5601010000000900000000');
    expect(flvHeader(true, true)[4]).toBe(0x05);
    const t = flvTag(9, 0x01020304, Buffer.from('abc'));
    expect(t.toString('hex')).toBe('09000003' + '020304' + '01' + '000000' + '616263' + '0000000e');
  });

  it('splits Annex-B and builds the AVC decoder configuration from SPS / PPS', () => {
    expect(splitAnnexB(keyframe).map((n) => n[0] & 0x1f)).toEqual([7, 8, 5]);
    expect(splitAnnexB(Buffer.concat([Buffer.from([0, 0, 1]), NONIDR])).map((n) => n.length)).toEqual([NONIDR.length]);
    const c = avcDecoderConfig(SPS, PPS);
    expect(c.subarray(0, 6).toString('hex')).toBe('0142c01effe1');
    expect(c.readUInt16BE(6)).toBe(SPS.length);
    expect(c.subarray(8, 8 + SPS.length).equals(SPS)).toBe(true);
    expect(c[8 + SPS.length]).toBe(1);
    expect(c.readUInt16BE(9 + SPS.length)).toBe(PPS.length);
  });

  it('muxes H.264 frames: sequence header, keyframe then inter frames with rebased timestamps', () => {
    const s = new MediaStream('l1', '13912345678', 1, 'live', 'sub');
    const v = new FakeSink();
    s.addViewer(v);
    s.push(frame(pframe, 900)); // before any keyframe: not sent
    s.push(frame(keyframe, 1000));
    s.push(frame(pframe, 1040));
    s.push(frame(pframe, 1080));
    expect(s.codec).toBe('h264');
    const flv = v.bytes;
    expect(flv.subarray(0, 3).toString()).toBe('FLV');
    const t = tags(flv);
    expect(t.map((x) => [x.type, x.ts, x.data[0], x.data[1]])).toEqual([
      [9, 0, 0x17, 0],
      [9, 0, 0x17, 1],
      [9, 40, 0x27, 1],
      [9, 80, 0x27, 1],
    ]);
    // NALU tag: 5-byte video header, then 4-byte length + IDR (SPS/PPS stripped).
    expect(t[1].data.readUInt32BE(5)).toBe(IDR.length);
    expect(t[1].data.length).toBe(5 + 4 + IDR.length);
    expect(t[1].data.readUIntBE(2, 3)).toBe(0); // composition time
  });

  it('late joiners start at the cached keyframe', () => {
    const s = new MediaStream('l1', '13912345678', 1, 'live', 'sub');
    s.push(frame(keyframe, 1000));
    s.push(frame(pframe, 1040));
    s.push(frame(keyframe, 2000));
    s.push(frame(pframe, 2040));
    s.push(frame(pframe, 2080));
    expect(s.cachedFrames).toBe(3);
    const late = new FakeSink();
    s.addViewer(late);
    s.push(frame(pframe, 2120));
    const t = tags(late.bytes);
    expect(t.map((x) => [x.ts, x.data[0], x.data[1]])).toEqual([
      [0, 0x17, 0],
      [0, 0x17, 1],
      [40, 0x27, 1],
      [80, 0x27, 1],
      [120, 0x27, 1],
    ]);
  });

  it('marks H.265 unsupported and ends viewers; drops slow viewers', () => {
    const s = new MediaStream('l1', '1', 1, 'live', 'sub');
    const v = new FakeSink();
    let unsupported = 0;
    s.onUnsupported = () => {
      unsupported++;
      s.endViewers();
    };
    s.addViewer(v);
    s.push(frame(Buffer.from([0, 0, 0, 1, 0x40, 0x01]), 0, 99));
    expect(s.codec).toBe('h265');
    expect(unsupported).toBe(1);
    expect(v.ended).toBe(true);

    const s2 = new MediaStream('l2', '1', 1, 'live', 'sub');
    const slow = new FakeSink();
    slow.writableLength = 10 * 1024 * 1024;
    s2.addViewer(slow);
    s2.push(frame(keyframe, 0));
    expect(slow.destroyed).toBe(true);
    expect(s2.viewerCount).toBe(0);
  });
});

describe('MediaHub', () => {
  it('shares live streams, limits concurrency and closes idle / silent streams', () => {
    const stopped: string[] = [];
    const hub = new MediaHub({ maxStreams: 2, idleMs: 30_000, noDataMs: 30_000, onStop: (s, reason) => stopped.push(`${s.id}:${reason}`) });
    const a = hub.open({ uniqueId: '13912345678', channel: 1, kind: 'live', streamType: 'sub' }, 0);
    const again = hub.open({ uniqueId: '13912345678', channel: 1, kind: 'live', streamType: 'sub' }, 0);
    expect(again.joined).toBe(true);
    expect(again.stream.id).toBe(a.stream.id);
    hub.open({ uniqueId: '13912345678', channel: 2, kind: 'live', streamType: 'sub' }, 0);
    expect(() => hub.open({ uniqueId: '13912345678', channel: 3, kind: 'live', streamType: 'sub' })).toThrow(StreamLimitError);

    // A viewer keeps stream A open; once it leaves, the idle timer runs from that moment.
    const v = new FakeSink();
    hub.attachViewer(a.stream.id, v);
    a.stream.push(frame(keyframe, 0));
    expect(hub.sweep(Date.now() + 1000)).toEqual(expect.not.arrayContaining([a.stream.id]));
    const left = Date.now();
    hub.detachViewer(a.stream.id, v, left);
    expect(hub.sweep(left + 10_000)).not.toContain(a.stream.id);
    expect(hub.sweep(left + 31_000)).toContain(a.stream.id);
    expect(stopped).toContain(`${a.stream.id}:no viewers`);
  });

  it('binds media connections by SIM (ignoring leading zeros) and channel', () => {
    const hub = new MediaHub({ maxStreams: 4 });
    const live = hub.open({ uniqueId: '13912345678', channel: 1, kind: 'live', streamType: 'sub' });
    expect(hub.bind('013912345678', 1, new Set())?.id).toBe(live.stream.id);
    expect(hub.bind('13912345678', 2, new Set())).toBeNull();
    expect(hub.leave(live.stream.id)).toBe(true);
    expect(hub.size).toBe(0);
  });
});
