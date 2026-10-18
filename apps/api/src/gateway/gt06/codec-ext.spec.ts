import {
  decodeFrames,
  decodeMessage,
  encodeAlarm,
  encodeCommand,
  encodeFrame,
  encodeGps22,
  encodeGpsA0,
  encodeHeartbeat23,
  encodeInfoVoltage,
  encodeTimeResponse,
  Gt06Fix,
  Gt06Protocol,
  timeZoneMinutes,
  timeZoneWord,
} from './codec';

// GT800 / V5 / VL149 (4G) packet variants on top of the M1 GT06 set.

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

const only = (frames: Buffer[]) => {
  expect(frames).toHaveLength(1);
  return frames[0];
};
const roundTrip = (frame: Buffer) => decodeMessage(only(decodeFrames(frame).frames));

describe('LBS block variants', () => {
  it('0x22 with a 2-byte MNC (MCC bit 15) keeps ACC and mileage aligned', () => {
    const lbs = { mcc: 405, mnc: 857, lac: 0x1a2b, cellId: 0x0c3d4e };
    const msg = roundTrip(encodeGps22({ fix: fix(), lbs, acc: true, uploadMode: 3, reupload: false, mileage: 123456 }, 5));
    if (msg.type !== 'gps') throw new Error('expected gps');
    expect(msg.lbs).toEqual(lbs);
    expect(msg.acc).toBe(true);
    expect(msg.uploadMode).toBe(3);
    expect(msg.mileage).toBe(123456);
  });

  it('decodes a hand-built 0x22 frame with a 2-byte MNC', () => {
    const content = Buffer.concat([
      Buffer.from('1a0a12061e0f', 'hex'), // 2026-10-18 06:30:15
      Buffer.from([0xc9]),
      Buffer.alloc(8), // lat/lng 0
      Buffer.from([0x00, 0x14, 0x00]), // speed 0, course/status: positioned, north, east
      Buffer.from('8195' + '0359' + '1a2b' + '0c3d4e', 'hex'), // MCC 405|0x8000, MNC 857, LAC, cell
      Buffer.from([0x01, 0x00, 0x00]), // ACC on, upload mode, real-time
    ]);
    const msg = roundTrip(encodeFrame(Gt06Protocol.GPS_LBS_STATUS, content, 1));
    if (msg.type !== 'gps') throw new Error('expected gps');
    expect(msg.lbs).toEqual({ mcc: 405, mnc: 857, lac: 0x1a2b, cellId: 0x0c3d4e });
    expect(msg.acc).toBe(true);
  });

  it('0xA0 4G location with a 4-byte LAC and 8-byte cell id', () => {
    const lbs = { mcc: 405, mnc: 874, lac: 0x00012345, cellId: 0x00000a1b2c3d4e5f };
    const msg = roundTrip(encodeGpsA0({ fix: fix({ speedKph: 61 }), lbs, acc: false, reupload: true }, 9));
    if (msg.type !== 'gps') throw new Error('expected gps');
    expect(msg.protocol).toBe(0xa0);
    expect(msg.lbs).toEqual(lbs);
    expect(msg.fix.speedKph).toBe(61);
    expect(msg.acc).toBe(false);
    expect(msg.reupload).toBe(true);
  });

  it('0x10 GPS-only and 0x12 without status', () => {
    const gpsOnly = roundTrip(encodeFrame(Gt06Protocol.GPS_ONLY, encodeGps22({ fix: fix(), lbs: { mcc: 404, mnc: 45, lac: 1, cellId: 2 }, acc: true }, 1).subarray(4, 4 + 18), 2));
    expect(gpsOnly).toMatchObject({ type: 'gps', lbs: null, acc: null });
  });
});

describe('heartbeats, alarms and info', () => {
  it('0x23 heartbeat carries external voltage and no battery level', () => {
    const msg = roundTrip(encodeHeartbeat23({ ignition: true, charging: false, oilCut: false, gsmSignal: 3 }, 12.47, 4));
    expect(msg).toMatchObject({ type: 'heartbeat', protocol: 0x23, extVoltage: 12.47, status: { ignition: true, voltageLevel: null, gsmSignal: 3 } });
  });

  it('0xA4 4G alarm', () => {
    const lbs = { mcc: 404, mnc: 45, lac: 0x00001234, cellId: 0x0000000000abcdef };
    const status = { ignition: false, charging: false, oilCut: false, voltageLevel: 5, gsmSignal: 4 };
    const msg = roundTrip(encodeAlarm({ fix: fix(), lbs, status, alarm: 0x02 }, 11, Gt06Protocol.ALARM_4G));
    if (msg.type !== 'alarm') throw new Error('expected alarm');
    expect(msg.lbs).toEqual(lbs);
    expect(msg.alarm).toBe(0x02);
    expect(msg.status).toEqual(status);
  });

  it('0x94 external voltage and ICCID', () => {
    expect(roundTrip(encodeInfoVoltage(24.6, 3))).toMatchObject({ type: 'info', infoType: 0x00, extVoltage: 24.6 });
    const iccid = Buffer.concat([Buffer.from([0x0a]), Buffer.from('0867440069681286', 'hex'), Buffer.from('0404450123456789', 'hex'), Buffer.from('89914500001234567890', 'hex')]);
    expect(roundTrip(encodeFrame(Gt06Protocol.INFO, iccid, 4))).toMatchObject({ type: 'info', infoType: 0x0a, iccid: '89914500001234567890' });
  });

  it('0x8A time request and the UTC reply', () => {
    expect(roundTrip(encodeFrame(Gt06Protocol.TIME_REQUEST, Buffer.alloc(0), 6))).toEqual({ type: 'timeRequest', protocol: 0x8a, serial: 6 });
    const reply = only(decodeFrames(encodeTimeResponse(6, new Date(Date.UTC(2026, 9, 18, 1, 2, 3)))).frames);
    expect(reply.subarray(4, 10)).toEqual(Buffer.from([26, 10, 18, 1, 2, 3]));
  });

  it('0x15 command response', () => {
    const text = Buffer.from('Cut off the fuel supply: Success!', 'latin1');
    const content = Buffer.concat([Buffer.from([4 + text.length]), Buffer.from('00000001', 'hex'), text, Buffer.from('0002', 'hex')]);
    expect(roundTrip(encodeFrame(Gt06Protocol.COMMAND_RESPONSE, content, 7))).toMatchObject({
      type: 'commandResponse',
      serverFlag: 1,
      text: 'Cut off the fuel supply: Success!',
    });
  });

  it('LBS/Wi-Fi-only packets are recognised without a position', () => {
    for (const p of [0x11, 0x17, 0x28, 0x2c, 0xa1]) expect(roundTrip(encodeFrame(p, Buffer.alloc(10), 1)).type).toBe('lbs');
  });

  it('0x80 server command frame', () => {
    const frame = only(decodeFrames(encodeCommand('RELAY,1#', 0x01020304, 12)).frames);
    expect(frame[3]).toBe(0x80);
    expect(frame.subarray(9, 17).toString('latin1')).toBe('RELAY,1#');
  });
});

describe('time zone word', () => {
  it('decodes +05:30 east, +08:00 and west zones', () => {
    expect(timeZoneMinutes(timeZoneWord(330))).toBe(330);
    expect(timeZoneMinutes(0x3200)).toBe(480);
    expect(timeZoneMinutes(timeZoneWord(-300))).toBe(-300);
    expect(timeZoneMinutes(null)).toBeNull();
    expect(timeZoneMinutes(0)).toBe(0);
  });
});

describe('frame guards', () => {
  it('a bogus 79 79 header with a huge length does not stall the following frames', () => {
    const good = encodeHeartbeat23({ ignition: true, charging: false, oilCut: false, gsmSignal: 3 }, 12, 1);
    const { frames } = decodeFrames(Buffer.concat([Buffer.from('7979ffff', 'hex'), good]));
    expect(frames).toHaveLength(1);
  });
});
