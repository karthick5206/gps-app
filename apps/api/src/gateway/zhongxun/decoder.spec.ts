import { DecodeContext } from '../protocol';
import { splitZhongxun, zxCommand } from './codec';
import { ZhongxunDecoder } from './decoder';

/** Example packets from the vendor document "Zhongxun Locator Communication Protocol" V1.1–V1.3 (blue ID card). */
const h = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const DOC = {
  login: h('7878 0A 01 0123456789012345 01 0D0A'),
  gps: h('7878 12 10 0A03170F3217 9C 026B3F3E 0C22AD65 1F 3460 0D0A'),
  gpsOffline: h('7878 12 11 0A03170F3217 9C 026B3F3E 0C22AD65 1F 3460 0D0A'),
  status: h('7878 06 13 55 23 08 03 0D0A'),
  statusSignal: h('7878 07 13 55 23 08 03 64 0D0A'),
  statusUsb: h('7878 0A 13 424008196400041F 01 0D0A'),
  wifi: h('7878 03 69 160413031849 1475905BD30E25 001E10BBF7635D 14759006E62656 05 01CC00 28660F2132 28660F1F28 28660EA81E 2866107314 28660F2014 0D0A'),
  lbsOnly: h('7878 00 69 160413031849 05 01CC00 28660F2132 28660F1F28 28660EA81E 2866107314 28660F2014 0D0A'),
  offline17: h('7878 00 17 170622123031 07 01cc00 11aeaad432 11aeaad432 11aeaad432 11aeaad432 11aeaad432 11aeaad432 11aeaad432 0d0a'),
  wifi4g: h('7878 03 18 160413031849 1475905BD30E25 001E10BBF7635D 14759006E62656 04 01CC00 000028660090DF425F 000028660090DF576C 000028660094875667 00002866009CA15667 00 0D0A'),
  time: h('7878 01 30 0D0A'),
  sos: h('7878 01 99 0D0A'),
  heartbeat: h('7878 01 08 0D0A'),
  iccid: h('7878 15 B3 3132333435363738393031323334353637383930 0D0A'),
  lowBattery: h('7878 02 81 0D0A'),
  wearOff: h('7878 02 56 00 0D0A'),
};

function session(receivedAt = '2010-03-23T15:51:00Z') {
  const decoder = new ZhongxunDecoder();
  const s = decoder.createSession();
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: new Date(receivedAt), remote: 'doc', unparsed: (r) => unparsed.push(r), warn: () => undefined };
  const feed = (frame: Buffer) => decoder.decode(frame, s, ctx);
  return { decoder, s, feed, unparsed };
}

describe('Zhongxun blue ID card (vendor document examples)', () => {
  it('splits every example as exactly one frame', () => {
    for (const [name, frame] of Object.entries(DOC)) {
      const r = splitZhongxun(frame);
      expect({ name, frames: r.frames.length, rest: r.rest.length, dropped: r.dropped }).toEqual({ name, frames: 1, rest: 0, dropped: 0 });
    }
  });

  it('splits a stream by packet structure even when 0D 0A sits inside a date', () => {
    // GPS on 13 Nov at 10:xx: the date bytes contain 0D 0A, which must not end the frame.
    const gpsWithStop = h('7878 12 10 120B0D0A0505 9C 026B3F3E 0C22AD65 1F 3460 0D0A');
    const stream = Buffer.concat([DOC.login, gpsWithStop, DOC.status, DOC.wifi4g, DOC.sos.subarray(0, 3)]);
    const r = splitZhongxun(stream);
    expect(r.frames.map((f) => f[3])).toEqual([0x01, 0x10, 0x13, 0x18]);
    expect(r.frames[1]).toEqual(gpsWithStop);
    expect(r.rest).toEqual(DOC.sos.subarray(0, 3));
    expect(r.dropped).toBe(0);
  });

  it('login: IMEI from BCD, replies 7878 01 01 0D0A', () => {
    const { feed, s } = session();
    const r = feed(DOC.login);
    expect(s.uniqueId).toBe('123456789012345');
    expect(r.replies.map((b) => b.toString('hex'))).toEqual(['787801010d0a']);
  });

  it('GPS 0x10: position (UTC, 1/30000 minute coordinates, course 96) and the dated reply', () => {
    const { feed } = session();
    feed(DOC.login);
    const r = feed(DOC.gps);
    expect(r.replies[0].toString('hex')).toBe('787800100a03170f32170d0a');
    expect(r.positions).toHaveLength(1);
    const p = r.positions[0];
    expect(p).toMatchObject({ protocol: 'zhongxun', uniqueId: '123456789012345', fixTime: '2010-03-23T15:50:23.000Z', speedKph: 31, course: 96, satellites: 12, valid: true });
    expect(p.lat).toBeCloseTo(22.546097, 5);
    expect(p.lng).toBeCloseTo(113.110669, 5);
  });

  it('GPS 0x11 is stored history (reupload) and is answered too', () => {
    const { feed } = session();
    feed(DOC.login);
    const r = feed(DOC.gpsOffline);
    expect(r.replies[0].toString('hex')).toBe('787800110a03170f32170d0a');
    expect(r.positions[0].attributes).toMatchObject({ reupload: true });
  });

  it('V1.2 GPS with altitude and alarm byte', () => {
    const { feed } = session();
    feed(DOC.login);
    const r = feed(h('7878 15 10 0A03170F3217 9C 026B3F3E 0C22AD65 1F 3460 0064 02 0D0A'));
    expect(r.positions[0]).toMatchObject({ altitude: 100, attributes: { alarm: 'overspeed' } });
  });

  it('status 0x13: battery, signal; echoed back; battery added to following fixes', () => {
    const { feed, s } = session();
    feed(DOC.login);
    expect(feed(DOC.status).replies[0]).toEqual(DOC.status);
    expect(s.batteryLevel).toBe(85);
    expect(s.timeZoneHours).toBe(8);
    feed(DOC.statusSignal);
    expect(s.gsmSignal).toBe(4);
    expect(feed(DOC.gps).positions[0].attributes).toMatchObject({ batteryLevel: 85, gsmSignal: 4 });
    // After a fix, a status packet also refreshes the live state (event at the last fix).
    expect(feed(DOC.statusUsb).positions).toHaveLength(1);
  });

  it('Wi-Fi / cell packets are answered with their date and give no position (no alarm)', () => {
    const { feed, unparsed } = session();
    feed(DOC.login);
    for (const [frame, reply] of [
      [DOC.wifi, '787800691604130318490d0a'],
      [DOC.lbsOnly, '787800691604130318490d0a'],
      [DOC.offline17, '787800171706221230310d0a'],
      [DOC.wifi4g, '787800181604130318490d0a'],
    ] as const) {
      const r = feed(frame);
      expect(r.replies[0].toString('hex')).toBe(reply);
      expect(r.positions).toHaveLength(0);
    }
    expect(unparsed).toEqual([]);
  });

  it('a Wi-Fi packet with the V1.2 alarm byte raises the alarm at the last fix', () => {
    const { feed } = session();
    feed(DOC.login);
    feed(DOC.gps);
    const r = feed(h('7878 00 69 160413031849 02 01CC00 28660F2132 28660F1F28 10 0D0A'));
    expect(r.positions[0]).toMatchObject({ valid: false, attributes: { alarm: 'lowBattery', noGpsFix: true, mcc: 460, lac: 0x2866, cellId: 0x0f21 } });
  });

  it('SOS, low battery, card removed and ICCID become alarms / events', () => {
    const { feed } = session();
    feed(DOC.login);
    feed(DOC.gps);
    expect(feed(DOC.sos).positions[0].attributes).toMatchObject({ alarm: 'sos' });
    expect(feed(DOC.lowBattery).positions[0].attributes).toMatchObject({ alarm: 'lowBattery' });
    expect(feed(DOC.wearOff).positions[0].attributes).toMatchObject({ alarm: 'tamper', event: 'removed' });
    expect(feed(DOC.iccid).positions[0].attributes).toMatchObject({ iccid: '12345678901234567890', event: 'sim' });
    expect(feed(DOC.heartbeat).positions).toHaveLength(0);
  });

  it('time request 0x30 is answered with UTC time (year as 2 bytes)', () => {
    const { feed } = session('2016-07-05T05:55:24Z');
    expect(feed(DOC.time).replies[0].toString('hex')).toBe('7878073007e00705053718' + '0d0a');
  });

  it('commands: locate, restart, interval, raw hex', () => {
    expect(zxCommand('LOCATE')?.toString('hex')).toBe('787801800d0a');
    expect(zxCommand('restart')?.toString('hex')).toBe('78780248010d0a');
    expect(zxCommand('INTERVAL,80')?.toString('hex')).toBe('7878039700500d0a');
    expect(zxCommand('INTERVAL,5')).toBeNull();
    expect(zxCommand('#7878024901 0d0a'.replace(' ', ''))?.toString('hex')).toBe('78780249010d0a');
    expect(zxCommand('WHERE')).toBeNull();
  });
});

describe('Zhongxun SOS without GPS (v1.30.1)', () => {
  it('SOS asks the card to locate now and is marked as having no own fix', () => {
    const { feed } = session();
    feed(DOC.login);
    feed(DOC.gps);
    const r = feed(DOC.sos);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].attributes).toMatchObject({ alarm: 'sos', noGpsFix: true });
    expect(r.positions[0].valid).toBe(false);
    expect(r.replies.map((b) => b.toString('hex'))).toContain('7878018' + '00d0a');
  });

  it('a reconnect keeps the last fix: SOS on a new connection is at the last position, not 0,0', () => {
    const first = session();
    first.feed(DOC.login);
    const fix = first.feed(DOC.gps).positions[0];
    const second = session('2010-03-23T16:30:00Z'); // new TCP connection, no GPS yet
    second.feed(DOC.login);
    const sos = second.feed(DOC.sos).positions[0];
    expect([sos.lat, sos.lng]).toEqual([fix.lat, fix.lng]);
    expect(sos.attributes).toMatchObject({ alarm: 'sos' });
  });

  it("the card's call-SOS request (0x41 01) also raises SOS", () => {
    const { feed } = session();
    feed(DOC.login);
    const r = feed(h('7878 02 41 01 0D0A'));
    expect(r.positions[0].attributes).toMatchObject({ alarm: 'sos', event: 'callSos' });
    expect(r.replies.map((b) => b.toString('hex'))).toContain('787801800d0a');
  });

  it('events without GPS in one TCP chunk get distinct times, so no history row is lost', () => {
    const { feed } = session();
    feed(DOC.login);
    feed(DOC.gps);
    const a = feed(DOC.statusSignal).positions[0];
    const b = feed(DOC.sos).positions[0];
    expect(a.fixTime).not.toBe(b.fixTime);
    expect(Date.parse(b.fixTime)).toBeGreaterThan(Date.parse(a.fixTime));
  });

  it('fast fix time text equals the Date-based ISO, and odd dates still fall back safely', () => {
    const { feed } = session();
    feed(DOC.login);
    const p = feed(DOC.gps).positions[0];
    expect(p.fixTime).toBe(new Date(Date.UTC(2010, 2, 23, 15, 50, 23)).toISOString());
    // Day 0 / month 13 from a confused firmware: no crash, a valid ISO string.
    const odd = feed(h('7878 12 10 0A0D00172317 9C 026B3F3E 0C22AD65 1F 3460 0D0A')).positions[0];
    expect(Number.isNaN(Date.parse(odd.fixTime))).toBe(false);
  });
});
