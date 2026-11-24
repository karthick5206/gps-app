import { DvrAutoSetupService, setupCommands } from './dvr-auto-setup.service';

const UPLOAD = 'UPLOAD,http://track.veetrax.com/dvr/upload';
const RTMP = 'RSERVICE,103.176.85.69:1935/live';
const NOW = Date.parse('2026-11-24T08:00:00Z');

function harness(history: { payload: string; status: string; createdAt: Date }[], connected = true) {
  const prisma = {
    device: { findMany: jest.fn(async () => [{ id: 'dev-1', uniqueId: '864993060658300', companyId: 'co-1', assignments: [{ objectId: 'obj-1' }] }]) },
    deviceCommand: { findMany: jest.fn(async () => history) },
  };
  const redis = { client: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => (connected ? 'gw-1' : null)) } };
  const commands = { sendSystem: jest.fn(async () => true) };
  const svc = new DvrAutoSetupService(prisma as never, redis as never, commands as never);
  return { svc, commands };
}

describe('Jimi dashcam auto set-up', () => {
  it('reads the |-separated setting and ignores junk', () => {
    expect(setupCommands(` ${UPLOAD} | ${RTMP} | not a command `)).toEqual([UPLOAD, RTMP]);
    expect(setupCommands('')).toEqual([]);
  });

  it('sends every missing command to a connected camera', async () => {
    const { svc, commands } = harness([]);
    await expect(svc.sweep([UPLOAD, RTMP], NOW)).resolves.toBe(2);
    expect(commands.sendSystem).toHaveBeenCalledWith({ companyId: 'co-1', objectId: 'obj-1', deviceId: 'dev-1', uniqueId: '864993060658300' }, RTMP);
  });

  it('skips acknowledged commands and ones sent in the last 10 minutes; resends older unanswered ones', async () => {
    const { svc, commands } = harness([
      { payload: UPLOAD, status: 'ACKED', createdAt: new Date(NOW - 86_400_000) },
      { payload: RTMP, status: 'SENT', createdAt: new Date(NOW - 5 * 60_000) },
    ]);
    await expect(svc.sweep([UPLOAD, RTMP], NOW)).resolves.toBe(0);
    const old = harness([{ payload: RTMP, status: 'FAILED', createdAt: new Date(NOW - 60 * 60_000) }]);
    await expect(old.svc.sweep([RTMP], NOW)).resolves.toBe(1);
    expect(commands.sendSystem).not.toHaveBeenCalled();
  });

  it('does nothing for an offline camera or when the setting is empty', async () => {
    const offline = harness([], false);
    await expect(offline.svc.sweep([UPLOAD], NOW)).resolves.toBe(0);
    await expect(harness([]).svc.sweep([], NOW)).resolves.toBe(0);
  });
});
