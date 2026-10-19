import { isConnectivityError, isDatabaseError, retryDelayMs, StreamConsumer } from './stream-consumer';
import { PositionProcessor } from './position-processor';
import type Redis from 'ioredis';

class PrismaClientInitializationError extends Error {
  override name = 'PrismaClientInitializationError';
  clientVersion = '6.19.3';
}

describe('processor retry policy', () => {
  it('backs off exponentially from 1 s to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(retryDelayMs)).toEqual([0, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });

  it('classifies database errors', () => {
    expect(isDatabaseError(new PrismaClientInitializationError("Can't reach database server"))).toBe(true);
    expect(isConnectivityError(new PrismaClientInitializationError("Can't reach database server"))).toBe(true);
    expect(isDatabaseError(new Error('READONLY You can\'t write against a read only replica'))).toBe(false);
    const known = Object.assign(new Error('Raw query failed. Code: `22P02`'), { name: 'PrismaClientKnownRequestError', code: 'P2010', clientVersion: '6' });
    expect(isDatabaseError(known)).toBe(true);
    expect(isConnectivityError(known)).toBe(false);
  });

  it('a failing database: retries the same pending batch with growing delays, records dbErrors, recovers', async () => {
    jest.useFakeTimers();
    const reads: string[] = [];
    const redis = {
      xgroup: async () => 'OK',
      xreadgroup: async (...args: unknown[]) => {
        const id = String(args[args.length - 1]);
        reads.push(id);
        // No backlog of our own at start; afterwards the failed entry stays in our PEL.
        if (reads.length === 1) return null;
        return [['vt:positions', [['1-0', ['data', '{}']]]]];
      },
      xautoclaim: async () => ['0-0', []],
      xpending: async () => [0],
      xinfo: async () => [],
    } as unknown as Redis;
    let fail = 3;
    const handle = jest.fn(async () => {
      if (fail-- > 0) throw new PrismaClientInitializationError("Can't reach database server at `localhost:1`");
      consumer.stop();
      return 1;
    });
    const consumer = new StreamConsumer(redis, { handle } as unknown as PositionProcessor, 'test');
    const done = consumer.run();
    // 1st failure → 1 s, 2nd → 2 s, 3rd → 4 s, then success.
    for (let i = 0; i < 20 && handle.mock.calls.length < 4; i++) await jest.advanceTimersByTimeAsync(1000);
    await done;
    jest.useRealTimers();
    expect(handle).toHaveBeenCalledTimes(4);
    // After a connectivity failure our own pending entries ('0') are retried instead of reading new ones ('>').
    expect(reads).toEqual(['0', '>', '0', '0', '0']);
    const m = consumer.metrics();
    expect(m.dbErrors).toBe(3);
    expect(m.lastDbError?.message).toContain("Can't reach database server");
    expect(m.backoffMs).toBe(0);
    expect(m.processed).toBe(1);
    expect(m.lastDbOkAt).not.toBeNull();
  });
});
