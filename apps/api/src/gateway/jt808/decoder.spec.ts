import { DecodeContext } from '../protocol';
import { decodeMessage, encodeMessage, escape808, Jt808Msg, split808, unescape808 } from './codec';
import { Jt808Decoder, Jt808Session } from './decoder';

const BCD6 = Buffer.from('013912345678', 'hex');
const T2013 = { terminalBcd: BCD6, version2019: false, protocolVersion: null };
const T2019 = { terminalBcd: Buffer.from('00000000013912345678', 'hex'), version2019: true, protocolVersion: 1 };

const bcdTime = (d: Date) => Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14), 'hex');

interface LocOpts {
  alarm?: number;
  status?: number;
  lat?: number;
  lng?: number;
  speedKph?: number;
  /** Device clock time as written (zone already applied). */
  clock: Date;
  extras?: [number, Buffer][];
}
function locationBody(o: LocOpts): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt32BE(o.alarm ?? 0, 0);
  b.writeUInt32BE(o.status ?? 0b11, 4); // ACC on, positioned
  b.writeUInt32BE(Math.round((o.lat ?? 13.0827) * 1e6), 8);
  b.writeUInt32BE(Math.round((o.lng ?? 80.2707) * 1e6), 12);
  b.writeInt16BE(12, 16);
  b.writeUInt16BE(Math.round((o.speedKph ?? 42.5) * 10), 18);
  b.writeUInt16BE(90, 20);
  bcdTime(o.clock).copy(b, 22);
  const extras = (o.extras ?? []).map(([id, v]) => Buffer.concat([Buffer.from([id, v.length]), v]));
  return Buffer.concat([b, ...extras]);
}

const NOW = new Date('2026-10-19T06:30:00Z');
const plus = (min: number) => new Date(NOW.getTime() + min * 60_000);

function harness() {
  const decoder = new Jt808Decoder();
  const session: Jt808Session = decoder.createSession();
  const unparsed = jest.fn();
  const warn = jest.fn();
  const ctx: DecodeContext = { receivedAt: NOW, remote: 'test', unparsed, warn };
  const feed = (wire: Buffer) => {
    const { frames } = decoder.split(wire);
    return frames.map((f) => decoder.decode(f, session, ctx));
  };
  return { decoder, session, feed, unparsed, warn };
}

describe('JT/T 808 codec', () => {
  it('escapes and unescapes 0x7E / 0x7D', () => {
    const raw = Buffer.from([0x30, 0x7e, 0x08, 0x7d, 0x55]);
    expect(escape808(raw)).toEqual(Buffer.from([0x30, 0x7d, 0x02, 0x08, 0x7d, 0x01, 0x55]));
    expect(unescape808(escape808(raw))).toEqual(raw);
  });

  it('decodes a hand-checked 2013 heartbeat frame', () => {
    // 0x0002, empty body, terminal 013912345678, serial 1; checksum = XOR of the header bytes.
    const head = Buffer.from('000200000139123456780001', 'hex');
    let c = 0;
    for (const b of head) c ^= b;
    const frame = Buffer.concat([Buffer.from([0x7e]), head, Buffer.from([c]), Buffer.from([0x7e])]);
    const { frames } = split808(frame);
    const m = decodeMessage(frames[0]);
    expect(m.header).toMatchObject({ msgId: 2, terminalId: '13912345678', serial: 1, version2019: false });
    expect(m.body.length).toBe(0);
  });

  it('splits back-to-back and partial frames', () => {
    const a = encodeMessage(Jt808Msg.HEARTBEAT, T2013, 1, Buffer.alloc(0));
    const b = encodeMessage(Jt808Msg.HEARTBEAT, T2013, 2, Buffer.alloc(0));
    const wire = Buffer.concat([Buffer.from('zz'), a, b.subarray(0, 5)]);
    const r = split808(wire);
    expect(r.frames).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(r.rest).toEqual(b.subarray(0, 5));
    expect(split808(Buffer.concat([r.rest, b.subarray(5)])).frames).toHaveLength(1);
  });

  it('rejects a bad checksum', () => {
    const f = encodeMessage(Jt808Msg.HEARTBEAT, T2013, 1, Buffer.alloc(0));
    f[f.length - 2] ^= 0xff;
    expect(() => decodeMessage(split808(f).frames[0])).toThrow('bad checksum');
  });
});

describe('Jt808Decoder', () => {
  it('answers registration with an auth code and auth / heartbeat with a general response', () => {
    const { feed } = harness();
    const [reg] = feed(encodeMessage(Jt808Msg.REGISTER, T2013, 7, Buffer.alloc(37)));
    const regReply = decodeMessage(split808(reg.replies[0]).frames[0]);
    expect(regReply.header.msgId).toBe(Jt808Msg.REGISTER_RESPONSE);
    expect(regReply.body.readUInt16BE(0)).toBe(7);
    expect(regReply.body[2]).toBe(0);
    expect(regReply.body.subarray(3).toString('ascii')).toBe('13912345678');

    const [hb] = feed(encodeMessage(Jt808Msg.HEARTBEAT, T2013, 8, Buffer.alloc(0)));
    const ack = decodeMessage(split808(hb.replies[0]).frames[0]);
    expect(ack.header.msgId).toBe(Jt808Msg.PLATFORM_RESPONSE);
    expect([ack.body.readUInt16BE(0), ack.body.readUInt16BE(2), ack.body[4]]).toEqual([8, Jt808Msg.HEARTBEAT, 0]);
  });

  it('decodes a location report and detects an IST device clock', () => {
    const { feed, session } = harness();
    const body = locationBody({
      clock: new Date(NOW.getTime() + 330 * 60_000),
      extras: [
        [0x01, Buffer.from([0, 0, 0x30, 0x39])], // 1234.5 km
        [0x30, Buffer.from([20])],
        [0x31, Buffer.from([11])],
      ],
    });
    const [r] = feed(encodeMessage(Jt808Msg.LOCATION, T2013, 9, body));
    expect(r.replies).toHaveLength(1);
    const p = r.positions[0];
    expect(p).toMatchObject({ protocol: 'jt808', uniqueId: '13912345678', fixTime: NOW.toISOString(), speedKph: 42.5, course: 90, altitude: 12, satellites: 11, valid: true, ignition: true });
    expect(p.lat).toBeCloseTo(13.0827, 5);
    expect(p.lng).toBeCloseTo(80.2707, 5);
    expect(p.attributes).toMatchObject({ odometerM: 1_234_500, gsmSignal: 3 });
    expect(session.clockZone).toBe(330);
  });

  it('defaults to GMT+8 (the spec) and handles the 2019 header', () => {
    const { feed } = harness();
    const [r] = feed(encodeMessage(Jt808Msg.LOCATION, T2019, 1, locationBody({ clock: new Date(NOW.getTime() + 480 * 60_000 - 60_000) })));
    expect(r.positions[0].fixTime).toBe(plus(-1).toISOString());
    expect(r.positions[0].uniqueId).toBe('13912345678');
    // The reply echoes the 2019 header format.
    expect(decodeMessage(split808(r.replies[0]).frames[0]).header.version2019).toBe(true);
  });

  it('applies S / W hemisphere bits', () => {
    const { feed } = harness();
    const [r] = feed(encodeMessage(Jt808Msg.LOCATION, T2013, 1, locationBody({ status: 0b1111, clock: NOW })));
    expect(r.positions[0].lat).toBeLessThan(0);
    expect(r.positions[0].lng).toBeLessThan(0);
  });

  it('reports an alarm bit once when it rises', () => {
    const { feed } = harness();
    const send = (alarm: number) => feed(encodeMessage(Jt808Msg.LOCATION, T2013, 1, locationBody({ alarm, clock: NOW })))[0].positions[0].attributes.alarm;
    expect(send(1)).toBe('sos');
    expect(send(1)).toBeUndefined(); // still set
    expect(send(1 | (1 << 8))).toBe('powerCut');
    expect(send(0)).toBeUndefined();
    expect(send(1)).toBe('sos');
  });

  it('names JT808 power / GPS / anti-theft bits and reports vendor bits as alarm_bit<n>; ignores pre-warnings', () => {
    const { feed } = harness();
    const send = (alarm: number) => feed(encodeMessage(Jt808Msg.LOCATION, T2013, 1, locationBody({ alarm, clock: NOW })))[0].positions[0].attributes.alarm;
    expect(send(1 << 7)).toBe('powerLow');
    expect(send(1 << 5)).toBe('gpsAntennaCut');
    expect(send(1 << 28)).toBe('towing');
    expect(send((1 << 31) >>> 0)).toBe('illegalDoorOpen');
    expect(send(1 << 15)).toBe('alarm_bit15');
    expect(send(0)).toBeUndefined();
    expect(send(1 << 13)).toBeUndefined(); // overspeed pre-warning
  });

  it('decodes ADAS / DMS events', () => {
    const { feed } = harness();
    const adas = Buffer.alloc(47);
    adas[4] = 1; // started
    adas[5] = 1; // FCW
    adas[6] = 2;
    const dms = Buffer.alloc(47);
    dms[4] = 0;
    dms[5] = 2; // phone
    const [r] = feed(encodeMessage(Jt808Msg.LOCATION, T2013, 1, locationBody({ clock: NOW, extras: [[0x64, adas], [0x65, dms]] })));
    expect(r.positions[0].attributes).toMatchObject({ adas: 'fcw', adasLevel: 2, dms: 'phone', event: 'fcw' });
  });

  it('marks batch (blind-area) uploads as reupload and never raises alarms from them', () => {
    const { feed } = harness();
    const items = [locationBody({ alarm: 1, clock: NOW }), locationBody({ clock: NOW })];
    const head = Buffer.from([0, 2, 1]);
    const body = Buffer.concat([head, ...items.flatMap((i) => [Buffer.from([0, i.length]), i])]);
    const [r] = feed(encodeMessage(Jt808Msg.BATCH, T2013, 1, body));
    expect(r.positions).toHaveLength(2);
    expect(r.positions.every((p) => p.attributes.reupload === true && p.attributes.alarm === undefined)).toBe(true);
  });

  it('reassembles sub-packaged messages', () => {
    const { feed } = harness();
    const body = locationBody({ clock: NOW });
    const part = (index: number, serial: number, chunk: Buffer) => {
      const f = encodeMessage(Jt808Msg.LOCATION, T2013, serial, chunk);
      // Re-encode with the sub-package bit and package fields (encodeMessage writes plain headers).
      const raw = split808(f).frames[0];
      const head = Buffer.from(raw.subarray(0, 12));
      head.writeUInt16BE((chunk.length & 0x3ff) | 0x2000, 2);
      const pk = Buffer.from([0, 2, 0, index]);
      const inner = Buffer.concat([head, pk, chunk]);
      let c = 0;
      for (const b of inner) c ^= b;
      return Buffer.concat([Buffer.from([0x7e]), escape808(Buffer.concat([inner, Buffer.from([c])])), Buffer.from([0x7e])]);
    };
    const [a] = feed(part(1, 20, body.subarray(0, 10)));
    expect(a.positions).toHaveLength(0);
    expect(a.replies).toHaveLength(1);
    const [b] = feed(part(2, 21, body.subarray(10)));
    expect(b.positions).toHaveLength(1);
  });

  it('encodes commands and matches the terminal general response', () => {
    const { decoder, session, feed } = harness();
    feed(encodeMessage(Jt808Msg.HEARTBEAT, T2013, 1, Buffer.alloc(0)));
    const out = decodeMessage(split808(decoder.encodeCommand('#8105:4', session, 555)).frames[0]);
    expect(out.header).toMatchObject({ msgId: 0x8105, terminalId: '13912345678' });
    expect([...out.body]).toEqual([4]);

    const reply = Buffer.alloc(5);
    reply.writeUInt16BE(out.header.serial, 0);
    reply.writeUInt16BE(0x8105, 2);
    const [r] = feed(encodeMessage(Jt808Msg.TERMINAL_RESPONSE, T2013, 2, reply));
    expect(r.commandResponses).toEqual([{ ref: 555, text: 'OK (0x8105)' }]);

    const tts = decodeMessage(split808(decoder.encodeCommand('Slow down', session, 556)).frames[0]);
    expect(tts.header.msgId).toBe(Jt808Msg.TEXT);
    expect(tts.body.subarray(1).toString('ascii')).toBe('Slow down');
  });

  it('logs malformed frames instead of throwing', () => {
    const { feed, unparsed } = harness();
    const [r] = feed(encodeMessage(Jt808Msg.LOCATION, T2013, 1, Buffer.alloc(10)));
    expect(r.positions).toHaveLength(0);
    expect(unparsed).toHaveBeenCalled();
  });
});
