import { DecodeContext, DecodedMedia } from '../protocol';
import { AttachmentServer, missingRanges } from '../media/attachment-server';
import { decodeMessage, encodeMessage, escape808, Jt808Msg, unescape808 } from './codec';
import { Jt808Decoder, Jt808Session, JT808_MAX_REASSEMBLED_BYTES } from './decoder';
import {
  encodeAlarmAttachRequest,
  encodeAttachData,
  encodeCameraShoot,
  encodeFileDoneResponse,
  encodeMediaUploadResponse,
  MediaMsg,
  parseAlarmIdent,
  parseAttachInfo,
  parseAttachName,
  parseMediaUpload,
  parseShootResponse,
} from './media';

const BCD6 = Buffer.from('013912345678', 'hex');
const T2013 = { terminalBcd: BCD6, version2019: false, protocolVersion: null };
const NOW = new Date('2026-10-19T06:30:00Z');
const bcd = (d: Date) => Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14), 'hex');

function location(clock: Date, extras: Buffer[] = []): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt32BE(0b11, 4);
  b.writeUInt32BE(13_082_700, 8);
  b.writeUInt32BE(80_270_700, 12);
  b.writeUInt16BE(425, 18);
  bcd(clock).copy(b, 22);
  return Buffer.concat([b, ...extras]);
}

/** A fake JPEG of `n` bytes (SOI marker + filler, never 0x7E free). */
const jpeg = (n: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7) & 0xff;
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
};

function upload(mediaId: number, channel: number, data: Buffer, clock = new Date(NOW.getTime() + 8 * 3600_000)): Buffer {
  const head = Buffer.from([0, 0, 0, 0, 0, 0, 0, channel]);
  head.writeUInt32BE(mediaId, 0);
  return Buffer.concat([head, location(clock), data]);
}

/** Sub-packaged frames of one message (props bit 13, package total / index after the serial). */
function subpackages(msgId: number, body: Buffer, size: number, firstSerial = 100): Buffer[] {
  const parts: Buffer[] = [];
  for (let o = 0; o < body.length; o += size) parts.push(body.subarray(o, o + size));
  return parts.map((part, i) => {
    const head = Buffer.alloc(16);
    head.writeUInt16BE(msgId, 0);
    head.writeUInt16BE(part.length | 0x2000, 2);
    BCD6.copy(head, 4);
    head.writeUInt16BE(firstSerial + i, 10);
    head.writeUInt16BE(parts.length, 12);
    head.writeUInt16BE(i + 1, 14);
    const raw = Buffer.concat([head, part]);
    let x = 0;
    for (const c of raw) x ^= c;
    return Buffer.concat([Buffer.from([0x7e]), escape808(Buffer.concat([raw, Buffer.from([x])])), Buffer.from([0x7e])]);
  });
}

const parse = (wire: Buffer) => decodeMessage(unescape808(wire.subarray(1, wire.length - 1)));

function harness(options?: ConstructorParameters<typeof Jt808Decoder>[0]) {
  const decoder = new Jt808Decoder(options);
  const session: Jt808Session = decoder.createSession();
  session.clockZone = 480;
  const warn = jest.fn();
  const ctx: DecodeContext = { receivedAt: NOW, remote: 'test', unparsed: jest.fn(), warn };
  const feed = (wire: Buffer) => decoder.split(wire).frames.map((f) => decoder.decode(f, session, ctx));
  return { decoder, session, feed, warn };
}

describe('JT/T 808 snapshots (0x8801 / 0x0805 / 0x0800 / 0x0801 / 0x8800)', () => {
  it('encodes camera shoot immediately', () => {
    expect(encodeCameraShoot({ channel: 2 }).toString('hex')).toBe('020001000000020' + '57f40407f');
    const b = encodeCameraShoot({ channel: 1, command: 3, interval: 5, save: 1, resolution: 4, quality: 1 });
    expect([b[0], b.readUInt16BE(1), b.readUInt16BE(3), b[5], b[6], b[7]]).toEqual([1, 3, 5, 1, 4, 1]);
  });

  it('parses the shoot response and answers the request', () => {
    const { decoder, session, feed } = harness();
    feed(encodeMessage(Jt808Msg.HEARTBEAT, T2013, 1, Buffer.alloc(0)));
    const cmd = parse(decoder.encodeCommand(`#8801:${encodeCameraShoot({ channel: 2 }).toString('hex')}`, session, 77));
    expect(cmd.header.msgId).toBe(MediaMsg.CAMERA_SHOOT);
    expect(cmd.body[0]).toBe(2);
    const reply = Buffer.from([0, 0, 0, 0, 2, 0, 0, 0, 0x2a, 0, 0, 0, 0x2b]);
    reply.writeUInt16BE(cmd.header.serial, 0);
    expect(parseShootResponse(reply)).toEqual({ serial: cmd.header.serial, result: 0, ids: [0x2a, 0x2b] });
    const [r] = feed(encodeMessage(MediaMsg.SHOOT_RESPONSE, T2013, 2, reply));
    expect(r.commandResponses).toEqual([{ ref: 77, text: 'OK: 2 photo(s)', data: { serial: cmd.header.serial, result: 0, ids: [0x2a, 0x2b] } }]);
  });

  it('stores a single-frame JPEG upload with the embedded location and replies 0x8800', () => {
    const { session, feed } = harness();
    session.snapshots.push({ eventId: 'ev-1', channel: 2, at: NOW.getTime() - 5000, ids: [9] });
    const photo = jpeg(600);
    const [r] = feed(encodeMessage(MediaMsg.MEDIA_UPLOAD, T2013, 5, upload(9, 2, photo)));
    expect(r.media).toHaveLength(1);
    const m = r.media![0];
    expect(m).toMatchObject({ uniqueId: '13912345678', source: 'SNAPSHOT', kind: 'PHOTO', mime: 'image/jpeg', channel: 2, eventId: 'ev-1', ref: '9', lat: 13.0827, lng: 80.2707 });
    expect(m.capturedAt).toBe(NOW.toISOString());
    expect(m.data.equals(photo)).toBe(true);
    const ack = parse(r.replies[0]);
    expect(ack.header.msgId).toBe(MediaMsg.MEDIA_UPLOAD_RESPONSE);
    expect(ack.body).toEqual(encodeMediaUploadResponse(9));
    expect(session.snapshots).toHaveLength(0);
  });

  it('acknowledges the multimedia event info (0x0800)', () => {
    const { feed } = harness();
    const [r] = feed(encodeMessage(MediaMsg.MEDIA_EVENT, T2013, 3, Buffer.from([0, 0, 0, 9, 0, 0, 0, 2])));
    expect(parse(r.replies[0]).header.msgId).toBe(Jt808Msg.PLATFORM_RESPONSE);
  });

  it('reassembles a sub-packaged JPEG and matches a pending snapshot by channel', () => {
    const { session, feed } = harness();
    session.snapshots.push({ eventId: 'ev-2', channel: 1, at: NOW.getTime(), ids: [] });
    const photo = jpeg(50_000);
    const frames = subpackages(MediaMsg.MEDIA_UPLOAD, upload(0x1234, 1, photo), 1000);
    expect(frames.length).toBe(51);
    const results = frames.flatMap((f) => feed(f));
    const media = results.flatMap((r) => r.media ?? []);
    expect(media).toHaveLength(1);
    expect(media[0].data.equals(photo)).toBe(true);
    expect(media[0].eventId).toBe('ev-2');
    const replies = results.flatMap((r) => r.replies).map(parse);
    expect(replies.filter((m) => m.header.msgId === Jt808Msg.PLATFORM_RESPONSE)).toHaveLength(51);
    expect(replies.filter((m) => m.header.msgId === MediaMsg.MEDIA_UPLOAD_RESPONSE).map((m) => m.body)).toEqual([encodeMediaUploadResponse(0x1234)]);
    expect(session.parts.size).toBe(0);
  });

  it('asks for missing packages when the last one arrives', () => {
    const { feed } = harness();
    const frames = subpackages(MediaMsg.MEDIA_UPLOAD, upload(7, 1, jpeg(5000)), 1000);
    const results = frames.filter((_, i) => i !== 2 && i !== 4).flatMap((f) => feed(f));
    const retransmit = results.flatMap((r) => r.replies).map(parse).find((m) => m.header.msgId === MediaMsg.MEDIA_UPLOAD_RESPONSE);
    expect(retransmit?.body).toEqual(encodeMediaUploadResponse(7, [3, 5]));
    expect(results.some((r) => r.media?.length)).toBe(false);
  });

  it('drops a sub-packaged message larger than the reassembly cap', () => {
    const { session, feed, warn } = harness();
    const parts = Math.ceil(JT808_MAX_REASSEMBLED_BYTES / 1000) + 2;
    const frames = subpackages(MediaMsg.MEDIA_UPLOAD, Buffer.alloc(parts * 1000, 1), 1000);
    for (const f of frames) feed(f);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('jt808:parts'), expect.stringContaining('dropped'));
    expect(session.parts.size).toBeLessThanOrEqual(1);
  });

  it('ignores non-JPEG multimedia', () => {
    const { feed } = harness();
    const [r] = feed(encodeMessage(MediaMsg.MEDIA_UPLOAD, T2013, 5, upload(3, 1, Buffer.from('not a jpeg'))));
    expect(r.media).toBeUndefined();
    expect(parseMediaUpload(upload(3, 1, Buffer.from('x'))).location?.lat).toBe(13.0827);
  });
});

describe('Su-standard alarm attachments (0x9208 / 0x1210 / 0x1211 / data / 0x1212 / 0x9212)', () => {
  const ident = Buffer.concat([Buffer.from('ABC1234', 'ascii'), bcd(new Date(NOW.getTime() + 8 * 3600_000)), Buffer.from([3, 2, 0])]);

  function adasTlv(attachments: number): Buffer {
    const v = Buffer.alloc(47);
    v.writeUInt32BE(1, 0);
    v[4] = 1; // started
    v[5] = 1; // FCW
    v[6] = 2;
    const id = Buffer.from(ident);
    id[14] = attachments;
    id.copy(v, 31);
    return Buffer.concat([Buffer.from([0x64, v.length]), v]);
  }

  it('parses the alarm identification number', () => {
    expect(parseAlarmIdent(ident)).toEqual({ terminalId: 'ABC1234', time: new Date(NOW.getTime() + 8 * 3600_000), seq: 3, attachments: 2 });
  });

  it('asks the dashcam to upload alarm attachments (0x9208) when the ADAS alarm has some', () => {
    const { feed } = harness({ attachServer: { host: 'track.example.in', port: 7613 } });
    const [r] = feed(encodeMessage(Jt808Msg.LOCATION, T2013, 1, location(new Date(NOW.getTime() + 8 * 3600_000), [adasTlv(2)])));
    expect(r.positions[0].attributes.adas).toBe('fcw');
    const req = r.replies.map(parse).find((m) => m.header.msgId === MediaMsg.ALARM_ATTACH_REQUEST)!;
    const b = req.body;
    expect(b[0]).toBe(16);
    expect(b.subarray(1, 17).toString()).toBe('track.example.in');
    expect(b.readUInt16BE(17)).toBe(7613);
    expect(b.readUInt16BE(19)).toBe(0);
    expect(b.subarray(21, 37)[14]).toBe(2);
    expect(b.subarray(37, 69).toString()).toMatch(/^[0-9a-f]{32}$/);
    expect(b.length).toBe(1 + 16 + 4 + 16 + 32 + 16);
    // No attachments, or no attachment server: no request.
    const none = harness({ attachServer: { host: 'h', port: 1 } }).feed(encodeMessage(Jt808Msg.LOCATION, T2013, 2, location(NOW, [adasTlv(0)])))[0];
    expect(none.replies.map(parse).some((m) => m.header.msgId === MediaMsg.ALARM_ATTACH_REQUEST)).toBe(false);
    const off = harness().feed(encodeMessage(Jt808Msg.LOCATION, T2013, 2, location(NOW, [adasTlv(2)])))[0];
    expect(off.replies.map(parse).some((m) => m.header.msgId === MediaMsg.ALARM_ATTACH_REQUEST)).toBe(false);
  });

  it('encodes 0x9208 and 0x9212', () => {
    const b = encodeAlarmAttachRequest({ host: '1.2.3.4', tcpPort: 7613, ident, alarmNumber: 'x'.repeat(32) });
    expect(b.length).toBe(1 + 7 + 4 + 16 + 32 + 16);
    expect(encodeFileDoneResponse({ name: 'a.jpg', type: 0 }).toString('hex')).toBe('05' + Buffer.from('a.jpg').toString('hex') + '000000');
    const retry = encodeFileDoneResponse({ name: 'a.jpg', type: 0 }, [{ offset: 100, length: 50 }]);
    expect(retry.subarray(6).toString('hex')).toBe('00' + '01' + '01' + '00000064' + '00000032');
  });

  it('parses attachment names', () => {
    expect(parseAttachName('00_65_6501_0_0123456789abcdef0123456789abcdef.jpg')).toEqual({ fileType: 0, channel: 65, ext: 'jpg' });
    expect(parseAttachName('02_2_6402_1_x.mp4')).toEqual({ fileType: 2, channel: 2, ext: 'mp4' });
  });

  function attachInfo(files: { name: string; size: number }[]): Buffer {
    const list = files.map((f) => Buffer.concat([Buffer.from([f.name.length]), Buffer.from(f.name), Buffer.from([f.size >>> 24, (f.size >> 16) & 255, (f.size >> 8) & 255, f.size & 255])]));
    const number = Buffer.alloc(32);
    number.write('ALARMNO-1');
    return Buffer.concat([Buffer.from('ABC1234'), ident, number, Buffer.from([0, files.length]), ...list]);
  }
  const fileInfo = (name: string, type: number, size: number) => {
    const b = Buffer.alloc(1 + name.length + 5);
    b[0] = name.length;
    b.write(name, 1);
    b[1 + name.length] = type;
    b.writeUInt32BE(size, 2 + name.length);
    return b;
  };

  it('receives a photo over the attachment connection', () => {
    const media: DecodedMedia[] = [];
    const server = new AttachmentServer({ zoneOf: () => 480, onMedia: (m) => media.push(m) });
    const conn = AttachmentServer.connection();
    const name = '00_2_6501_0_ALARMNO-1.jpg';
    const photo = jpeg(3000);
    expect(parseAttachInfo(attachInfo([{ name, size: photo.length }]).subarray(0)).files).toEqual([{ name, size: 3000 }]);
    const wire = Buffer.concat([
      encodeMessage(MediaMsg.ATTACH_INFO, T2013, 1, attachInfo([{ name, size: photo.length }])),
      encodeMessage(MediaMsg.FILE_INFO, T2013, 2, fileInfo(name, 0, photo.length)),
      encodeAttachData(name, 0, photo.subarray(0, 2000)),
    ]);
    // Split mid-packet: the tail waits for the next chunk.
    const first = server.feed(conn, wire.subarray(0, wire.length - 500));
    expect(first.replies.map(parse).map((m) => m.header.msgId)).toEqual([Jt808Msg.PLATFORM_RESPONSE, Jt808Msg.PLATFORM_RESPONSE]);
    const rest = Buffer.concat([first.rest, wire.subarray(wire.length - 500), encodeAttachData(name, 2000, photo.subarray(2000)), encodeMessage(MediaMsg.FILE_DONE, T2013, 3, fileInfo(name, 0, photo.length))]);
    const second = server.feed(conn, rest);
    expect(second.rest.length).toBe(0);
    const done = parse(second.replies[0]);
    expect(done.header.msgId).toBe(MediaMsg.FILE_DONE_RESPONSE);
    expect(done.body).toEqual(encodeFileDoneResponse({ name, type: 0 }));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ uniqueId: '13912345678', source: 'ATTACHMENT', kind: 'PHOTO', mime: 'image/jpeg', channel: 2, capturedAt: NOW.toISOString(), ref: `ALARMNO-1/${name}` });
    expect(media[0].data.equals(photo)).toBe(true);
  });

  it('asks for the missing ranges of an incomplete file', () => {
    const media: DecodedMedia[] = [];
    const server = new AttachmentServer({ onMedia: (m) => media.push(m) });
    const conn = AttachmentServer.connection();
    const name = '02_1_6401_0_X.mp4';
    const clip = Buffer.alloc(4000, 7);
    const r = server.feed(conn, Buffer.concat([
      encodeMessage(MediaMsg.FILE_INFO, T2013, 1, fileInfo(name, 2, clip.length)),
      encodeAttachData(name, 1000, clip.subarray(1000, 3000)),
      encodeMessage(MediaMsg.FILE_DONE, T2013, 2, fileInfo(name, 2, clip.length)),
    ]));
    const done = parse(r.replies[1]);
    expect(done.body).toEqual(encodeFileDoneResponse({ name, type: 2 }, [{ offset: 0, length: 1000 }, { offset: 3000, length: 1000 }]));
    expect(media).toHaveLength(0);
    const again = server.feed(conn, Buffer.concat([
      encodeAttachData(name, 0, clip.subarray(0, 1000)),
      encodeAttachData(name, 3000, clip.subarray(3000)),
      encodeMessage(MediaMsg.FILE_DONE, T2013, 3, fileInfo(name, 2, clip.length)),
    ]));
    expect(parse(again.replies[0]).body).toEqual(encodeFileDoneResponse({ name, type: 2 }));
    expect(media[0]).toMatchObject({ kind: 'VIDEO', mime: 'video/mp4', channel: 1 });
    expect(missingRanges(10, new Map([[2, Buffer.alloc(3)]]))).toEqual([{ offset: 0, length: 2 }, { offset: 5, length: 5 }]);
  });
});
