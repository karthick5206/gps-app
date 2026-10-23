import { latestApks } from './downloads';

describe('latestApks', () => {
  it('picks the newest version per app by number, not text, and ignores other files', () => {
    const r = latestApks([
      { name: 'VeeTrax-Tracker-1.1.9.apk', size: 1 },
      { name: 'VeeTrax-Tracker-1.1.10.apk', size: 2 },
      { name: 'VeeTrax-0.3.6.apk', size: 3 },
      { name: 'VeeTrax-0.3.5.apk', size: 4 },
      { name: 'notes.txt', size: 5 },
      { name: '../VeeTrax-9.9.9.apk', size: 6 },
    ]);
    expect(r).toEqual([
      { file: 'VeeTrax-0.3.6.apk', app: 'VeeTrax', version: '0.3.6', sizeBytes: 3 },
      { file: 'VeeTrax-Tracker-1.1.10.apk', app: 'VeeTrax Tracker', version: '1.1.10', sizeBytes: 2 },
    ]);
  });
});
