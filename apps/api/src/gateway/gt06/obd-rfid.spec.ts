import { DecodeContext } from '../protocol';
import { decodeFrames, decodeMessage, encodeGps22, encodeInfo, encodeLogin, encodeObd, frameProtocol, Gt06InfoType, Gt06Protocol } from './codec';
import { crcItu } from './crc';
import { Gt06Decoder } from './decoder';

// Frames built from the public spec (Traccar's Gt06ProtocolDecoder layouts); real device captures still to be added.
const NOW = new Date('2026-10-19T06:30:20Z');
const IMEI = '359647091912738';
const lbs = { mcc: 404, mnc: 45, lac: 0x1a2b, cellId: 0x00c3d4 };
const fix = { time: new Date('2026-10-19T06:30:15Z'), gpsInfoLength: 12, satellites: 9, lat: 13.0827, lng: 80.2707, speedKph: 42, course: 271, positioned: true };

function setup() {
  const decoder = new Gt06Decoder();
  const session = decoder.createSession();
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: NOW, remote: '1.2.3.4:5', unparsed: (reason) => unparsed.push(reason), warn: () => undefined };
  const feed = (frame: Buffer) => {
    const split = decodeFrames(frame);
    expect(split.frames).toHaveLength(1); // CRC-ITU correct
    return decoder.decode(split.frames[0], session, ctx);
  };
  feed(encodeLogin(IMEI, 1));
  return { session, feed, unparsed };
}

describe('GT06 OBD (0x8C)', () => {
  it('builds a frame with a valid CRC-ITU', () => {
    const f = encodeObd(NOW, true, '2D=0C80', 7);
    expect(frameProtocol(f)).toBe(Gt06Protocol.OBD);
    expect(f.readUInt16BE(f.length - 4)).toBe(crcItu(f, 2, f.length - 4));
  });

  it('maps OBD pairs to normalised attributes and keeps them on later positions', () => {
    const { feed } = setup();
    feed(encodeGps22({ fix, lbs, acc: true }, 2));
    // keys read as hex: 0x36=54 rpm, 0x2D=45 coolant, 0x2B=43 fuel %, 0x28=40 odometer, 0x35=53 speed; values hex × 0.01
    const r = feed(encodeObd(NOW, true, '3600=2EE00,2D00=2328,2B00=1388,2800=F4240,3500=1068,9900=1', 3));
    expect(r.replies).toHaveLength(1); // echoed ACK
    expect(frameProtocol(r.replies[0])).toBe(Gt06Protocol.OBD);
    expect(r.positions).toHaveLength(1);
    const p = r.positions[0];
    expect(p.valid).toBe(false);
    expect(p.lat).toBeCloseTo(13.0827, 4);
    expect(p.fixTime).toBe(NOW.toISOString());
    expect(p.attributes).toMatchObject({ rpm: 1920, coolantTemp: 90, fuelLevelPct: 50, obdOdometerKm: 10000, obdSpeedKph: 42, obd_9900: '1', event: 'obd' });
    const next = feed(encodeGps22({ fix, lbs, acc: true }, 4)).positions[0];
    expect(next.attributes).toMatchObject({ rpm: 1920, fuelLevelPct: 50 });
    expect(next.attributes.event).toBeUndefined();
  });

  it('logs an OBD packet without pairs as unparsed (no throw)', () => {
    const { feed, unparsed } = setup();
    const r = feed(encodeObd(NOW, false, 'garbage', 5));
    expect(r.positions).toHaveLength(0);
    expect(unparsed[0]).toMatch(/OBD/);
  });
});

describe('GT06 0x94 information: RFID, fuel sensor, unknown', () => {
  it('reports a binary RFID card as driverId with an rfid event', () => {
    const { feed } = setup();
    // header · type · card(4) · checksum · footer
    const r = feed(encodeInfo(Gt06InfoType.RFID, Buffer.from('2a010a1b2c3d550d', 'hex'), 6));
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].attributes).toMatchObject({ driverId: '0A1B2C3D', rfid: '0A1B2C3D', event: 'rfid' });
  });

  it('reports an ASCII (decimal) RFID card as is', () => {
    const { feed } = setup();
    const r = feed(encodeInfo(Gt06InfoType.RFID, Buffer.from('0012345678\r\n', 'latin1'), 7));
    expect(r.positions[0].attributes.driverId).toBe('0012345678');
  });

  it('keeps the serial fuel sensor reading for later positions', () => {
    const { feed } = setup();
    const r = feed(encodeInfo(Gt06InfoType.FUEL_SENSOR, Buffer.from('!AIOAU,1,2,3,4,27,1543,0', 'latin1'), 8));
    expect(r.positions).toHaveLength(0);
    const p = feed(encodeGps22({ fix, lbs, acc: true }, 9)).positions[0];
    expect(p.attributes).toMatchObject({ fuelSensorRaw: 1543, fuelSensorTemp: 27 });
  });

  it('logs unknown 0x94 sub-types as unparsed instead of throwing', () => {
    const { feed, unparsed } = setup();
    const r = feed(encodeInfo(0x7e, Buffer.from([1, 2, 3]), 10));
    expect(r.positions).toHaveLength(0);
    expect(unparsed).toEqual(['unknown 0x94 sub-type 0x7e']);
  });

  it('decodes RFID with no readable card as unknown', () => {
    const f = decodeFrames(encodeInfo(Gt06InfoType.RFID, Buffer.from([0, 0]), 11)).frames[0];
    expect(decodeMessage(f)).toMatchObject({ type: 'info', known: false });
  });
});
