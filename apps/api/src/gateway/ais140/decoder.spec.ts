import { DecodeContext } from '../protocol';
import { coordinate, splitAis140, utcTime, xorChecksum } from './codec';
import { Ais140Decoder } from './decoder';

// Packets built from the public AIS-140 field table; replace / extend with real TS101 captures when available.
const NOW = new Date('2026-10-19T06:30:20Z');
const IMEI = '868728039301806';

const withXor = (body: string) => `$${body}*${xorChecksum(body)}\r\n`;

function nr(opts: { type?: string; alert?: string; flag?: 'L' | 'H'; lat?: string; ns?: string; lng?: string; ew?: string; emergency?: string; tamper?: string; date?: string; time?: string } = {}) {
  return [
    'NRM', 'iTriangle', '1_37T02B0164MAIS_6', opts.type ?? 'NR', opts.alert ?? '01', opts.flag ?? 'L', IMEI, 'TN01AB1234',
    '1', opts.date ?? '19102026', opts.time ?? '063015', opts.lat ?? '13.082700', opts.ns ?? 'N', opts.lng ?? '80.270700', opts.ew ?? 'E',
    '42.5', '271.0', '15', '12.0', '0.8', '0.5', 'AirTel', '1', '1', '12.6', '4.1', opts.emergency ?? '0', opts.tamper ?? 'C', '26',
    '404', '45', '1A2B', '00C3D4',
    // 4 neighbour cells: cellId, lac, signal
    '5BF1', '1A2B', '25', '1E7D', '1A2B', '23', '64A1', '1A2B', '21', '63F5', '1A2B', '20',
    '1000', '01', '000146', '',
  ].join(',');
}

function harness() {
  const decoder = new Ais140Decoder();
  const session = decoder.createSession();
  const unparsed: string[] = [];
  const ctx: DecodeContext = { receivedAt: NOW, remote: 'test', unparsed: (reason) => unparsed.push(reason), warn: () => undefined };
  const feed = (wire: string) => decoder.split(Buffer.from(wire, 'latin1')).frames.map((f) => decoder.decode(f, session, ctx));
  return { decoder, session, feed, unparsed };
}

describe('AIS-140 codec', () => {
  it('splits packets with and without checksums, keeping a partial tail', () => {
    const a = withXor(nr());
    const b = `$${nr()}*`;
    const r = splitAis140(Buffer.from(`junk${a}${b}$NRM,par`, 'latin1'));
    expect(r.frames.map((f) => f.toString('latin1'))).toEqual([a.trim(), b]);
    expect(r.rest.toString('latin1')).toBe('$NRM,par');
    expect(r.dropped).toBe(1);
  });

  it('waits for checksum digits after a trailing * until flushed', () => {
    const r = splitAis140(Buffer.from('$A,B*', 'latin1'));
    expect(r.frames).toHaveLength(0);
    expect(splitAis140(r.rest, undefined, true).frames).toHaveLength(1);
  });

  it('applies N/S/E/W signs and converts NMEA ddmm.mmmm', () => {
    expect(coordinate('13.0827', 'S', true)).toBe(-13.0827);
    expect(coordinate('80.2707', 'W', false)).toBe(-80.2707);
    expect(coordinate('1304.9620', 'N', true)).toBeCloseTo(13.0827, 4);
  });

  it('reads ddmmyyyy hhmmss as UTC', () => {
    expect(utcTime('19102026', '063015').toISOString()).toBe('2026-10-19T06:30:15.000Z');
    expect(utcTime('191026', '063015').toISOString()).toBe('2026-10-19T06:30:15.000Z');
  });
});

describe('Ais140Decoder', () => {
  it('identifies the device from a login packet without replying', () => {
    const { feed, session } = harness();
    const [r] = feed(withXor(`LGN,TN01AB1234,${IMEI},1_37T02B0164MAIS_6,AIS140,13.082700,N,80.270700,E`));
    expect(session.uniqueId).toBe(IMEI);
    expect(session.vehicleRegNo).toBe('TN01AB1234');
    expect(r.positions).toHaveLength(0);
    expect(r.replies).toHaveLength(0);
  });

  it('decodes a live NR packet', () => {
    const { feed } = harness();
    const [r] = feed(withXor(nr()));
    expect(r.positions).toHaveLength(1);
    const p = r.positions[0];
    expect(p).toMatchObject({ protocol: 'ais140', uniqueId: IMEI, fixTime: '2026-10-19T06:30:15.000Z', lat: 13.0827, lng: 80.2707, speedKph: 42.5, course: 271, satellites: 15, altitude: 12, valid: true, ignition: true });
    expect(p.attributes).toMatchObject({ hdop: 0.5, pdop: 0.8, gsmSignal: 3, extVoltage: 12.6, batteryVoltage: 4.1, mcc: 404, mnc: 45, lac: 0x1a2b, cellId: 0xc3d4, digitalInputs: '1000', digitalOutputs: '01', frameNo: 146 });
    expect(p.attributes.alarm).toBeUndefined();
    expect(p.attributes.reupload).toBeUndefined();
  });

  it('marks history (H) packets as reupload and applies S/W hemispheres', () => {
    const { feed } = harness();
    const [r] = feed(withXor(nr({ flag: 'H', alert: '02', ns: 'S', ew: 'W' })));
    expect(r.positions[0]).toMatchObject({ lat: -13.0827, lng: -80.2707 });
    expect(r.positions[0].attributes.reupload).toBe(true);
  });

  it('maps alert packets to normalised alarms (type code and alert id)', () => {
    const { feed } = harness();
    const cases: [string, string, string][] = [
      ['EA', '10', 'sos'], ['TA', '09', 'tamper'], ['BD', '03', 'powerCut'], ['BL', '04', 'lowBattery'],
      ['HB', '13', 'harshBraking'], ['HA', '14', 'harshAcceleration'], ['RT', '15', 'harshCornering'], ['NR', '10', 'sos'],
    ];
    for (const [type, alert, alarm] of cases) {
      const [r] = feed(withXor(nr({ type, alert, emergency: alarm === 'sos' ? '1' : '0' })));
      expect(r.positions[0].attributes.alarm).toBe(alarm);
    }
    const [ign] = feed(withXor(nr({ type: 'IN', alert: '07' })));
    expect(ign.positions[0].attributes).toMatchObject({ event: 'ignitionOn' });
    expect(ign.positions[0].attributes.alarm).toBeUndefined();
  });

  it('decodes an emergency ($EPB,EMR) message as an SOS', () => {
    const { feed } = harness();
    const [r] = feed(withXor(`EPB,EMR,${IMEI},NM,19102026063015,A,13.082700,N,80.270700,E,12.0,40.0,0.0,G,TN01AB1234,+919999900000`));
    expect(r.positions[0]).toMatchObject({ uniqueId: IMEI, fixTime: '2026-10-19T06:30:15.000Z', lat: 13.0827, valid: true, speedKph: 40 });
    expect(r.positions[0].attributes).toMatchObject({ alarm: 'sos', emergency: true });
  });

  it('keeps the health packet battery level for later positions', () => {
    const { feed, session } = harness();
    const [h] = feed(withXor(`HMP,iTriangle,1_37T02B0164MAIS_6,${IMEI},87,20,35,10,60,1000,0.0`));
    expect(h.positions).toHaveLength(0);
    expect(session.batteryLevel).toBe(87);
    const [r] = feed(withXor(nr()));
    expect(r.positions[0].attributes.batteryLevel).toBe(87);
  });

  it('logs malformed, unknown and bad-checksum packets as unparsed without throwing', () => {
    const { feed, unparsed } = harness();
    const good = nr();
    const wrong = (parseInt(xorChecksum(good), 16) ^ 0xff).toString(16).toUpperCase().padStart(2, '0');
    const results = feed(`$${good}*${wrong}\r\n$FOO,bar,baz*\r\n$${nr({ date: '99999999' })}*\r\n`);
    expect(results.every((r) => r.positions.length === 0)).toBe(true);
    expect(unparsed).toHaveLength(3);
    expect(unparsed[0]).toMatch(/checksum/);
    expect(unparsed[1]).toMatch(/unknown packet/);
  });

  it('accepts a packet without the vehicle registration field', () => {
    const { feed } = harness();
    const body = nr().replace(`${IMEI},TN01AB1234,`, `${IMEI},`);
    const [r] = feed(withXor(body));
    expect(r.positions[0]).toMatchObject({ lat: 13.0827, fixTime: '2026-10-19T06:30:15.000Z' });
  });

  it('sends custom commands as text lines', () => {
    const { decoder, session } = harness();
    expect(decoder.encodeCommand('GET LOC').toString()).toBe('GET LOC\r\n');
    expect(session.uniqueId).toBeNull();
  });
});
