import { DecodeContext } from '../protocol';
import { cardExtras, encodeMessage, Jt808Msg, split808, timeResponse } from './codec';
import { Jt808Decoder } from './decoder';

/** 4G ID cards on JT/T 808-2011 with vendor extras (document "4G ID CARD Communicate protocol"). */
const HDR = { terminalBcd: Buffer.from('013912345678', 'hex'), version2019: false, protocolVersion: null };
const bcd = (s: string) => Buffer.from(s, 'hex');

/** Location body: alarm(4) status(4) lat lng(4+4) altitude(2) speed(2) course(2) time(BCD 6) + extras. */
function location(extras: Buffer[] = [], alarm = 0): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt32BE(alarm, 0);
  b.writeUInt32BE(0b10, 4); // positioned
  b.writeUInt32BE(13_082_700, 8);
  b.writeUInt32BE(80_270_700, 12);
  b.writeUInt16BE(12, 16);
  b.writeUInt16BE(0, 18);
  b.writeUInt16BE(90, 20);
  bcd('261124103000').copy(b, 22);
  return Buffer.concat([b, ...extras]);
}
const extra = (id: number, v: Buffer) => Buffer.concat([Buffer.from([id, v.length]), v]);

function session() {
  const decoder = new Jt808Decoder({ attachServer: null });
  const s = decoder.createSession();
  const ctx: DecodeContext = { receivedAt: new Date('2026-11-24T10:30:05Z'), remote: 'test', unparsed: () => undefined, warn: () => undefined };
  let serial = 0;
  const feed = (msgId: number, body: Buffer) => {
    const frame = split808(encodeMessage(msgId, HDR, ++serial, body)).frames[0];
    return decoder.decode(frame, s, ctx);
  };
  return { feed, s };
}

describe('4G ID card on JT/T 808-2011', () => {
  it('reads battery (0x62), temperature (2-byte 0x64) and low battery (0x57) without touching ADAS', () => {
    const extras = new Map<number, Buffer>([
      [0x62, Buffer.from([57])],
      [0x64, Buffer.from([0x01, 0x77])],
      [0x57, Buffer.from([0x00, 0x10, 0, 0, 0, 0, 0, 0])],
    ]);
    expect(cardExtras(extras)).toEqual({ batteryLevel: 57, temperature: 37.5, lowBattery: true });
    expect(cardExtras(new Map([[0x64, Buffer.alloc(47)]])).temperature).toBeNull();
  });

  it('location with card extras → battery, temperature, low battery alarm; heartbeat battery as fallback', () => {
    const { feed, s } = session();
    feed(Jt808Msg.AUTH, Buffer.from('auth'));
    const withExtras = feed(Jt808Msg.LOCATION, location([extra(0x62, Buffer.from([57])), extra(0x64, Buffer.from([0x01, 0x77])), extra(0x57, Buffer.from([0x00, 0x10, 0, 0, 0, 0, 0, 0]))]));
    expect(withExtras.positions[0].attributes).toMatchObject({ batteryLevel: 57, temp1: 37.5, alarm: 'lowBattery' });

    feed(Jt808Msg.HEARTBEAT, Buffer.from([42, 0x01]));
    expect(s.batteryLevel).toBe(42);
    expect(feed(Jt808Msg.LOCATION, location()).positions[0].attributes).toMatchObject({ batteryLevel: 42 });
  });

  it('SOS (alarm bit 0) is still the emergency alarm', () => {
    const { feed } = session();
    feed(Jt808Msg.AUTH, Buffer.from('auth'));
    expect(feed(Jt808Msg.LOCATION, location([], 0x01)).positions[0].attributes).toMatchObject({ alarm: 'sos' });
  });

  it('answers the time request (0x0121) with 0x8121 UTC time and stores the ICCID (0x0120)', () => {
    const { feed, s } = session();
    feed(Jt808Msg.AUTH, Buffer.from('auth'));
    const r = feed(Jt808Msg.TIME_REQUEST, Buffer.alloc(0));
    expect(r.replies[0]).toEqual(timeResponse(HDR, s.serial, new Date('2026-11-24T10:30:05Z')));
    const body = split808(r.replies[0]).frames[0];
    expect(body.readUInt16BE(body[0] === 0x7e ? 1 : 0)).toBe(0x8121);
    feed(Jt808Msg.ICCID, Buffer.from('89914509876543210123', 'ascii'));
    expect(s.iccid).toBe('89914509876543210123');
  });
});
