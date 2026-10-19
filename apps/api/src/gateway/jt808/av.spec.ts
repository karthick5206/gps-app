import { DecodeContext } from '../protocol';
import {
  bcdTime,
  encodeLiveControl,
  encodeLiveRequest,
  encodePlaybackControl,
  encodePlaybackRequest,
  encodeResourceQuery,
  parseAvAttributes,
  parseBcd,
  parseResourceList,
} from './av';
import { decodeMessage, encodeMessage, split808 } from './codec';
import { Jt808Decoder } from './decoder';

const T2013 = { terminalBcd: Buffer.from('013912345678', 'hex'), version2019: false, protocolVersion: null };
const IST = 330;
const at = (iso: string) => new Date(iso);

function resourceItem(channel: number, start: string, end: string, size: number): Buffer {
  const b = Buffer.alloc(28);
  b[0] = channel;
  Buffer.from(start, 'hex').copy(b, 1);
  Buffer.from(end, 'hex').copy(b, 7);
  b[20] = 0x01; // alarm flag bit 0
  b[21] = 2; // video
  b[22] = 2; // sub stream
  b[23] = 1; // main storage
  b.writeUInt32BE(size, 24);
  return b;
}

describe('JT/T 1078 signalling', () => {
  it('converts BCD times with the device clock zone', () => {
    // 05:00 UTC = 10:30 IST.
    expect(bcdTime(at('2026-10-19T05:00:00Z'), IST).toString('hex')).toBe('261019103000');
    expect(parseBcd(Buffer.from('261019103000', 'hex'), IST)?.toISOString()).toBe('2026-10-19T05:00:00.000Z');
    expect(bcdTime(null, IST).toString('hex')).toBe('000000000000');
    expect(parseBcd(Buffer.alloc(6), IST)).toBeNull();
  });

  it('0x9101 live request layout', () => {
    const b = encodeLiveRequest({ host: '1.2.3.4', tcpPort: 7612, channel: 2, stream: 'sub' });
    // len 7, "1.2.3.4", TCP 7612 (0x1dbc), UDP 0, channel 2, data type 1 (video), stream 1 (sub)
    expect(b.toString('hex')).toBe('07' + Buffer.from('1.2.3.4').toString('hex') + '1dbc' + '0000' + '02' + '01' + '01');
    expect(encodeLiveRequest({ host: 'a', tcpPort: 1, channel: 1, stream: 'main', dataType: 0 }).toString('hex')).toBe('0161000100000100' + '00');
  });

  it('0x9102 / 0x9202 control layouts', () => {
    expect(encodeLiveControl(3, 0).toString('hex')).toBe('03000001');
    expect(encodeLiveControl(1, 1, 0, 'main').toString('hex')).toBe('01010000');
    expect(encodePlaybackControl(1, 2).toString('hex')).toBe('010200000000000000');
    expect(encodePlaybackControl(1, 5, 0, at('2026-10-19T05:00:00Z'), IST).toString('hex')).toBe('010500261019103000');
  });

  it('0x9205 resource query layout', () => {
    const b = encodeResourceQuery({ channel: 1, start: at('2026-10-19T04:58:00Z'), end: at('2026-10-19T05:02:00Z'), zone: IST });
    expect(b.length).toBe(1 + 6 + 6 + 8 + 3);
    expect(b.toString('hex')).toBe('01' + '261019102800' + '261019103200' + '0000000000000000' + '03' + '00' + '00');
  });

  it('0x9201 playback request layout', () => {
    const b = encodePlaybackRequest({ host: '1.2.3.4', tcpPort: 7612, channel: 1, start: at('2026-10-19T04:58:00Z'), end: at('2026-10-19T05:02:00Z'), zone: IST });
    expect(b.toString('hex')).toBe(
      '07' + Buffer.from('1.2.3.4').toString('hex') + '1dbc0000' + '01' + '02' + '00' + '00' + '00' + '00' + '261019102800' + '261019103200',
    );
  });

  it('parses 0x1205 resource lists and 0x1003 attributes', () => {
    const head = Buffer.from([0x00, 0x2a, 0, 0, 0, 2]);
    const body = Buffer.concat([head, resourceItem(1, '261019102800', '261019103000', 1_048_576), resourceItem(2, '261019103000', '261019103200', 2048)]);
    const r = parseResourceList(body, IST)!;
    expect(r.serial).toBe(42);
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ channel: 1, avType: 2, streamType: 2, storageType: 1, sizeBytes: 1_048_576, alarmFlags: '0000000000000001' });
    expect(r.items[0].start?.toISOString()).toBe('2026-10-19T04:58:00.000Z');
    expect(r.items[1].end?.toISOString()).toBe('2026-10-19T05:02:00.000Z');
    // Truncated item ignored; too-short body rejected.
    expect(parseResourceList(body.subarray(0, 6 + 28 + 10), IST)!.items).toHaveLength(1);
    expect(parseResourceList(Buffer.alloc(3), IST)).toBeNull();

    const attrs = parseAvAttributes(Buffer.from([6, 1, 0, 1, 0x01, 0x40, 0, 98, 1, 4]));
    expect(attrs).toMatchObject({ audioCodec: 6, audioFrameLength: 320, videoCodec: 98, maxAudioChannels: 1, maxVideoChannels: 4, audioOutput: false });
    expect(parseAvAttributes(Buffer.alloc(4))).toBeNull();
  });

  it('decoder matches 0x1205 to the 0x9205 request and 0x1003 to the 0x9003 query', () => {
    const decoder = new Jt808Decoder();
    const session = decoder.createSession();
    session.header = T2013;
    session.clockZone = IST;
    const ctx: DecodeContext = { receivedAt: new Date(), remote: 't', unparsed: jest.fn(), warn: jest.fn() };
    const query = encodeResourceQuery({ channel: 0, start: null, end: null, zone: IST });
    const sent = decodeMessage(split808(decoder.encodeCommand(`#9205:${query.toString('hex')}`, session, 77)).frames[0]);
    expect(sent.header.msgId).toBe(0x9205);
    expect(sent.body.equals(query)).toBe(true);

    const reply = Buffer.concat([Buffer.from([sent.header.serial >> 8, sent.header.serial & 0xff, 0, 0, 0, 1]), resourceItem(1, '261019102800', '261019103000', 10)]);
    const [frame] = split808(encodeMessage(0x1205, T2013, 9, reply)).frames;
    const r = decoder.decode(frame, session, ctx);
    expect(r.commandResponses).toHaveLength(1);
    expect(r.commandResponses![0]).toMatchObject({ ref: 77, text: '1 recording(s)' });
    expect((r.commandResponses![0].data as { items: { start: string }[] }).items[0].start).toBe('2026-10-19T04:58:00.000Z');
    expect(r.replies).toHaveLength(1); // 0x8001 ack

    decoder.encodeCommand('#9003', session, 78);
    const [attrFrame] = split808(encodeMessage(0x1003, T2013, 10, Buffer.from([6, 1, 0, 1, 0, 0, 0, 98, 1, 8]))).frames;
    const a = decoder.decode(attrFrame, session, ctx);
    expect(a.commandResponses![0]).toMatchObject({ ref: 78, data: { maxVideoChannels: 8, videoCodec: 98 } });
  });
});
