import { DecodeContext } from '../protocol';
import {
  decodeFrames,
  encodeAlarm,
  encodeFrame,
  encodeGps22,
  encodeGpsA0,
  encodeHeartbeat,
  encodeHeartbeat23,
  encodeInfoVoltage,
  encodeLogin,
  frameProtocol,
  Gt06Fix,
  Gt06Protocol,
  timeZoneWord,
} from './codec';
import { Gt06Decoder } from './decoder';

const NOW = new Date('2026-10-18T06:30:20Z');
const lbs = { mcc: 404, mnc: 45, lac: 0x1a2b, cellId: 0x00c3d4 };
const IMEI = '359647091912738';

function fix(overrides: Partial<Gt06Fix> = {}): Gt06Fix {
  return { time: new Date('2026-10-18T06:30:15Z'), gpsInfoLength: 12, satellites: 9, lat: 13.0827, lng: 80.2707, speedKph: 42, course: 271, positioned: true, ...overrides };
}

function setup() {
  const decoder = new Gt06Decoder();
  const session = decoder.createSession();
  const unparsed: string[] = [];
  const warnings: string[] = [];
  const ctx: DecodeContext = { receivedAt: NOW, remote: '1.2.3.4:5', unparsed: (reason) => unparsed.push(reason), warn: (_k, m) => warnings.push(m) };
  const feed = (frame: Buffer) => decoder.decode(decodeFrames(frame).frames[0], session, ctx);
  return { decoder, session, feed, unparsed, warnings };
}

describe('Gt06Decoder', () => {
  it('ignores positions before login and ACKs the login', () => {
    const { feed, session } = setup();
    expect(feed(encodeGps22({ fix: fix(), lbs, acc: true }, 1)).positions).toHaveLength(0);
    const login = feed(encodeLogin(IMEI, 2));
    expect(session.uniqueId).toBe(IMEI);
    expect(login.replies.map(frameProtocol)).toEqual([0x01]);
  });

  it('device clock in local time (+05:30 reported at login) is converted to UTC', () => {
    const { feed, warnings } = setup();
    feed(encodeLogin(IMEI, 1, 0x3612, timeZoneWord(330)));
    const out = feed(encodeGps22({ fix: fix(), lbs, acc: true, clockOffsetMinutes: 330 }, 2));
    expect(out.positions[0].fixTime).toBe('2026-10-18T06:30:15.000Z');
    expect(warnings.join()).toMatch(/clock is local/);
    // Later packets use the same decision, including history re-uploads.
    const later = feed(encodeGps22({ fix: fix({ time: new Date('2026-10-18T05:00:00Z') }), lbs, acc: true, reupload: true, clockOffsetMinutes: 330 }, 3));
    expect(later.positions[0].fixTime).toBe('2026-10-18T05:00:00.000Z');
  });

  it('device that reports a zone but stamps UTC is detected and not shifted', () => {
    const { feed, warnings } = setup();
    feed(encodeLogin(IMEI, 1, 0x3612, timeZoneWord(330)));
    const out = feed(encodeGps22({ fix: fix(), lbs, acc: true }, 2));
    expect(out.positions[0].fixTime).toBe('2026-10-18T06:30:15.000Z');
    expect(warnings.join()).toMatch(/clock is UTC/);
  });

  it('no zone at login means UTC', () => {
    const { feed } = setup();
    feed(encodeLogin(IMEI, 1));
    expect(feed(encodeGps22({ fix: fix(), lbs, acc: false }, 2)).positions[0].fixTime).toBe('2026-10-18T06:30:15.000Z');
  });

  it('heartbeats are ACKed and enrich the next position (0x13 battery, 0x23/0x94 voltage)', () => {
    const { feed } = setup();
    feed(encodeLogin(IMEI, 1));
    const hb = feed(encodeHeartbeat({ ignition: true, charging: true, oilCut: false, voltageLevel: 3, gsmSignal: 4 }, 2));
    expect(hb.replies.map(frameProtocol)).toEqual([0x13]);
    const hb23 = feed(encodeHeartbeat23({ ignition: true, charging: true, oilCut: false, gsmSignal: 2 }, 12.6, 3));
    expect(hb23.replies.map(frameProtocol)).toEqual([0x23]);
    expect(feed(encodeInfoVoltage(12.9, 4)).replies).toEqual([]);
    const p = feed(encodeGps22({ fix: fix(), lbs, acc: true }, 5)).positions[0];
    expect(p.attributes).toMatchObject({ batteryLevel: 50, gsmSignal: 2, charging: true, extVoltage: 12.9 });
  });

  it('4G 0xA0 positions and 0xA4 alarms with normalised alarm names', () => {
    const { feed } = setup();
    feed(encodeLogin(IMEI, 1));
    const p = feed(encodeGpsA0({ fix: fix(), lbs: { ...lbs, lac: 0x12345, cellId: 0xabcdef12 }, acc: true }, 2)).positions[0];
    expect(p).toMatchObject({ protocol: 'gt06', uniqueId: IMEI, ignition: true, attributes: { lac: 0x12345, cellId: 0xabcdef12 } });
    const status = { ignition: false, charging: false, oilCut: false, voltageLevel: 6, gsmSignal: 4 };
    const alarm = feed(encodeAlarm({ fix: fix(), lbs, status, alarm: 0x02 }, 3, Gt06Protocol.ALARM_4G));
    expect(alarm.replies.map(frameProtocol)).toEqual([0xa4]);
    expect(alarm.positions[0].attributes.alarm).toBe('powerCut');
  });

  it('answers a time request with the current UTC time', () => {
    const { feed } = setup();
    feed(encodeLogin(IMEI, 1));
    const out = feed(encodeFrame(Gt06Protocol.TIME_REQUEST, Buffer.alloc(0), 2));
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0].subarray(4, 10)).toEqual(Buffer.from([26, 10, 18, 6, 30, 20]));
  });

  it('unknown and truncated packets are logged as unparsed, not thrown', () => {
    const { feed, unparsed } = setup();
    feed(encodeLogin(IMEI, 1));
    expect(feed(encodeFrame(0x99, Buffer.from([1, 2, 3]), 2)).positions).toEqual([]);
    expect(feed(encodeFrame(Gt06Protocol.GPS_LBS_STATUS, Buffer.alloc(10), 3)).positions).toEqual([]);
    expect(unparsed).toHaveLength(2);
  });
});
