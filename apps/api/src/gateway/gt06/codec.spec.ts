import {
  batteryFromVoltageLevel,
  decodeFrames,
  decodeMessage,
  encodeAck,
  encodeAlarm,
  encodeGps22,
  encodeHeartbeat,
  encodeLogin,
  frameProtocol,
  Gt06Fix,
  Gt06Protocol,
} from './codec';
import { crcItu } from './crc';

const lbs = { mcc: 404, mnc: 45, lac: 0x1a2b, cellId: 0x00c3d4 };

function fix(overrides: Partial<Gt06Fix> = {}): Gt06Fix {
  return {
    time: new Date(Date.UTC(2026, 9, 18, 6, 30, 15)),
    gpsInfoLength: 12,
    satellites: 9,
    lat: 13.0827,
    lng: 80.2707,
    speedKph: 42,
    course: 271,
    positioned: true,
    ...overrides,
  };
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0];
}

describe('crcItu', () => {
  it('matches the CRC-16/X-25 check value', () => {
    expect(crcItu(Buffer.from('123456789'))).toBe(0x906e);
  });

  it('matches the GT06 login ACK vector 05 01 00 01 -> D9DC', () => {
    expect(crcItu(Buffer.from([0x05, 0x01, 0x00, 0x01]))).toBe(0xd9dc);
  });
});

describe('encodeAck', () => {
  it('produces the documented login ACK bytes', () => {
    const ack = encodeAck(Gt06Protocol.LOGIN, 1);
    expect(ack.toString('hex')).toBe('787805010001d9dc0d0a');
    expect(frameProtocol(only(decodeFrames(ack).frames))).toBe(Gt06Protocol.LOGIN);
  });
});

describe('GT06 round trips', () => {
  it('login', () => {
    const frame = only(decodeFrames(encodeLogin('868120000000001', 7, 0x3612, 0x3200)).frames);
    expect(decodeMessage(frame)).toEqual({
      type: 'login',
      protocol: 0x01,
      serial: 7,
      imei: '868120000000001',
      typeId: 0x3612,
      timezone: 0x3200,
    });
  });

  it('decodes a known login frame from hex', () => {
    // CRC A37B computed independently with a bitwise CRC-16/X-25 over 0d..0001.
    const frame = Buffer.from('78780d0108681200000000010001a37b0d0a', 'hex');
    const msg = decodeMessage(only(decodeFrames(frame).frames));
    expect(msg).toMatchObject({ type: 'login', imei: '868120000000001', serial: 1, typeId: null });
  });

  it('0x22 GPS in the north-east hemisphere with course bits', () => {
    const encoded = encodeGps22({ fix: fix(), lbs, acc: true, uploadMode: 0, reupload: false }, 42);
    const msg = decodeMessage(only(decodeFrames(encoded).frames));
    if (msg.type !== 'gps') throw new Error('expected gps');
    expect(msg.protocol).toBe(0x22);
    expect(msg.serial).toBe(42);
    expect(msg.fix.time.toISOString()).toBe('2026-10-18T06:30:15.000Z');
    expect(msg.fix.lat).toBeCloseTo(13.0827, 5);
    expect(msg.fix.lng).toBeCloseTo(80.2707, 5);
    expect(msg.fix.course).toBe(271);
    expect(msg.fix.speedKph).toBe(42);
    expect(msg.fix.satellites).toBe(9);
    expect(msg.fix.positioned).toBe(true);
    expect(msg.lbs).toEqual(lbs);
    expect(msg.acc).toBe(true);
    expect(msg.reupload).toBe(false);
    expect(msg.mileage).toBeNull();
  });

  it('0x22 GPS in the south-west hemisphere, unpositioned, with mileage', () => {
    const encoded = encodeGps22(
      { fix: fix({ lat: -33.8688, lng: -70.6693, course: 300, positioned: false }), lbs, acc: false, mileage: 123456 },
      65535,
    );
    const msg = decodeMessage(only(decodeFrames(encoded).frames));
    if (msg.type !== 'gps') throw new Error('expected gps');
    expect(msg.fix.lat).toBeCloseTo(-33.8688, 5);
    expect(msg.fix.lng).toBeCloseTo(-70.6693, 5);
    expect(msg.fix.course).toBe(300);
    expect(msg.fix.positioned).toBe(false);
    expect(msg.acc).toBe(false);
    expect(msg.mileage).toBe(123456);
    expect(msg.serial).toBe(65535);
  });

  it('encodes hemisphere and positioned flags into the course/status word', () => {
    const word = (f: Gt06Fix) => encodeGps22({ fix: f, lbs, acc: false }, 1).readUInt16BE(4 + 16);
    expect(word(fix({ course: 90 })) & 0x1c00).toBe(0x1400); // north, east, positioned
    expect(word(fix({ course: 90, lat: -1, lng: -1, positioned: false })) & 0x1c00).toBe(0x0800); // south, west
    expect(word(fix({ course: 359 })) & 0x03ff).toBe(359);
  });

  it('heartbeat', () => {
    const status = { ignition: true, charging: false, oilCut: true, voltageLevel: 4, gsmSignal: 3 };
    const msg = decodeMessage(only(decodeFrames(encodeHeartbeat(status, 9)).frames));
    expect(msg).toEqual({ type: 'heartbeat', protocol: 0x13, serial: 9, status, alarmLang: 2 });
    expect(batteryFromVoltageLevel(4)).toBe(67);
    expect(batteryFromVoltageLevel(6)).toBe(100);
  });

  it('alarm (0x26 SOS)', () => {
    const status = { ignition: false, charging: true, oilCut: false, voltageLevel: 6, gsmSignal: 4 };
    const encoded = encodeAlarm({ fix: fix({ speedKph: 0 }), lbs, status, alarm: 0x01 }, 300);
    const msg = decodeMessage(only(decodeFrames(encoded).frames));
    if (msg.type !== 'alarm') throw new Error('expected alarm');
    expect(msg.protocol).toBe(0x26);
    expect(msg.alarm).toBe(0x01);
    expect(msg.status).toEqual(status);
    expect(msg.lbs).toEqual(lbs);
    expect(msg.fix.lat).toBeCloseTo(13.0827, 5);
  });

  it('unknown protocols decode as unknown', () => {
    const frame = only(decodeFrames(encodeAck(0x99, 3)).frames);
    expect(decodeMessage(frame)).toMatchObject({ type: 'unknown', protocol: 0x99, serial: 3 });
  });
});

describe('decodeFrames stream handling', () => {
  const a = encodeLogin('868120000000001', 1);
  const b = encodeGps22({ fix: fix(), lbs, acc: true }, 2);
  const c = encodeHeartbeat({ ignition: true, charging: true, oilCut: false, voltageLevel: 5, gsmSignal: 4 }, 3);

  it('returns multiple frames from one chunk', () => {
    const { frames, rest, dropped } = decodeFrames(Buffer.concat([a, b, c]));
    expect(frames.map((f) => decodeMessage(f).type)).toEqual(['login', 'gps', 'heartbeat']);
    expect(rest).toHaveLength(0);
    expect(dropped).toBe(0);
  });

  it('reassembles frames fragmented at every byte boundary', () => {
    const stream = Buffer.concat([a, b, c]);
    for (let cut = 1; cut < stream.length; cut++) {
      const first = decodeFrames(stream.subarray(0, cut));
      const second = decodeFrames(Buffer.concat([first.rest, stream.subarray(cut)]));
      expect(first.frames.length + second.frames.length).toBe(3);
      expect(second.rest).toHaveLength(0);
    }
  });

  it('feeds one byte at a time', () => {
    const stream = Buffer.concat([a, b, c]);
    let rest: Buffer = Buffer.alloc(0);
    let count = 0;
    for (const byte of stream) {
      const out = decodeFrames(Buffer.concat([rest, Buffer.from([byte])]));
      count += out.frames.length;
      rest = out.rest;
    }
    expect(count).toBe(3);
  });

  it('skips leading and interleaved garbage', () => {
    const garbage = Buffer.from('deadbeef0d0a7801', 'hex');
    const { frames, dropped } = decodeFrames(Buffer.concat([garbage, a, garbage, b]));
    expect(frames.map((f) => decodeMessage(f).type)).toEqual(['login', 'gps']);
    expect(dropped).toBeGreaterThan(0);
  });

  it('drops frames with a bad CRC and resyncs on the next frame', () => {
    const corrupt = Buffer.from(b);
    corrupt[10] ^= 0xff;
    const { frames } = decodeFrames(Buffer.concat([corrupt, c]));
    expect(frames.map((f) => decodeMessage(f).type)).toEqual(['heartbeat']);
  });

  it('keeps a trailing partial start marker', () => {
    const { frames, rest } = decodeFrames(Buffer.concat([a, Buffer.from([0x11, 0x78])]));
    expect(frames).toHaveLength(1);
    expect(rest.toString('hex')).toBe('78');
  });

  it('supports 79 79 long frames', () => {
    const long = Buffer.from(encodeAck(0x99, 5));
    const frame = Buffer.alloc(long.length + 1);
    frame[0] = frame[1] = 0x79;
    frame.writeUInt16BE(5, 2);
    long.copy(frame, 4, 3);
    frame.writeUInt16BE(crcItu(frame, 2, frame.length - 4), frame.length - 4);
    const msg = decodeMessage(only(decodeFrames(frame).frames));
    expect(msg).toMatchObject({ type: 'unknown', protocol: 0x99, serial: 5 });
  });
});
