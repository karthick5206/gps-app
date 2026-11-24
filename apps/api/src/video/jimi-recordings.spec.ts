import { zonedToUtc } from '../dvr-upload/dvr-upload.logic';
import { filesForPlayback, jimiRecordings, parseJimiFileList, parseJimiRecordingName } from './jimi-recordings';

const IST = (local: string) => zonedToUtc(local, 'Asia/Kolkata');

describe('Jimi SD-card recordings', () => {
  it('parses general recording names (front / inward, low / HD)', () => {
    expect(parseJimiRecordingName('2021_06_10_18_50_17_01.mp4')).toEqual({ name: '2021_06_10_18_50_17_01.mp4', localStart: '2021-06-10T18:50:17', channel: 1, hd: false, durationSec: 60 });
    expect(parseJimiRecordingName('2021_05_31_08_10_45_02.mp4')).toMatchObject({ channel: 2, hd: false });
    expect(parseJimiRecordingName('2021_05_31_08_10_45_04.mp4')).toMatchObject({ channel: 2, hd: true, durationSec: 180 });
    expect(parseJimiRecordingName('EVENT_357730090564767_00000000_2021_01_29_07_28_18_F_05.mp4')).toBeNull();
  });

  it('turns the posted list into recordings of the asked channel and time (company time zone)', () => {
    const files = parseJimiFileList('2026_11_24_10_00_00_01.mp4,2026_11_24_10_01_00_01.mp4,2026_11_24_10_00_00_02.mp4,junk.txt');
    expect(files).toHaveLength(3);
    const recs = jimiRecordings(files, 1, new Date('2026-11-24T04:30:30Z'), new Date('2026-11-24T04:40:00Z'), IST);
    expect(recs.map((r) => [r.fileName, r.start, r.end])).toEqual([
      ['2026_11_24_10_00_00_01.mp4', '2026-11-24T04:30:00.000Z', '2026-11-24T04:31:00.000Z'],
      ['2026_11_24_10_01_00_01.mp4', '2026-11-24T04:31:00.000Z', '2026-11-24T04:32:00.000Z'],
    ]);
    expect(jimiRecordings(files, 0, new Date('2026-11-24T04:00:00Z'), new Date('2026-11-24T05:00:00Z'), IST)).toHaveLength(3);
  });

  it('picks the files to replay for a time window', () => {
    const files = parseJimiFileList(['2026_11_24_10_00_00_02.mp4', '2026_11_24_10_01_00_02.mp4', '2026_11_24_10_02_00_02.mp4']);
    expect(filesForPlayback(files, 2, new Date('2026-11-24T04:31:30Z'), new Date('2026-11-24T04:32:10Z'), IST)).toEqual(['2026_11_24_10_01_00_02.mp4', '2026_11_24_10_02_00_02.mp4']);
  });
});

describe('Jimi recorded playback stream and name-list endpoint', () => {
  it('finds the playback stream live/<imei> started after the command', () => {
    const { pickPlaybackPath } = jest.requireActual<typeof import('./rtmp-live')>('./rtmp-live');
    const items = [
      { name: 'live/0/864993060658300', ready: true, readyTime: '2026-11-24T05:00:00Z' },
      { name: 'live/864993060658300', ready: true, readyTime: '2026-11-24T05:00:10Z' },
    ];
    expect(pickPlaybackPath(items, '864993060658300')).toBe('live/864993060658300');
    expect(pickPlaybackPath(items, '864993060658300', Date.parse('2026-11-24T05:01:00Z'))).toBeNull();
  });

  it('keeps the posted list of a registered camera and answers {code:0, ok:true}', async () => {
    const { DvrUploadService } = jest.requireActual<typeof import('../dvr-upload/dvr-upload.service')>('../dvr-upload/dvr-upload.service');
    const set = jest.fn(async () => 'OK');
    const findUnique = jest.fn(async ({ where }: { where: { uniqueId: string } }) => (where.uniqueId === '864993060658300' ? { id: 'd1' } : null));
    const svc = new DvrUploadService({ device: { findUnique } } as never, { client: { set } } as never);
    await expect(svc.fileList({ imei: '864993060658300', fileNameList: '2026_11_24_10_00_00_01.mp4,bad' })).resolves.toEqual({ code: 0, ok: true });
    expect(set).toHaveBeenCalledWith('vt:video:jimi:files:864993060658300', expect.stringContaining('"names":["2026_11_24_10_00_00_01.mp4"]'), 'EX', 172800);
    await expect(svc.fileList({ imei: '111111111111111', fileNameList: 'x' })).resolves.toEqual({ code: 0, ok: true });
    expect(set).toHaveBeenCalledTimes(1);
    await expect(svc.fileList({})).resolves.toMatchObject({ ok: false });
  });
});
