import { DecodeContext } from '../protocol';
import { decodeFrames, decodeMessage, encodeGps22, encodeInfo, encodeLogin, Gt06InfoType } from './codec';
import { crcItu } from './crc';
import { Gt06Decoder } from './decoder';
import { mapIo } from '../teltonika/decoder';

// 0x94 sub-type 0x05 (door / IO status) per the public spec (Traccar's Gt06ProtocolDecoder); verify with a capture.
const NOW = new Date('2026-10-20T06:30:20Z');
const IMEI = '351510093804238';
const lbs = { mcc: 404, mnc: 45, lac: 0x1a2b, cellId: 0x00c3d4 };
const fix = { time: new Date('2026-10-20T06:30:15Z'), gpsInfoLength: 12, satellites: 9, lat: 13.0827, lng: 80.2707, speedKph: 42, course: 271, positioned: true };

function setup(now = NOW) {
  const decoder = new Gt06Decoder();
  const session = decoder.createSession();
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: now, remote: '1.2.3.4:5', unparsed: (reason) => unparsed.push(reason), warn: () => undefined };
  const feed = (frame: Buffer, at?: Date) => {
    const split = decodeFrames(frame);
    expect(split.frames).toHaveLength(1); // CRC-ITU correct
    return decoder.decode(split.frames[0], session, at ? { ...ctx, receivedAt: at } : ctx);
  };
  feed(encodeLogin(IMEI, 1));
  return { session, feed, unparsed };
}

describe('GT06 0x94 / 0x05 door and inputs', () => {
  it('builds a frame with a valid CRC-ITU and decodes the flags byte', () => {
    const f = encodeInfo(Gt06InfoType.DOOR, Buffer.from([0x05]), 9);
    expect(f.readUInt16BE(f.length - 4)).toBe(crcItu(f, 2, f.length - 4));
    expect(decodeMessage(f)).toMatchObject({ type: 'info', infoType: 0x05, known: true, inputs: { door: true, in1: true, in2: false } });
  });

  it('reads the flags after a 6-byte date on newer firmware', () => {
    const f = encodeInfo(Gt06InfoType.DOOR, Buffer.from([26, 10, 20, 6, 30, 0, 0x02]), 9);
    expect(decodeMessage(f)).toMatchObject({ inputs: { door: false, in1: false, in2: true } });
  });

  it('emits an event position on change and merges the flags into later GPS positions', () => {
    const { feed, unparsed } = setup();
    feed(encodeGps22({ fix, lbs, acc: true }, 2));
    const r = feed(encodeInfo(Gt06InfoType.DOOR, Buffer.from([0x01]), 3));
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].attributes).toMatchObject({ door: true, in1: false, in2: false, event: 'io' });
    // Same flags again: no extra event position.
    expect(feed(encodeInfo(Gt06InfoType.DOOR, Buffer.from([0x01]), 4)).positions).toHaveLength(0);
    const next = feed(encodeGps22({ fix, lbs, acc: true }, 5)).positions[0];
    expect(next.attributes).toMatchObject({ door: true, in1: false });
    expect(unparsed).toHaveLength(0);
  });

  it('drops stale flags 15 minutes after the last 0x05 packet', () => {
    const { feed } = setup();
    feed(encodeInfo(Gt06InfoType.DOOR, Buffer.from([0x01]), 3));
    const later = new Date(NOW.getTime() + 16 * 60_000);
    const p = feed(encodeGps22({ fix: { ...fix, time: later }, lbs, acc: true }, 5), later).positions[0];
    expect(p.attributes.door).toBeUndefined();
  });

  it('an empty 0x05 payload is logged as unparsed, never thrown', () => {
    const { feed, unparsed } = setup();
    expect(() => feed(encodeInfo(Gt06InfoType.DOOR, Buffer.alloc(0), 3))).not.toThrow();
    expect(unparsed[0]).toMatch(/0x05/);
  });
});

describe('Teltonika digital / analog inputs', () => {
  it('maps DIN1..DIN4 (IO 1–4) to in1..in4 and AIN1 / AIN2 (IO 9 / 10, mV) to adc1 / adc2 (V)', () => {
    const io = [{ id: 1, value: 1 }, { id: 2, value: 0 }, { id: 3, value: 1 }, { id: 4, value: 1 }, { id: 9, value: 12450 }, { id: 10, value: 3300 }];
    const { attributes } = mapIo({ io } as never);
    expect(attributes).toMatchObject({ di1: true, in1: true, di2: false, in2: false, in3: true, di4: true, in4: true, adc1: 12.45, adc2: 3.3 });
    expect(attributes).not.toHaveProperty('io4');
  });

  it('leaves inputs a record does not carry absent', () => {
    const { attributes } = mapIo({ io: [{ id: 2, value: 1 }] } as never);
    expect(attributes).toMatchObject({ in2: true });
    expect(attributes).not.toHaveProperty('in1');
    expect(attributes).not.toHaveProperty('adc1');
  });
});
