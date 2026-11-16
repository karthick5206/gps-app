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
import { ArchiveEngine, deletePoints } from './archive-engine';
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
  /** Vehicles created by the review-fix tests (cleaned up too). */
  const extra: string[] = [];
  const newVehicle = async (name: string, processedUntil: number | null) => {
    const id = (await prisma.trackedObject.create({ data: { companyId: companyA, name: `${tag} ${name}` } })).id;
    extra.push(id);
    if (processedUntil !== null) await prisma.summaryCursor.create({ data: { objectId: id, processedUntil: new Date(processedUntil) } });
    return id;
  };

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
    const ids = [...Object.values(obj).filter(Boolean), ...extra];
    await prisma.position.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.archivedDay.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.summaryCursor.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.summaryDirtyDay.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.dailySummary.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.trip.deleteMany({ where: { objectId: { in: ids } } });
    await prisma.stop.deleteMany({ where: { objectId: { in: ids } } });
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
    // Right after a failure the day backs off (reported as blocked, not retried) …
    const backoff = await engine.run();
    expect(backoff.failures).toBe(0);
    expect(backoff.blockedFailed).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(obj.a1, D2, D2 + DAY)).toHaveLength(30);
    // … until its back-off period (1 day after the first attempt) is over.
    const age = () => prisma.$executeRaw`UPDATE "ArchivedDay" SET "updatedAt" = now() - interval '8 days' WHERE "objectId" = ${obj.a1}::uuid AND day = ${dayKey(D2)}::date`;
    await age();
    expect((await new ArchiveEngine(prisma, { dir, writer: lying }).run()).failures).toBe(1);
    expect(await rowsOf(obj.a1, D2, D2 + DAY)).toHaveLength(30);
    await fsp.rm(path.join(dir, companyA, obj.a1, dayKey(D2).replace(/-/g, '/') + '.jsonl.gz'), { force: true });

    // The next healthy run after the back-off retries the FAILED day.
    await age();
    const ok = await engine.run();
    expect(ok.failures).toBe(0);
    expect(ok.archivedDays).toBe(1);
    expect(await rowsOf(obj.a1, D2, D2 + DAY)).toHaveLength(0);
    expect(await prisma.archivedDay.findUniqueOrThrow({ where: { objectId_day: { objectId: obj.a1, day: new Date(D2) } } })).toMatchObject({ status: 'ARCHIVED', pointCount: 30, lastError: null });
  });

  // ───────────── review fixes ─────────────

  it('a day that turns dirty while it is being archived is not archived (re-check under the shared lock)', async () => {
    const v = await newVehicle('dirty-mid-run', now - 60_000);
    const dv = crypto.randomUUID();
    await prisma.position.createMany({ data: points(v, dv, D, 25) });
    let fired = false;
    const racing = new ArchiveEngine(prisma, {
      dir,
      beforeCommit: async (objectId) => {
        if (objectId !== v || fired) return;
        fired = true;
        // The summarizer saw a late point for day D meanwhile.
        await prisma.summaryDirtyDay.create({ data: { objectId: v, day: new Date(D) } });
      },
    });
    const stats = await racing.run();
    expect(fired).toBe(true);
    expect(stats.deferred).toBeGreaterThanOrEqual(1);
    expect(await count(v)).toBe(25);
    expect(await prisma.archivedDay.count({ where: { objectId: v } })).toBe(0);
    // The file it wrote was removed again.
    const files = await fsp.readdir(path.join(dir, companyA, v), { recursive: true }).catch(() => [] as string[]);
    expect(files.map(String).filter((f) => f.endsWith('.gz'))).toEqual([]);
    // Once the summarizer is done, the next run archives it.
    await prisma.summaryDirtyDay.deleteMany({ where: { objectId: v } });
    await engine.run();
    expect(await count(v)).toBe(0);
  });

  it('the summarizer lock: the archive transaction waits for a holder of the vehicle lock', async () => {
    const v = await newVehicle('locked', now - 60_000);
    await prisma.position.createMany({ data: points(v, crypto.randomUUID(), D, 5) });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let order: string[] = [];
    const holder = prisma.$transaction(
      async (tx) => {
        const { lockArchiveObjects } = await import('./archive-lock');
        await lockArchiveObjects(tx, [v]);
        order.push('summarizer-locked');
        await held;
        // Like the summarizer writing results: it marks the vehicle dirty before letting go.
        await tx.summaryDirtyDay.create({ data: { objectId: v, day: new Date(D) } });
        order.push('summarizer-done');
      },
      { timeout: 60_000 },
    );
    const archived = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const r = await engine.run();
      order.push('archive-done');
      return r;
    })();
    await new Promise((r) => setTimeout(r, 1500));
    release();
    await holder;
    await archived;
    expect(order).toEqual(['summarizer-locked', 'summarizer-done', 'archive-done']);
    // It saw the dirty day under the lock: nothing deleted.
    expect(await count(v)).toBe(5);
    await prisma.summaryDirtyDay.deleteMany({ where: { objectId: v } });
    order = [];
  });

  it('idle vehicle (watermark at its last point) is archived; blocked and overdue vehicles are reported', async () => {
    const lastPoint = D + 3_600_000 + 9 * 60_000 + 2;
    const v = await newVehicle('idle', lastPoint);
    await prisma.position.createMany({ data: points(v, crypto.randomUUID(), D, 10) });
    expect((await prisma.position.aggregate({ where: { objectId: v }, _max: { fixTime: true } }))._max.fixTime!.getTime()).toBe(lastPoint);
    const strict = new ArchiveEngine(prisma, { dir, overdueDays: 5 });
    const stats = await strict.run();
    expect(await count(v)).toBe(0);
    expect(await prisma.archivedDay.findFirstOrThrow({ where: { objectId: v } })).toMatchObject({ status: 'ARCHIVED', pointCount: 10 });
    // a2 (dirty) and a3 (never summarised) hold 40-day-old points: blocked, and overdue past afterDays 30 + 5.
    expect(stats.blockedDirty).toBeGreaterThanOrEqual(1);
    expect(stats.blockedNotSummarised).toBeGreaterThanOrEqual(1);
    expect(stats.overdueObjects).toBeGreaterThanOrEqual(2);
    expect(await count(obj.a2)).toBe(40);
    expect(await count(obj.a3)).toBe(40);
  });

  it('deletes only inside the day bounds (chunk-local) and still exactly the given keys', async () => {
    const v = await newVehicle('bounds', null);
    const dv = crypto.randomUUID();
    await prisma.position.createMany({ data: points(v, dv, D, 6) });
    const rows = await prisma.$queryRaw<{ deviceId: string; fixTime: Date }[]>`SELECT "deviceId"::text AS "deviceId", "fixTime" FROM "Position" WHERE "objectId" = ${v}::uuid ORDER BY "fixTime"`;
    const keys = rows.map((r) => ({ deviceId: r.deviceId, fixTime: r.fixTime.getTime() })) as never[];
    // Bounds that leave out the last point: it is not deleted although its key is in the list.
    const n = await prisma.$transaction((tx) => deletePoints(tx, v, keys, D, rows[5].fixTime.getTime()));
    expect(n).toBe(5);
    expect(await count(v)).toBe(1);
    expect(await prisma.$transaction((tx) => deletePoints(tx, v, keys, D, D + DAY))).toBe(1);
    expect(await count(v)).toBe(0);
  });

  it('a failed rewrite transaction keeps the row on its previous, intact file (restore still works)', async () => {
    const v = await newVehicle('rewrite-fail', now - 60_000);
    const dv = crypto.randomUUID();
    await prisma.position.createMany({ data: points(v, dv, D, 12) });
    await engine.run();
    const before = await prisma.archivedDay.findFirstOrThrow({ where: { objectId: v } });
    // A late point arrives for the archived day; while the rewrite is written it disappears (e.g. removed by an admin).
    await prisma.position.createMany({ data: points(v, dv, D + 20 * 3_600_000, 1) });
    const breaking = new ArchiveEngine(prisma, {
      dir,
      beforeCommit: async (objectId) => {
        if (objectId === v) await prisma.position.deleteMany({ where: { objectId: v } });
      },
    });
    const stats = await breaking.run();
    expect(stats.failures).toBe(1);
    const after = await prisma.archivedDay.findFirstOrThrow({ where: { objectId: v } });
    expect(after).toMatchObject({ status: 'ARCHIVED', filePath: before.filePath, checksum: before.checksum, pointCount: 12 });
    expect(after.lastError).toMatch(/changed meanwhile/);
    // Only the original file is on disk (the new version was removed).
    const dayDir = path.dirname(resolveArchivePath(dir, before.filePath!));
    expect((await fsp.readdir(dayDir)).filter((f) => f.startsWith(dayKey(D).slice(8, 10)))).toEqual([path.basename(before.filePath!)]);
    await engine.requestRestore(companyA, [v], dayKey(D), dayKey(D), null);
    expect(await engine.restorePending()).toEqual({ restored: 1, failed: 0 });
    expect(await count(v)).toBe(12);
    // A successful rewrite switches to a new versioned file and removes the old one.
    await prisma.archivedDay.updateMany({ where: { objectId: v }, data: { keepUntil: new Date(now - 1000) } });
    await prisma.position.createMany({ data: points(v, dv, D + 21 * 3_600_000, 1) });
    await engine.run();
    const re = await prisma.archivedDay.findFirstOrThrow({ where: { objectId: v } });
    expect(re.pointCount).toBe(13);
    expect(re.filePath).not.toBe(before.filePath);
    expect(re.filePath).toMatch(/\/\d\d\.[a-z0-9]+\.jsonl\.gz$/);
    await expect(fsp.stat(resolveArchivePath(dir, before.filePath!))).rejects.toThrow();
  });

  it('restore reports points that sit under another vehicle instead of marking the day restored', async () => {
    const v = await newVehicle('restore-conflict', now - 60_000);
    const other = await newVehicle('restore-other', null);
    const dv = crypto.randomUUID();
    const pts = points(v, dv, D, 8);
    await prisma.position.createMany({ data: pts });
    await engine.run();
    expect(await count(v)).toBe(0);
    // Meanwhile one key (same device and time) was stored under another vehicle.
    await prisma.position.create({ data: { ...pts[3], objectId: other } as Prisma.PositionUncheckedCreateInput });
    await engine.requestRestore(companyA, [v], dayKey(D), dayKey(D), null);
    expect(await engine.restorePending()).toEqual({ restored: 0, failed: 1 });
    const row = await prisma.archivedDay.findFirstOrThrow({ where: { objectId: v } });
    expect(row.status).toBe('RESTORING');
    expect(row.lastError).toMatch(/1 of 8 points exist under another vehicle/);
    await prisma.archivedDay.updateMany({ where: { objectId: v }, data: { status: 'ARCHIVED' } });
  });

  it('keeps attributes byte for byte (big integers, decimal forms) through archive and restore', async () => {
    const v = await newVehicle('attrs', now - 60_000);
    const dv = crypto.randomUUID();
    const t = new Date(D + 5 * 3_600_000);
    await prisma.$executeRaw`
      INSERT INTO "Position" ("objectId", "deviceId", "fixTime", "serverTime", lat, lng, "speedKph", course, valid, flags, attributes)
      VALUES (${v}::uuid, ${dv}::uuid, ${t}, ${t}, 12.5, 77.5, 10, 0, true, 0, '{"big": 12345678901234567890123, "dec": 1.500, "neg": -0.0}'::jsonb)`;
    const text = async () => (await prisma.$queryRaw<{ a: string }[]>`SELECT attributes::text AS a FROM "Position" WHERE "objectId" = ${v}::uuid`)[0]?.a;
    const original = await text();
    expect(original).toContain('12345678901234567890123');
    await engine.run();
    expect(await count(v)).toBe(0);
    await engine.requestRestore(companyA, [v], dayKey(D), dayKey(D), null);
    await engine.restorePending();
    expect(await text()).toBe(original);
  });

  it('a purged device leaves the archive files of its vehicles (file rewritten, day removed when empty)', async () => {
    const v = await newVehicle('device-purge', now - 60_000);
    const keepDev = crypto.randomUUID();
    const goneDev = crypto.randomUUID();
    await prisma.position.createMany({ data: [...points(v, keepDev, D, 4), ...points(v, goneDev, D + 30_000, 3), ...points(v, goneDev, D1, 2)] });
    await engine.run();
    expect(await prisma.archivedDay.count({ where: { objectId: v } })).toBe(2);
    expect(await engine.removeDevicePoints(goneDev, [v])).toBe(5);
    const rows = await prisma.archivedDay.findMany({ where: { objectId: v } });
    expect(rows).toHaveLength(1);
    expect(rows[0].pointCount).toBe(4);
    const c = await readArchiveFile(resolveArchivePath(dir, rows[0].filePath!));
    expect(c.points.every((p) => p.deviceId === keepDev)).toBe(true);
    expect(c.checksum).toBe(rows[0].checksum);
  });

  it('summarizer: a rebuild keeps everything before the archive horizon; late-data rows for archived days are dropped', async () => {
    const v = await newVehicle('summ', null);
    const dv = crypto.randomUUID();
    await prisma.position.createMany({ data: [...points(v, dv, D, 20), ...points(v, dv, RECENT, 30)] });
    await prisma.summaryCursor.create({ data: { objectId: v, processedUntil: new Date(now - 60_000) } });
    await engine.run();
    expect(await rowsOf(v, D, D1)).toHaveLength(0);
    await prisma.dailySummary.create({ data: { objectId: v, companyId: companyA, day: new Date(D), distanceKm: 11.5, tripCount: 2 } });
    // Force a full rebuild (no cursor) and a late-data row for the archived day.
    await prisma.summaryCursor.delete({ where: { objectId: v } });
    await prisma.summaryDirtyDay.create({ data: { objectId: v, day: new Date(D) } });
    const { Summarizer } = await import('../summarizer/summarizer');
    const redis = { xinfo: async () => { throw new Error('no stream'); }, get: async () => null, set: async () => 'OK' } as never;
    const s = new Summarizer(prisma, redis);
    await s.runOnce(now);
    expect(await prisma.dailySummary.findUnique({ where: { objectId_day: { objectId: v, day: new Date(D) } } })).toMatchObject({ distanceKm: 11.5, tripCount: 2 });
    expect(await prisma.summaryDirtyDay.count({ where: { objectId: v } })).toBe(0);
    expect(await prisma.summaryCursor.findUnique({ where: { objectId: v } })).not.toBeNull();
    expect(await prisma.dailySummary.count({ where: { objectId: v, day: { gt: new Date(D) } } })).toBeGreaterThan(0);
    await prisma.trip.deleteMany({ where: { objectId: { in: extra } } });
    await prisma.stop.deleteMany({ where: { objectId: { in: extra } } });
  });
});
