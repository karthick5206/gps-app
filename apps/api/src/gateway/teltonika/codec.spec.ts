import { crc16Ibm, decodeTeltonika, encodeAvlPacket, encodeCodec12, encodeImei, splitTeltonika, TeltonikaCodec } from './codec';
import { mapIo, TeltonikaDecoder } from './decoder';
import { DecodeContext } from '../protocol';

// Public examples from Teltonika's "Codec" documentation (Codec 8 and Codec 8 Extended).
const CODEC8_SAMPLE =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';
const CODEC8E_SAMPLE =
  '000000000000004A8E010000016B412CEE000100000000000000000000000000000000010005000100010100010011001D00010010015E2C880002000B000000003544C87A000E000000001DD7E06A00000100002994';

const hex = (h: string) => Buffer.from(h, 'hex');

function ctx(): DecodeContext & { unparsedCalls: string[] } {
  const unparsedCalls: string[] = [];
  return { receivedAt: new Date('2026-10-18T05:00:00Z'), remote: 'test', unparsed: (reason) => unparsedCalls.push(reason), warn: () => undefined, unparsedCalls };
}

describe('crc16Ibm', () => {
  it('matches the CRC-16/ARC check value', () => {
    expect(crc16Ibm(Buffer.from('123456789'))).toBe(0xbb3d);
  });
});

describe('Teltonika public vectors', () => {
  it('decodes the Codec 8 sample', () => {
    const d = decodeTeltonika(hex(CODEC8_SAMPLE), true);
    if (d.type !== 'avl') throw new Error('expected avl');
    expect(d.codec).toBe(TeltonikaCodec.CODEC_8);
    expect(d.records).toHaveLength(1);
    const r = d.records[0];
    expect(r.timestamp.toISOString()).toBe('2019-06-10T10:04:46.000Z');
    expect(r.priority).toBe(1);
    expect(r.eventIoId).toBe(1);
    expect(r.io.map((x) => [x.id, x.value])).toEqual([
      [21, 3],
      [1, 1],
      [66, 24079],
      [241, 24602],
      [78, 0],
    ]);
  });

  it('decodes the Codec 8 Extended sample', () => {
    const d = decodeTeltonika(hex(CODEC8E_SAMPLE), true);
    if (d.type !== 'avl') throw new Error('expected avl');
    expect(d.codec).toBe(TeltonikaCodec.CODEC_8E);
    expect(d.records[0].io.map((x) => [x.id, x.value])).toEqual([
      [1, 1],
      [17, 29],
      [16, 22949000],
      [11, 893700218],
      [14, 500686954],
    ]);
  });

  it('maps the Codec 8 sample IO to normalised attributes', () => {
    const d = decodeTeltonika(hex(CODEC8_SAMPLE), true);
    if (d.type !== 'avl') throw new Error('expected avl');
    const { ignition, attributes } = mapIo(d.records[0]);
    expect(ignition).toBeNull();
    expect(attributes).toMatchObject({ gsmSignal: 2, di1: true, extVoltage: 24.08, io241: 24602, event: 1 });
    expect(attributes).not.toHaveProperty('driverId'); // iButton 0 = none
  });
});

describe('Teltonika splitting', () => {
  it('splits the IMEI handshake then AVL packets, across fragments', () => {
    const stream = Buffer.concat([encodeImei('356307042441013'), hex(CODEC8_SAMPLE), hex(CODEC8E_SAMPLE)]);
    let identified = false;
    let rest = Buffer.alloc(0);
    const frames: Buffer[] = [];
    for (let i = 0; i < stream.length; i += 7) {
      const s = splitTeltonika(Buffer.concat([rest, stream.subarray(i, i + 7)]), identified);
      for (const f of s.frames) {
        frames.push(f);
        if (!identified) identified = true;
      }
      rest = Buffer.from(s.rest);
    }
    expect(frames).toHaveLength(3);
    expect(decodeTeltonika(frames[0], false)).toEqual({ type: 'imei', imei: '356307042441013' });
  });

  it('rejects a stream that does not start with an IMEI handshake', () => {
    expect(splitTeltonika(hex('78780d01'), false).fatal).toBeDefined();
  });

  it('resyncs on the next preamble after garbage', () => {
    const s = splitTeltonika(Buffer.concat([hex('deadbeef01'), hex(CODEC8_SAMPLE)]), true);
    expect(s.frames).toHaveLength(1);
    expect(s.dropped).toBeGreaterThan(0);
  });
});

describe('Teltonika round trips', () => {
  const ts = new Date('2026-10-18T04:59:50Z');

  it('Codec 8 record with ignition, voltage, odometer, temperature and iButton', () => {
    const pkt = encodeAvlPacket([
      {
        timestamp: ts,
        lat: 13.0827,
        lng: 80.2707,
        altitude: 12,
        angle: 271,
        satellites: 11,
        speedKph: 54,
        eventIoId: 239,
        io: { 239: 1, 240: 1, 21: 5, 66: 12650, 67: 4100, 16: 1234567, 72: 0xffffffce, 78: 0x01a2b3c4d5 },
        sizes: { 66: 2, 67: 2, 16: 4, 72: 4, 78: 8 },
      },
    ]);
    const d = decodeTeltonika(pkt, true);
    if (d.type !== 'avl') throw new Error('expected avl');
    const r = d.records[0];
    expect(r.lat).toBeCloseTo(13.0827, 6);
    expect(r.lng).toBeCloseTo(80.2707, 6);
    const { ignition, attributes } = mapIo(r);
    expect(ignition).toBe(true);
    expect(attributes).toMatchObject({ motion: true, gsmSignal: 4, extVoltage: 12.65, batteryVoltage: 4.1, odometerM: 1234567, temp1: -5, driverId: '1A2B3C4D5' });
  });

  it('Codec 8E with NX values', () => {
    const pkt = encodeAvlPacket([{ timestamp: ts, lat: 1, lng: 2, satellites: 5, io: { 239: 0 }, nx: { 256: Buffer.from('WVWZZZ1JZXW000001') } }], TeltonikaCodec.CODEC_8E);
    const d = decodeTeltonika(pkt, true);
    if (d.type !== 'avl') throw new Error('expected avl');
    expect(d.records[0].io.find((x) => x.id === 256)?.value).toEqual(Buffer.from('WVWZZZ1JZXW000001'));
  });

  it('decodes a Codec 12 response', () => {
    expect(decodeTeltonika(encodeCodec12('DOUT1:1 Timeout:INFINITY', 0x06), true)).toEqual({ type: 'response', codec: 0x0c, text: 'DOUT1:1 Timeout:INFINITY' });
  });

  it('rejects a corrupted packet by CRC', () => {
    const pkt = Buffer.from(hex(CODEC8_SAMPLE));
    pkt[20] ^= 0xff;
    expect(() => decodeTeltonika(pkt, true)).toThrow(/CRC/);
  });
});

describe('Teltonika alarms', () => {
  const base = { timestamp: new Date(), lat: 0, lng: 0, satellites: 0 };
  const alarmOf = (input: Parameters<typeof encodeAvlPacket>[0][0]) => {
    const d = decodeTeltonika(encodeAvlPacket([input]), true);
    if (d.type !== 'avl') throw new Error('expected avl');
    return mapIo(d.records[0]).attributes.alarm;
  };
  it('maps crash, green driving, unplug (on its own event) and panic priority', () => {
    expect(alarmOf({ ...base, eventIoId: 247, io: { 247: 1 } })).toBe('crash');
    expect(alarmOf({ ...base, eventIoId: 253, io: { 253: 2, 254: 35 } })).toBe('harshBraking');
    expect(alarmOf({ ...base, eventIoId: 252, io: { 252: 1 } })).toBe('powerCut');
    expect(alarmOf({ ...base, eventIoId: 239, io: { 252: 1 } })).toBeUndefined(); // still unplugged, not the event
    expect(alarmOf({ ...base, priority: 2 })).toBe('sos');
  });
});

describe('TeltonikaDecoder', () => {
  it('accepts the IMEI, then ACKs records with their count', () => {
    const decoder = new TeltonikaDecoder();
    const session = decoder.createSession();
    const c = ctx();
    const login = decoder.decode(encodeImei('356307042441013'), session, c);
    expect(login.replies).toEqual([Buffer.from([0x01])]);
    expect(session.uniqueId).toBe('356307042441013');

    const pkt = encodeAvlPacket([
      { timestamp: new Date('2026-10-18T04:59:00Z'), lat: 13, lng: 80, satellites: 8, speedKph: 30, io: { 239: 1 } },
      { timestamp: new Date('2026-10-18T04:59:30Z'), lat: 13.001, lng: 80.001, satellites: 8, speedKph: 32, io: { 239: 1 } },
    ]);
    const out = decoder.decode(pkt, session, c);
    expect(out.replies).toEqual([Buffer.from([0, 0, 0, 2])]);
    expect(out.positions).toHaveLength(2);
    expect(out.positions[0]).toMatchObject({ protocol: 'teltonika', uniqueId: '356307042441013', valid: true, ignition: true, speedKph: 30 });
    expect(out.positions[0].raw).toBeDefined();
    expect(out.positions[1].raw).toBeUndefined();
  });

  it('does not ACK a corrupted packet and logs it as unparsed', () => {
    const decoder = new TeltonikaDecoder();
    const session = { uniqueId: '356307042441013' };
    const c = ctx();
    const pkt = Buffer.from(hex(CODEC8_SAMPLE));
    pkt[25] ^= 0x01;
    const out = decoder.decode(pkt, session, c);
    expect(out.replies).toEqual([]);
    expect(c.unparsedCalls[0]).toMatch(/CRC/);
  });
});
