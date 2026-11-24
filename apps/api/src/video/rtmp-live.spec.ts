import { pickReadyPath, rtmpCamera, rtmpCommand } from './rtmp-live';

const IMEI = '357730090564767';

describe('RTMP live (Jimi dashcams)', () => {
  it('builds the camera command: channel 1 road (OUT), 2 driver (IN)', () => {
    expect(rtmpCamera(1)).toBe('OUT');
    expect(rtmpCamera(2)).toBe('IN');
    expect(rtmpCommand(1, 15)).toBe('RTMP,ON,OUT,15');
    expect(rtmpCommand(2, 30)).toBe('RTMP,ON,IN,30');
  });

  it('picks the ready stream of this device, preferring stream 0', () => {
    const items = [
      { name: `live/1/${IMEI}`, ready: true, readyTime: '2026-11-24T05:00:00Z' },
      { name: `live/0/${IMEI}`, ready: true, readyTime: '2026-11-24T05:00:00Z' },
      { name: 'live/0/111111111111111', ready: true, readyTime: '2026-11-24T05:00:00Z' },
    ];
    expect(pickReadyPath(items, IMEI)).toBe(`live/0/${IMEI}`);
    expect(pickReadyPath([{ name: `live/0/${IMEI}`, ready: false, readyTime: null }], IMEI)).toBeNull();
  });

  it('after a command, only a stream that came up after it counts', () => {
    const sent = Date.parse('2026-11-24T05:10:00Z');
    const old = [{ name: `live/0/${IMEI}`, ready: true, readyTime: '2026-11-24T05:00:00Z' }];
    expect(pickReadyPath(old, IMEI, sent)).toBeNull();
    const fresh = [{ name: `live/0/${IMEI}`, ready: true, readyTime: '2026-11-24T05:10:03Z' }];
    expect(pickReadyPath(fresh, IMEI, sent)).toBe(`live/0/${IMEI}`);
  });
});
