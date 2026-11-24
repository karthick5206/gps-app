import { createHash } from 'node:crypto';
import { jimiMime, jimiSign, parseJimiFileName, verifyJimiSign, zonedToUtc } from './dvr-upload.logic';
import { DvrUploadService } from './dvr-upload.service';

jest.mock('../driver-events/media-store', () => ({ writeIncoming: jest.fn(async () => 'incoming/2026-11-24/x.mp4') }));

const KEY = 'test-key';
const NAME = 'EVENT_357730090564767_00000000_2026_11_24_10_15_30_F_05.mp4';

describe('Jimi upload sign', () => {
  it('is Base64 of the lower-case md5 hex of filename + timestamp + key', () => {
    const hex = createHash('md5').update(`${NAME}1700000000000${KEY}`).digest('hex');
    expect(jimiSign(NAME, '1700000000000', KEY)).toBe(Buffer.from(hex).toString('base64'));
    expect(verifyJimiSign(NAME, '1700000000000', jimiSign(NAME, '1700000000000', KEY), KEY)).toBe(true);
    expect(verifyJimiSign(NAME, '1700000000001', jimiSign(NAME, '1700000000000', KEY), KEY)).toBe(false);
    expect(verifyJimiSign(NAME, '1700000000000', 'short', KEY)).toBe(false);
  });
});

describe('Jimi file names', () => {
  it('reads IMEI, local time and camera from event names', () => {
    expect(parseJimiFileName(NAME)).toEqual({ imei: '357730090564767', localTime: '2026-11-24T10:15:30', channel: 1 });
    expect(parseJimiFileName('EVENT_353376110008882_00000000_2020_08_11_14_17_36_24.mp4')).toEqual({ imei: '353376110008882', localTime: '2020-08-11T14:17:36', channel: 2 });
    expect(parseJimiFileName('EVENT_357730090564767_00000000_2021_01_29_07_28_18_I_06.mp4')?.channel).toBe(2);
    expect(parseJimiFileName('PIC_357730090564767.jpg')).toEqual({ imei: '357730090564767', localTime: null, channel: null });
    expect(parseJimiFileName('img07-1588139792287.png')).toBeNull();
  });

  it('maps extensions to mime types', () => {
    expect(jimiMime(NAME)).toBe('video/mp4');
    expect(jimiMime('a.JPG')).toBe('image/jpeg');
    expect(jimiMime('a.exe')).toBeNull();
  });

  it('converts the name time from the company zone to UTC', () => {
    expect(zonedToUtc('2026-11-24T10:15:30', 'Asia/Kolkata').toISOString()).toBe('2026-11-24T04:45:30.000Z');
    expect(zonedToUtc('2026-11-24T10:15:30', 'UTC').toISOString()).toBe('2026-11-24T10:15:30.000Z');
  });
});

describe('DvrUploadService', () => {
  function service(device: unknown, alarm: unknown[] = []) {
    const xadd = jest.fn(async () => '1-0');
    const prisma = { device: { findUnique: jest.fn(async () => device) }, $queryRaw: jest.fn(async () => alarm) };
    const svc = new DvrUploadService(prisma as never, { client: { xadd } } as never);
    return { svc, xadd, prisma };
  }
  const file = { buffer: Buffer.from('mp4data'), originalname: NAME };
  const signed = (ts = '1700000000000') => ({ file, filename: NAME, timestamp: ts, sign: jimiSign(NAME, ts, KEY) });

  it('refuses a wrong sign and missing fields without storing anything', async () => {
    const { svc, xadd } = service({ id: 'd1', uniqueId: '357730090564767', company: { timezone: 'Asia/Kolkata' } });
    expect((await svc.upload({ ...signed(), sign: 'bad' }, KEY)).code).toBe(400);
    expect((await svc.upload({ file, filename: NAME }, KEY)).code).toBe(400);
    expect((await svc.upload(signed(), '')).code).toBe(500);
    expect(xadd).not.toHaveBeenCalled();
  });

  it('answers 200 for an unregistered device (so the camera stops retrying) but drops the file', async () => {
    const { svc, xadd } = service(null);
    expect(await svc.upload(signed(), KEY)).toEqual({ code: 200, message: 'success', data: NAME });
    expect(xadd).not.toHaveBeenCalled();
  });

  it('stores the clip and announces it with the alarm time and place', async () => {
    const at = new Date('2026-11-24T04:45:29Z');
    const { svc, xadd } = service({ id: 'd1', uniqueId: '357730090564767', company: { timezone: 'Asia/Kolkata' } }, [{ fixTime: at, lat: 13.08, lng: 80.27 }]);
    expect(await svc.upload(signed(), KEY)).toEqual({ code: 200, message: 'success', data: NAME });
    const msg = JSON.parse((xadd.mock.calls[0] as unknown as string[])[6]);
    expect(msg).toMatchObject({ uniqueId: '357730090564767', source: 'ATTACHMENT', kind: 'VIDEO', mime: 'video/mp4', channel: 1, capturedAt: at.toISOString(), lat: 13.08, lng: 80.27, ref: NAME });
  });

  it('falls back to the name time in the company zone when no alarm lists the file', async () => {
    const { svc, xadd } = service({ id: 'd1', uniqueId: '357730090564767', company: { timezone: 'Asia/Kolkata' } }, []);
    await svc.upload(signed(), KEY);
    expect(JSON.parse((xadd.mock.calls[0] as unknown as string[])[6]).capturedAt).toBe('2026-11-24T04:45:30.000Z');
  });
});
