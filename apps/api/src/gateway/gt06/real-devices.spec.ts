import { DecodeContext } from '../protocol';
import { decodeFrames, decodeMessage, frameProtocol } from './codec';
import { Gt06Decoder } from './decoder';

/**
 * Frames captured from customer devices on the test server (GATEWAY_CAPTURE, 18 Oct 2026). Unlike the round-trip
 * tests these come from real firmware, so they catch layout assumptions our own encoders share with the decoder.
 */
const V5 = {
  imei: '359647091912738',
  login: '78781101035964709191273850040001000261d70d0a',
  timeRequest: '7878058a0003df840d0a',
  heartbeat: '78780a13040604000200053cf60d0a',
  iccid: '79790020940a03596470919127380404943400563577899194260340056357760004191b0d0a',
  gps: '787822221a0a12083435c9016447ce089a5ce00044630194281b7300533f000e00000667a80d0a',
};
const CONCOX_867 = {
  imei: '867440069681286',
  login: '787811010867440069681286806621210006d3fb0d0a',
  heartbeat: '78780a13040604000200071fe40d0a',
  voltage: '79790008940004b50008477a0d0a',
  gpsReupload: '787826221a0a12081630c9016469e208991d5000151b019428372700672300080100c0ea6e000a15c30d0a',
};

const frame = (hex: string) => {
  const { frames, dropped } = decodeFrames(Buffer.from(hex, 'hex'));
  expect(dropped).toBe(0);
  expect(frames).toHaveLength(1);
  return frames[0];
};

function session(receivedAt: string) {
  const decoder = new Gt06Decoder();
  const s = decoder.createSession();
  const warnings: string[] = [];
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: new Date(receivedAt), remote: 'real', unparsed: (r) => unparsed.push(r), warn: (_k, m) => warnings.push(m) };
  return { feed: (hex: string) => decoder.decode(frame(hex), s, ctx), s, warnings, unparsed };
}

describe('Concox V5 (real frames)', () => {
  it('every captured frame passes CRC and decodes', () => {
    for (const hex of Object.values(V5).slice(1)) expect(() => decodeMessage(frame(hex))).not.toThrow();
  });

  it('login without a time zone, ICCID from 0x94, ACC from the course word', () => {
    const { feed, s, unparsed } = session('2026-10-18T08:52:54.473Z');
    expect(feed(V5.login).replies.map(frameProtocol)).toEqual([0x01]);
    expect(s).toMatchObject({ uniqueId: V5.imei, timeZoneMinutes: 0, clock: 'utc' });
    expect(feed(V5.timeRequest).replies.map(frameProtocol)).toEqual([0x8a]);
    expect(feed(V5.heartbeat).replies.map(frameProtocol)).toEqual([0x13]);
    feed(V5.iccid);
    expect(s.iccid).toBe('89919426034005635776');
    const p = feed(V5.gps).positions[0];
    expect(p).toMatchObject({ fixTime: '2026-10-18T08:52:53.000Z', satellites: 9, valid: false, ignition: false, course: 99 });
    expect(p.lat).toBeCloseTo(12.97178, 4);
    expect(p.lng).toBeCloseTo(80.18558, 4);
    expect(p.attributes).toMatchObject({ batteryLevel: 100, gsmSignal: 4, charging: true, mcc: 404, mnc: 40, lac: 7027, cellId: 21311 });
    expect(unparsed).toEqual([]);
  });
});

describe('Concox 867440069681286 (real frames)', () => {
  it('reports +05:30 at login while its clock is UTC; voltage from 0x94; history re-upload kept', () => {
    const { feed, s, warnings } = session('2026-10-18T08:52:52.093Z');
    feed(CONCOX_867.login);
    expect(s.timeZoneMinutes).toBe(330);
    feed(CONCOX_867.heartbeat);
    feed(CONCOX_867.voltage);
    expect(s.status.extVoltage).toBe(12.05);
    // A re-uploaded (history) fix 30 min old is not in the future, so it is taken as UTC (correct for this unit)
    // without deciding the clock; the next live fix decides.
    const p = feed(CONCOX_867.gpsReupload).positions[0];
    expect(p.fixTime).toBe('2026-10-18T08:22:48.000Z');
    expect(p.attributes).toMatchObject({ reupload: true, extVoltage: 12.05, mileage: 12642926 });
    expect(p.valid).toBe(true);
    expect(s.clock).toBeNull();
    expect(warnings).toEqual([]);
  });
});
