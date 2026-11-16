/**
 * History archiving on a real PostgreSQL (positions table from the migrations; a Timescale hypertable where the
 * extension is installed). Not part of the normal run:
 *   HISTORY_ARCHIVE_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_archive_test \
 *     npx jest --testRegex 'history-archive\.db-test\.ts$' --runInBand
 * Allowed databases: see test/scratch-db.ts. The engine commits its own transactions, so the suite creates uniquely
 * named rows and removes them (and its archive directory) afterwards.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dbDescribe } from '../test/scratch-db';
import { ArchiveEngine } from './archive-engine';
import { ArchiveWriter, readArchiveFile, resolveArchivePath, verifyArchiveFile } from './archive-file';

const URL_ = process.env.HISTORY_ARCHIVE_DB_TEST_URL ?? process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const DAY = 86_400_000;

d(`history archive on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const tag = `Zha${Date.now().toString(36)}`;
  const now = Date.now();
  // UTC companies: local days are UTC days. Day D is 40 days old, afterDays 30.
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const midnight = (ms: number) => Date.parse(`${dayKey(ms)}T00:00:00.000Z`);
  const D = midnight(now - 40 * DAY);
  const D1 = D + DAY;
  const D2 = D + 2 * DAY;
  const RECENT = midnight(now - 5 * DAY);
  let dir: string;
  let partnerId = '';
  let companyA = '';
  let companyB = '';
  const obj: Record<'a1' | 'a2' | 'a3' | 'b1', string> = { a1: '', a2: '', a3: '', b1: '' };
  const dev: Record<'a1' | 'a2' | 'a3' | 'b1', string> = {
    a1: crypto.randomUUID(),
    a2: crypto.randomUUID(),
    a3: crypto.randomUUID(),
    b1: crypto.randomUUID(),
  };
  let engine: ArchiveEngine;

  const points = (objectId: string, deviceId: string, start: number, n: number, stepMs = 60_000): Prisma.PositionCreateManyInput[] =>
    Array.from({ length: n }, (_, i) => ({
      objectId,
      deviceId,
      fixTime: new Date(start + 3_600_000 + i * stepMs + (i % 7)),
      serverTime: new Date(start + 3_600_000 + i * stepMs + 1_234),
      lat: 12.9716 + i * 1.234567e-5,
      lng: 77.5946 - i * 7.654321e-6,
      speedKph: (i * 1.7) % 97,
      course: (i * 13) % 360,
      altitude: i % 3 ? 901.5 + i : null,
      satellites: i % 4 ? 8 : null,
      valid: i % 11 !== 0,
      ignition: i % 5 === 0 ? null : i % 2 === 0,
      flags: i % 9 === 0 ? 1 : 0,
      attributes: { odometerM: 100_000 + i * 17, io: { din1: i % 2 === 0 }, txt: `p${i}` },
    }));
  const rowsOf = (objectId: string, from: number, to: number) =>
    prisma.position.findMany({ where: { objectId, fixTime: { gte: new Date(from), lt: new Date(to) } }, orderBy: [{ fixTime: 'asc' }, { deviceId: 'asc' }] });
  const count = (objectId: string) => prisma.position.count({ where: { objectId } });

  let snapA1D: Awaited<ReturnType<typeof rowsOf>> = [];

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-archive-db-'));
    engine = new ArchiveEngine(prisma, { dir });
    const partner = await prisma.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } });
    partnerId = partner.id;
    companyA = (await prisma.company.create({ data: { partnerId, name: `${tag} A`, timezone: 'UTC', settings: { historyArchive: { enabled: true, afterDays: 30 } } } })).id;
    companyB = (await prisma.company.create({ data: { partnerId, name: `${tag} B`, timezone: 'UTC' } })).id;
    obj.a1 = (await prisma.trackedObject.create({ data: { companyId: companyA, name: `${tag} a1` } })).id;
    obj.a2 = (await prisma.trackedObject.create({ data: { companyId: companyA, name: `${tag} a2` } })).id;
    obj.a3 = (await prisma.trackedObject.create({ data: { companyId: companyA, name: `${tag} a3` } })).id;
    obj.b1 = (await prisma.trackedObject.create({ data: { companyId: companyB, name: `${tag} b1` } })).id;
    await prisma.position.createMany({
      data: [
        ...points(obj.a1, dev.a1, D, 300),
        ...points(obj.a1, dev.a1, D1, 120),
        ...points(obj.a1, dev.a1, RECENT, 50),
        ...points(obj.a2, dev.a2, D, 40),
        ...points(obj.a3, dev.a3, D, 40),
        ...points(obj.b1, dev.b1, D, 60),
      ],
    });
    // Summarizer state: a1 and b1 summarised up to now, a2 has a dirty day, a3 was never summarised.
    for (const o of [obj.a1, obj.a2, obj.b1]) await prisma.summaryCursor.create({ data: { objectId: o, processedUntil: new Date(now - 60_000) } });
    await prisma.summaryDirtyDay.create({ data: { objectId: obj.a2, day: new Date(D) } });
    await prisma.dailySummary.create({ data: { objectId: obj.a1, companyId: companyA, day: new Date(D), distanceKm: 42.5, tripCount: 3 } });
    snapA1D = await rowsOf(obj.a1, D, D1);
  });

  afterAll(async () => {
    const ids = Object.values(obj).filter(Boolean);
    await prisma.position.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.archivedDay.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.summaryCursor.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.summaryDirtyDay.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.dailySummary.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.trackedObject.deleteMany({ where: { id: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: [companyA, companyB].filter(Boolean) } } });
    if (partnerId) await prisma.partner.delete({ where: { id: partnerId } });
    await prisma.$disconnect();
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it('archives old days of enabled companies: points removed, file verified, ArchivedDay row; others untouched', async () => {
    const stats = await engine.run();
    expect(stats.failures).toBe(0);
    expect(stats.archivedDays).toBe(2);
    expect(stats.points).toBe(420);

    // a1: both old days gone from the database, the recent day kept.
    expect(await rowsOf(obj.a1, D, D2)).toHaveLength(0);
    expect(await count(obj.a1)).toBe(50);
    const rows = await prisma.archivedDay.findMany({ where: { objectId: obj.a1 }, orderBy: { day: 'asc' } });
    expect(rows.map((r) => [r.day.toISOString().slice(0, 10), r.status, r.pointCount])).toEqual([
      [dayKey(D), 'ARCHIVED', 300],
      [dayKey(D1), 'ARCHIVED', 120],
    ]);
    for (const r of rows) {
      expect(r.companyId).toBe(companyA);
      expect(r.filePath).toBe(`${companyA}/${obj.a1}/${dayKey(r.day.getTime()).replace(/-/g, '/')}.jsonl.gz`);
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.archivedAt).not.toBeNull();
      const abs = resolveArchivePath(dir, r.filePath!);
      expect((await fsp.stat(abs)).size).toBe(r.bytes);
      await verifyArchiveFile(abs, { count: r.pointCount, checksum: r.checksum!, objectId: obj.a1, day: dayKey(r.day.getTime()) });
    }
    // Dirty (a2), never summarised (a3) and the company without the switch (b1): untouched.
    expect(await count(obj.a2)).toBe(40);
    expect(await count(obj.a3)).toBe(40);
    expect(await count(obj.b1)).toBe(60);
    expect(await prisma.archivedDay.count({ where: { objectId: { in: [obj.a2, obj.a3, obj.b1] } } })).toBe(0);
    // Daily summaries stay.
    expect(await prisma.dailySummary.findUnique({ where: { objectId_day: { objectId: obj.a1, day: new Date(D) } } })).toMatchObject({ distanceKm: 42.5, tripCount: 3 });
  });

  it('a re-run changes nothing (idempotent)', async () => {
    const before = await prisma.archivedDay.findMany({ where: { objectId: obj.a1 }, orderBy: { day: 'asc' } });
    const stats = await engine.run();
    expect(stats.archivedDays).toBe(0);
    expect(stats.failures).toBe(0);
    const after = await prisma.archivedDay.findMany({ where: { objectId: obj.a1 }, orderBy: { day: 'asc' } });
    expect(after.map((r) => [r.status, r.checksum, r.updatedAt.getTime()])).toEqual(before.map((r) => [r.status, r.checksum, r.updatedAt.getTime()]));
    expect(await count(obj.a1)).toBe(50);
  });

  it('restore brings the points back exactly, and is idempotent', async () => {
    const req = await engine.requestRestore(companyA, [obj.a1], dayKey(D), dayKey(D), null, 7);
    expect(req).toEqual({ queued: 1, already: 0 });
    expect(await engine.requestRestore(companyA, [obj.a1], dayKey(D), dayKey(D), null, 7)).toEqual({ queued: 0, already: 1 });
    expect(await engine.restorePending()).toEqual({ restored: 1, failed: 0 });
    expect(await rowsOf(obj.a1, D, D1)).toEqual(snapA1D);
    const row = await prisma.archivedDay.findUniqueOrThrow({ where: { objectId_day: { objectId: obj.a1, day: new Date(D) } } });
    expect(row.status).toBe('RESTORED');
    expect(row.restoredAt).not.toBeNull();
    expect(row.keepUntil!.getTime()).toBeGreaterThan(now + 6 * DAY);
    // The day after stays archived.
    expect(await rowsOf(obj.a1, D1, D2)).toHaveLength(0);
    // Restoring again (renews the keep period) inserts nothing twice.
    expect((await engine.requestRestore(companyA, [obj.a1], dayKey(D), dayKey(D1), null, 3)).queued).toBe(2);
    expect(await engine.restorePending()).toEqual({ restored: 2, failed: 0 });
    expect(await rowsOf(obj.a1, D, D1)).toEqual(snapA1D);
    expect(await count(obj.a1)).toBe(50 + 300 + 120);
    // While restored and held, a run leaves the days alone.
    expect((await engine.run()).archivedDays).toBe(0);
    expect(await count(obj.a1)).toBe(470);
  });

  it('re-archives restored days after their keep period, folding in late points', async () => {
    await prisma.archivedDay.updateMany({ where: { objectId: obj.a1 }, data: { keepUntil: new Date(now - 1000) } });
    // A late point for day D arrived while it was restored.
    await prisma.position.createMany({ data: points(obj.a1, dev.a1, D + 20 * 3_600_000, 1) });
    const stats = await engine.run();
    expect(stats.failures).toBe(0);
    expect(stats.reArchived).toBe(2);
    expect(await count(obj.a1)).toBe(50);
    const row = await prisma.archivedDay.findUniqueOrThrow({ where: { objectId_day: { objectId: obj.a1, day: new Date(D) } } });
    expect(row).toMatchObject({ status: 'ARCHIVED', pointCount: 301, keepUntil: null });
    expect(row.restoredAt).not.toBeNull();
    expect((await readArchiveFile(resolveArchivePath(dir, row.filePath!))).points).toHaveLength(301);
  });

  it('never deletes points when the file write fails', async () => {
    await prisma.position.createMany({ data: points(obj.a1, dev.a1, D2, 30) });
    const failing: ArchiveWriter = {
      write: async () => {
        throw new Error('ENOSPC: no space left on device (simulated)');
      },
    };
    const broken = new ArchiveEngine(prisma, { dir, writer: failing });
    const stats = await broken.run();
    expect(stats.failures).toBe(1);
    expect(stats.archivedDays).toBe(0);
    expect(await rowsOf(obj.a1, D2, D2 + DAY)).toHaveLength(30);
    const row = await prisma.archivedDay.findUniqueOrThrow({ where: { objectId_day: { objectId: obj.a1, day: new Date(D2) } } });
    expect(row).toMatchObject({ status: 'FAILED', filePath: null, claimToken: null });
    expect(row.lastError).toMatch(/ENOSPC/);
    await expect(fsp.stat(path.join(dir, companyA, obj.a1, dayKey(D2).replace(/-/g, '/') + '.jsonl.gz'))).rejects.toThrow();

    // A writer that "succeeds" but leaves a wrong file is caught by the independent re-read: nothing deleted either.
    const lying: ArchiveWriter = {
      write: async (abs) => {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, 'not gzip');
        return { count: 30, checksum: 'f'.repeat(64), bytes: 8 };
      },
    };
    expect((await new ArchiveEngine(prisma, { dir, writer: lying }).run()).failures).toBe(1);
    expect(await rowsOf(obj.a1, D2, D2 + DAY)).toHaveLength(30);
    await fsp.rm(path.join(dir, companyA, obj.a1, dayKey(D2).replace(/-/g, '/') + '.jsonl.gz'), { force: true });

    // The next healthy run retries the FAILED day.
    const ok = await engine.run();
    expect(ok.failures).toBe(0);
    expect(ok.archivedDays).toBe(1);
    expect(await rowsOf(obj.a1, D2, D2 + DAY)).toHaveLength(0);
    expect(await prisma.archivedDay.findUniqueOrThrow({ where: { objectId_day: { objectId: obj.a1, day: new Date(D2) } } })).toMatchObject({ status: 'ARCHIVED', pointCount: 30, lastError: null });
  });
});
