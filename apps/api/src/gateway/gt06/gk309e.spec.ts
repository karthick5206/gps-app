import { DecodeContext } from '../protocol';
import { decodeFrames, decodeMessage, requiresAck } from './codec';
import { Gt06Decoder } from './decoder';

/**
 * Concox GK309E (ID card / personal tracker), protocol V1.1. Example packets as printed in the vendor document.
 * 0x19 is the alarm packet when there is no GPS fix (SOS pressed indoors): it must still raise the alarm.
 */
const DOC = {
  login: '7878110103534190300996211006320100 01376c0d0a',
  gps10: '787819100e09030e0a26c5026c19960c38d120001400000100 1c10c60d0a',
  lbsSos19: '787812 1901cc002866000eee2005040001 0014500c0d0a',
  gpsPhone1a: '78782e1a0e090b100a0fc7026c19720c38d0a20014d12b383631333633323636383637370000000000000000010029 4da00d0a',
};
const hex = (s: string) => s.replace(/\s+/g, '');

const frame = (h: string) => {
  const { frames, dropped } = decodeFrames(Buffer.from(hex(h), 'hex'));
  expect(dropped).toBe(0);
  expect(frames).toHaveLength(1);
  return frames[0];
};

function session() {
  const decoder = new Gt06Decoder();
  const s = decoder.createSession();
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: new Date('2014-09-11T08:10:30Z'), remote: 'doc', unparsed: (r) => unparsed.push(r), warn: () => undefined };
  return { feed: (f: Buffer) => decoder.decode(f, s, ctx), s, unparsed };
}

describe('Concox GK309E ID card tracker (vendor document examples)', () => {
  it('login, 0x10, 0x19 and 0x1A examples pass CRC and decode', () => {
    for (const h of [DOC.login, DOC.gps10, DOC.lbsSos19, DOC.gpsPhone1a]) expect(() => decodeMessage(frame(h))).not.toThrow();
  });

  it('0x19 without a GPS fix: SOS from the terminal-information bits, cell and status, acknowledged', () => {
    const m = decodeMessage(frame(DOC.lbsSos19));
    expect(m).toMatchObject({ type: 'lbsAlarm', lbs: { mcc: 460, mnc: 0, lac: 0x2866, cellId: 0x000eee }, status: { voltageLevel: 5, gsmSignal: 4 }, alarm: 0x01 });
    expect(requiresAck(m)).toBe(true);
  });

  it('0x19 SOS becomes an alarm position at the last known fix', () => {
    const { feed, unparsed } = session();
    feed(frame(DOC.login));
    feed(frame(DOC.gps10));
    const r = feed(frame(DOC.lbsSos19));
    expect(r.replies).toHaveLength(1);
    expect(r.positions).toHaveLength(1);
    const p = r.positions[0];
    expect(p).toMatchObject({ uniqueId: '353419030099621', valid: false, attributes: { alarm: 'sos', noGpsFix: true, mcc: 460, cellId: 0x0eee } });
    expect(p.lat).toBeCloseTo(22.5767, 3);
    expect(unparsed).toEqual([]);
  });

  it('0x19 without an alarm only updates the status (no position)', () => {
    const { feed, s } = session();
    feed(frame(DOC.login));
    // Same packet with terminal info 0x00 (no alarm bits); CRC rebuilt by the codec's frame helper below.
    const content = Buffer.from(hex('01cc002866000eee 00 05 04 0001'), 'hex');
    const { encodeFrame } = jest.requireActual('./codec');
    const r = feed(encodeFrame(0x19, content, 21));
    expect(r.positions).toHaveLength(0);
    expect(s.status.batteryLevel).toBe(83);
  });

  it('0x1A GPS sent on request (phone number) is a normal position', () => {
    const { feed } = session();
    feed(frame(DOC.login));
    const r = feed(frame(DOC.gpsPhone1a));
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ valid: true, fixTime: '2014-09-11T08:10:15.000Z', speedKph: 0 });
    expect(r.positions[0].lat).toBeCloseTo(22.5767, 3);
  });

  it('0x18 LBS extension is accepted without a position', () => {
    const { feed, unparsed } = session();
    feed(frame(DOC.login));
    const { encodeFrame } = jest.requireActual('./codec');
    const r = feed(encodeFrame(0x18, Buffer.from(hex('0e090b100a0f 01cc00 2866 000ee3 60 2866 000eee 59'), 'hex'), 12));
    expect(r.positions).toHaveLength(0);
    expect(unparsed).toEqual([]);
  });
});
