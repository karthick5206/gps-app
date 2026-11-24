import { DecodeContext } from '../protocol';
import { decodeFrames, decodeMessage, encodeFrame, Gt06Protocol } from './codec';
import { dvrAlarmAttributes, Gt06Decoder } from './decoder';

/**
 * Jimi 4G dashcams (JC400 / JC261), protocol V1.2.8. The hex strings are the example packets printed in the vendor
 * document (all pass CRC-ITU), so they check our layouts against the vendor's own encoder.
 */
const CLIP_A = 'EVENT_353376110008882_00000000_2020_08_11_14_17_36_24.mp4';
const CLIP_B = 'EVENT_353376110008882_00000000_2020_08_11_14_17_36_23.mp4';
const hexOf = (s: string) => Buffer.from(s, 'latin1').toString('hex');
const DOC = {
  login: '78781101075253367890024270003201000512790d0a',
  alarm95: `78789395ffff0114080b061124df026c19580c38d1db14f30000008e010000${hexOf(`${CLIP_A},${CLIP_B}`)}000adbdc0d0a`,
  location37: '78782637150607000906cf026c28b50c38b9bb23148901cc01254e0615f8011b000000ea95223f73c50d0a',
  temperature9b: '7979000d9b033c030100fac40d000824810d0a',
  fuel94: '7979000b940e0001000102000a244d0d0a',
};

const frame = (hex: string) => {
  const { frames, dropped } = decodeFrames(Buffer.from(hex, 'hex'));
  expect(dropped).toBe(0);
  expect(frames).toHaveLength(1);
  return frames[0];
};

function session() {
  const decoder = new Gt06Decoder();
  const s = decoder.createSession();
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: new Date('2020-08-11T06:18:00Z'), remote: 'doc', unparsed: (r) => unparsed.push(r), warn: () => undefined };
  return { feed: (f: Buffer) => decoder.decode(f, s, ctx), s, unparsed };
}

/** A 0x95 alarm frame for `type` with the document's fix and no clip names. */
function alarmFrame(type: number, value = 0): Buffer {
  const head = Buffer.from('ffff0114080b061124df026c19580c38d1db14f30000008e', 'hex');
  const tail = Buffer.alloc(3);
  tail[0] = type;
  tail.writeUInt16BE(value, 1);
  return encodeFrame(Gt06Protocol.DVR_ALARM, Buffer.concat([head, tail]), 7);
}

describe('Jimi JC400 / JC261 dashcam (vendor document examples)', () => {
  it('every example passes CRC and decodes', () => {
    for (const hex of Object.values(DOC)) expect(() => decodeMessage(frame(hex))).not.toThrow();
  });

  it('0x95 alarm: fix, supply voltage, alarm type and uploaded clip names', () => {
    const m = decodeMessage(frame(DOC.alarm95));
    expect(m).toMatchObject({
      type: 'dvrAlarm',
      serial: 10,
      extVoltage: 14.2,
      alarm: 0x01,
      alarmValue: 0,
      files: [CLIP_A, CLIP_B],
      fix: { time: new Date('2020-08-11T06:17:36Z'), satellites: 15, speedKph: 0, course: 243, positioned: true },
    });
    if (m.type !== 'dvrAlarm') throw new Error('type');
    expect(m.fix.lat).toBeCloseTo(22.577116, 5);
    expect(m.fix.lng).toBeCloseTo(113.916851, 5);
  });

  it('0x95 alarm becomes a position with the alarm and clips, and is acknowledged', () => {
    const { feed, s } = session();
    feed(frame(DOC.login));
    const r = feed(frame(DOC.alarm95));
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0].toString('hex').slice(0, 8)).toBe('78780595');
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ uniqueId: '752533678900242', valid: true, attributes: { alarm: 'sos', dvrAlarm: '0x01', mediaFiles: `${CLIP_A},${CLIP_B}`, extVoltage: 14.2 } });
    expect(s.status.extVoltage).toBe(14.2);
  });

  it('maps ADAS, DMS, seat belt, door and harsh events to the shared attribute names', () => {
    const { feed } = session();
    feed(frame(DOC.login));
    const attrs = (type: number, value = 0) => feed(alarmFrame(type, value)).positions[0].attributes;
    expect(attrs(0xcc)).toMatchObject({ adas: 'fcw', event: 'fcw' });
    expect(attrs(0xcd)).toMatchObject({ adas: 'ldw' });
    expect(attrs(0xce)).toMatchObject({ adas: 'hmw' });
    expect(attrs(0x8c)).toMatchObject({ dms: 'fatigue' });
    expect(attrs(0x97)).toMatchObject({ dms: 'phone' });
    expect(attrs(0x94)).toMatchObject({ dms: 'driverAbsent' });
    expect(attrs(0xa1)).toMatchObject({ dms: 'cameraBlocked' });
    expect(attrs(0xa7)).toMatchObject({ seatbelt: false, dms: 'seatbelt', event: 'seatbeltOff' });
    expect(attrs(0x51)).toMatchObject({ door: true });
    expect(attrs(0x91)).toMatchObject({ alarm: 'harshBraking' });
    expect(attrs(0x87, 92)).toMatchObject({ alarm: 'overspeed', overspeedKph: 92 });
    expect(attrs(0x8b)).toMatchObject({ oilCut: true, event: 'relayCut' });
    expect(attrs(0x86)).toMatchObject({ videoAlarm: 'storageFault' });
    expect(attrs(0x3f)).toMatchObject({ alarm: 'alarm_63' });
  });

  it('every documented alarm type has a mapping', () => {
    const documented = [
      0x80, 0x86, 0x88, 0x87, 0x90, 0x91, 0x92, 0x93, 0x01, 0x8a, 0x8b, 0x47, 0x69, 0x70, 0x53, 0x73, 0x76, 0x0e, 0xa5, 0x8c, 0x8f, 0xa0, 0x9a, 0x97, 0x94,
      0xa1, 0xa2, 0xa3, 0xa4, 0xa6, 0xa7, 0x50, 0x51, 0xcc, 0xcd, 0xce,
    ];
    for (const code of documented) expect(String(dvrAlarmAttributes(code, 0, []).alarm ?? '')).not.toMatch(/^alarm_/);
  });

  it('0x37 extended location decodes like 0x22 (DVR event upload mode, mileage)', () => {
    const m = decodeMessage(frame(DOC.location37));
    expect(m).toMatchObject({ type: 'gps', protocol: 0x37, uploadMode: 0x1b, reupload: false, acc: true, mileage: 60053, lbs: { mcc: 460, mnc: 1 }, fix: { speedKph: 35, course: 137 } });
  });

  it('0x9B temperature sensor and 0x94 fuel sensor are merged into following positions', () => {
    const { feed, s, unparsed } = session();
    feed(frame(DOC.login));
    expect(decodeMessage(frame(DOC.temperature9b))).toMatchObject({ type: 'module', moduleType: 0x03, temperature: 25 });
    feed(frame(DOC.temperature9b));
    feed(frame(DOC.fuel94));
    expect(s.sensors).toMatchObject({ temp1: 25, fuelLevelPct: 0.01 });
    expect(unparsed).toEqual([]);
  });

  it('0x9B driver card login sets the driver; logout is an event only', () => {
    const { feed } = session();
    feed(frame(DOC.login));
    const card = (status: number) =>
      encodeFrame(Gt06Protocol.EXT_MODULE, Buffer.concat([Buffer.from([0x05, 20, 8, 11, 6, 17, 36, status]), Buffer.from('%DRIVER^KUMAR?;600764310050015789=150619800909=?')]), 9);
    expect(feed(card(1)).positions[0].attributes).toMatchObject({ event: 'rfid', driverId: '%DRIVER^KUMAR?;600764310050015789=150619800909=?' });
    const out = feed(card(0)).positions[0].attributes;
    expect(out).toMatchObject({ event: 'driverCardLogout' });
    expect(out.driverId).toBeUndefined();
  });
});
