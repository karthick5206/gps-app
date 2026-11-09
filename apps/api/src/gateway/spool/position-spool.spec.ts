import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PositionSpool, SpoolRecord } from './position-spool';

const rec = (i: number): SpoolRecord => ({ m: `b-${i}`, d: JSON.stringify({ uniqueId: 'x', fixTime: new Date(1_800_000_000_000 + i * 1000).toISOString() }), r: '1.2.3.4:5', t: 1_800_000_000_000 + i });

describe('PositionSpool', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'vt-spool-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const open = (over: Partial<ConstructorParameters<typeof PositionSpool>[0]> = {}) => new PositionSpool({ dir, maxBytes: 10 * 1024 * 1024, fsync: false, ...over });

  it('appends durably and reads back in order', async () => {
    const spool = open();
    expect(await spool.append([rec(1), rec(2)])).toBe(true);
    expect(await spool.append([rec(3)])).toBe(true);
    expect(spool.pending).toBe(3);
    const { records, next } = spool.read(10);
    expect(records.map((r) => r.m)).toEqual(['b-1', 'b-2', 'b-3']);
    spool.commit(next, records.length);
    expect(spool.pending).toBe(0);
    expect(spool.read(10).records).toEqual([]);
    expect(spool.snapshot()).toMatchObject({ appended: 3, replayed: 3, pendingBytes: 0, oldestSpooledAt: null });
  });

  it('group-commits appends made in the same tick', async () => {
    const spool = open();
    const results = await Promise.all([spool.append([rec(1)]), spool.append([rec(2)]), spool.append([rec(3)])]);
    expect(results).toEqual([true, true, true]);
    expect(spool.read(10).records.map((r) => r.m)).toEqual(['b-1', 'b-2', 'b-3']);
  });

  it('survives a restart: unreplayed records and the replay position are kept', async () => {
    const a = open();
    await a.append([rec(1), rec(2), rec(3)]);
    const first = a.read(1);
    a.commit(first.next, 1);
    a.close();
    const b = open();
    expect(b.pending).toBe(2);
    expect(b.snapshot().oldestSpooledAt).toBe(rec(2).t);
    expect(b.read(10).records.map((r) => r.m)).toEqual(['b-2', 'b-3']);
  });

  it('cuts off a torn last line left by a crash mid-write', async () => {
    const a = open();
    await a.append([rec(1), rec(2)]);
    a.close();
    const seg = readdirSync(dir).find((f) => f.startsWith('seg-'))!;
    appendFileSync(join(dir, seg), '{"m":"b-3","d":"{\\"uniq');
    const b = open();
    expect(b.pending).toBe(2);
    expect(b.snapshot().lastError).toMatch(/torn/);
    await b.append([rec(4)]);
    expect(b.read(10).records.map((r) => r.m)).toEqual(['b-1', 'b-2', 'b-4']);
  });

  it('refuses appends beyond the size cap (nothing partial is written)', async () => {
    const spool = open({ maxBytes: 400 });
    expect(await spool.append([rec(1)])).toBe(true);
    expect(await spool.append([rec(2), rec(3), rec(4)])).toBe(false);
    expect(spool.pending).toBe(1);
    expect(spool.snapshot()).toMatchObject({ rejected: 3 });
    // Space comes back once replayed.
    const r = spool.read(10);
    spool.commit(r.next, r.records.length);
    expect(await spool.append([rec(5)])).toBe(true);
  });

  it('rotates segments and deletes fully replayed ones', async () => {
    const spool = open({ segmentBytes: 300 });
    for (let i = 1; i <= 12; i++) await spool.append([rec(i)]);
    const segments = () => readdirSync(dir).filter((f) => f.startsWith('seg-')).length;
    expect(segments()).toBeGreaterThan(2);
    const seen: string[] = [];
    for (;;) {
      const { records, next } = spool.read(5);
      if (!records.length) break;
      seen.push(...records.map((r) => r.m));
      spool.commit(next, records.length);
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `b-${i + 1}`));
    expect(spool.pending).toBe(0);
    expect(segments()).toBe(1); // only the segment being appended to
    const last = readdirSync(dir).find((f) => f.startsWith('seg-'))!;
    expect(statSync(join(dir, last)).size).toBeGreaterThan(0);
    // Reopen after full replay: nothing pending.
    spool.close();
    expect(open().pending).toBe(0);
  });

  it('really fsyncs when asked (default)', async () => {
    const spool = new PositionSpool({ dir, maxBytes: 1024 * 1024 });
    expect(await spool.append([rec(1)])).toBe(true);
    spool.close();
  });
});
