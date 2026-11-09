import type Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NormalizedPosition } from '@veetracer/shared';
import { backoffMs, PositionPublisher } from './position-publisher';
import { PositionSpool } from './position-spool';

/** Fake cache: records XADDs; `down` makes every pipeline fail like a closed connection; `status` mirrors ioredis. */
function fakeCache() {
  const stream: { data: string; mid: string }[] = [];
  const state = { down: false, failAfter: -1, hang: false, groups: [] as unknown[] };
  const redis = {
    get status() {
      return state.down ? 'reconnecting' : 'ready';
    },
    pipeline() {
      const ops: { data: string; mid: string }[] = [];
      const p = {
        xadd: (...args: unknown[]) => {
          ops.push({ data: String(args[args.indexOf('data') + 1]), mid: String(args[args.indexOf('mid') + 1]) });
          return p;
        },
        exec: async () => {
          if (state.hang) return new Promise(() => undefined);
          if (state.down) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
          return ops.map((op, i) => {
            if (state.failAfter >= 0 && i >= state.failAfter) return [new Error('OOM'), null];
            stream.push(op);
            return [null, `${stream.length}-0`];
          });
        },
      };
      return p;
    },
    xinfo: async () => state.groups,
  };
  return { redis: redis as unknown as Redis, stream, state };
}

const pos = (id: string, i: number): NormalizedPosition =>
  ({ protocol: 'gt06', uniqueId: id, fixTime: new Date(1_800_000_000_000 + i * 10_000).toISOString(), receivedAt: new Date().toISOString(), lat: 1, lng: 2, speedKph: 0, course: 0, altitude: null, satellites: 8, valid: true, ignition: true, attributes: {} }) as NormalizedPosition;
const fixes = (stream: { data: string }[]) => stream.map((s) => (JSON.parse(s.data) as NormalizedPosition).fixTime);

describe('PositionPublisher', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'vt-pub-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const spool = (maxBytes = 10 * 1024 * 1024) => new PositionSpool({ dir, maxBytes, fsync: false });

  it('without a spool: XADD, or false (ACK withheld) like the old gateway', async () => {
    const { redis, stream, state } = fakeCache();
    const pub = new PositionPublisher(redis, null, { autoReplay: false });
    expect(await pub.publish([pos('a', 1)], 'r')).toBe(true);
    state.down = true;
    expect(await pub.publish([pos('a', 2)], 'r')).toBe(false);
    expect(stream).toHaveLength(1);
    expect(pub.metrics()).toMatchObject({ enabled: false, mode: 'disabled', notAcked: 1 });
  });

  it('XADDs directly while the cache is up, with a unique mid per position', async () => {
    const { redis, stream } = fakeCache();
    const pub = new PositionPublisher(redis, spool(), { autoReplay: false });
    expect(await pub.publish([pos('a', 1), pos('a', 2)], 'r')).toBe(true);
    expect(stream).toHaveLength(2);
    expect(new Set(stream.map((s) => s.mid)).size).toBe(2);
    expect(pub.mode).toBe('direct');
  });

  it('spools while the cache is down (ACK allowed), then replays in order and goes back to direct', async () => {
    const { redis, stream, state } = fakeCache();
    const pub = new PositionPublisher(redis, spool(), { autoReplay: false });
    await pub.publish([pos('a', 1)], 'r');
    state.down = true;
    expect(await pub.publish([pos('a', 2)], 'r')).toBe(true);
    expect(await pub.publish([pos('a', 3), pos('b', 3)], 'r')).toBe(true);
    expect(pub.metrics()).toMatchObject({ mode: 'spooling', pendingEntries: 3, spooled: 3, notAcked: 0 });
    state.down = false;
    // New traffic after reconnect must not overtake the spooled positions.
    expect(await pub.publish([pos('a', 4)], 'r')).toBe(true);
    expect(stream).toHaveLength(1);
    expect(pub.mode).toBe('draining');
    while ((await pub.replayOnce()) !== null) {
      /* drain */
    }
    expect(fixes(stream.filter((s) => (JSON.parse(s.data) as NormalizedPosition).uniqueId === 'a'))).toEqual([1, 2, 3, 4].map((i) => pos('a', i).fixTime));
    expect(stream).toHaveLength(5);
    expect(pub.mode).toBe('direct');
    expect(pub.metrics()).toMatchObject({ pendingEntries: 0, replayed: 4 });
  });

  it('a failed direct XADD lands in the spool instead of being lost', async () => {
    const { redis, stream, state } = fakeCache();
    const pub = new PositionPublisher(redis, spool(), { autoReplay: false, timeoutMs: 50 });
    state.hang = true; // connection looks ready but the server never answers
    expect(await pub.publish([pos('a', 1)], 'r')).toBe(true);
    expect(pub.metrics()).toMatchObject({ directFailed: 1, pendingEntries: 1 });
    state.hang = false;
    await pub.replayOnce();
    expect(stream).toHaveLength(1);
  });

  it('spools only the tail of a partially failed pipeline', async () => {
    const { redis, stream, state } = fakeCache();
    const pub = new PositionPublisher(redis, spool(), { autoReplay: false });
    state.failAfter = 1;
    expect(await pub.publish([pos('a', 1), pos('a', 2), pos('a', 3)], 'r')).toBe(true);
    expect(stream).toHaveLength(1);
    expect(pub.metrics().pendingEntries).toBe(2);
    state.failAfter = -1;
    while ((await pub.replayOnce()) !== null) {
      /* drain */
    }
    expect(fixes(stream)).toEqual([1, 2, 3].map((i) => pos('a', i).fixTime));
  });

  it('returns false only when the spool is full and the cache is down', async () => {
    const { redis, state } = fakeCache();
    const pub = new PositionPublisher(redis, spool(400), { autoReplay: false });
    state.down = true;
    expect(await pub.publish([pos('a', 1)], 'r')).toBe(true);
    expect(await pub.publish([pos('a', 2), pos('a', 3)], 'r')).toBe(false);
    expect(pub.metrics()).toMatchObject({ notAcked: 2, rejected: 2 });
  });

  it('replays what was spooled before a restart', async () => {
    const { redis, stream, state } = fakeCache();
    state.down = true;
    const a = new PositionPublisher(redis, spool(), { autoReplay: false });
    await a.publish([pos('a', 1), pos('a', 2)], 'r');
    a.close();
    state.down = false;
    const b = new PositionPublisher(redis, spool(), { autoReplay: false });
    expect(b.mode).toBe('draining');
    await b.publish([pos('a', 3)], 'r');
    while ((await b.replayOnce()) !== null) {
      /* drain */
    }
    expect(fixes(stream)).toEqual([1, 2, 3].map((i) => pos('a', i).fixTime));
  });

  it('applies backpressure when the processor backlog nears the stream cap', async () => {
    const { redis, stream, state } = fakeCache();
    const pub = new PositionPublisher(redis, spool(), { autoReplay: false });
    state.groups = [['name', 'processor', 'pending', 10, 'lag', 1_900_000]];
    await pub.checkBacklog();
    expect(pub.metrics().backpressure).toBe(true);
    expect(await pub.publish([pos('a', 1)], 'r')).toBe(true);
    expect(stream).toHaveLength(0);
    expect(await pub.replayOnce()).toBe(1000); // waits while the backlog is high
    state.groups = [['name', 'processor', 'pending', 0, 'lag', 1000]];
    await pub.checkBacklog();
    while ((await pub.replayOnce()) !== null) {
      /* drain */
    }
    expect(stream).toHaveLength(1);
  });

  it('backs off exponentially up to 30 s', () => {
    expect([0, 1, 2, 3, 10].map(backoffMs)).toEqual([0, 500, 1000, 2000, 30_000]);
  });
});
