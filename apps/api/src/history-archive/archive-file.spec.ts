import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ArchiveFileError, ArchivePoint, archiveRelPath, decodeArchive, encodeArchive, fileArchiveWriter, mergePoints, readArchiveFile, resolveArchivePath, verifyArchiveFile } from './archive-file';

const OID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const DEV = '33333333-3333-4333-8333-333333333333';
const header = { companyId: CID, objectId: OID, day: '2026-08-01', tz: 'Asia/Kolkata', from: '2026-07-31T18:30:00.000Z', to: '2026-08-01T18:30:00.000Z' };
const pt = (i: number, extra: Partial<ArchivePoint> = {}): ArchivePoint => ({
  deviceId: DEV,
  fixTime: Date.parse('2026-07-31T19:00:00.000Z') + i * 10_000,
  serverTime: Date.parse('2026-07-31T19:00:01.123Z') + i * 10_000,
  lat: 12.9716 + i * 1e-6,
  lng: 77.5946 - i * 1e-6,
  speedKph: 41.5,
  course: 270,
  altitude: i % 2 ? null : 912.25,
  satellites: i % 3 ? 9 : null,
  valid: true,
  ignition: i % 5 ? true : null,
  flags: i % 4,
  attributes: { odometerM: 1000 + i, io: { din1: i % 2 === 0 }, label: 'nñ ✓' },
  ...extra,
});

describe('archive file format', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-arch-'));
  });
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

  it('round-trips every value exactly and checks count + checksum', () => {
    const points = Array.from({ length: 50 }, (_, i) => pt(i));
    const { text, checksum } = encodeArchive(header, points);
    const back = decodeArchive(text);
    expect(back.points).toEqual(points);
    expect(back.checksum).toBe(checksum);
    expect(back.header).toMatchObject({ format: 'veetrax-history-archive', version: 1, objectId: OID, day: '2026-08-01' });
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('checksum depends on the content', () => {
    expect(encodeArchive(header, [pt(1)]).checksum).not.toBe(encodeArchive(header, [pt(1, { speedKph: 41.6 })]).checksum);
  });

  it('refuses a tampered line, a dropped line and a missing trailer', () => {
    const { text } = encodeArchive(header, [pt(1), pt(2), pt(3)]);
    const lines = text.trimEnd().split('\n');
    const tampered = [...lines];
    tampered[2] = tampered[2].replace('41.5', '99');
    expect(() => decodeArchive(tampered.join('\n'))).toThrow(/checksum/);
    const dropped = lines.filter((_, i) => i !== 2);
    expect(() => decodeArchive(dropped.join('\n'))).toThrow(/count mismatch/);
    expect(() => decodeArchive(lines.slice(0, -1).join('\n'))).toThrow(ArchiveFileError);
  });

  it('writes atomically, verifies, and the gzip file reads back', async () => {
    const points = Array.from({ length: 2000 }, (_, i) => pt(i));
    const abs = resolveArchivePath(dir, archiveRelPath(CID, OID, '2026-08-01'));
    const info = await fileArchiveWriter.write(abs, header, points);
    expect(info.count).toBe(2000);
    expect(info.bytes).toBe((await fsp.stat(abs)).size);
    const c = await verifyArchiveFile(abs, { count: 2000, checksum: info.checksum, objectId: OID, day: '2026-08-01' });
    expect(c.points[1999]).toEqual(points[1999]);
    // No temp files are left next to it.
    expect(await fsp.readdir(path.dirname(abs))).toEqual(['01.jsonl.gz']);
    await expect(verifyArchiveFile(abs, { count: 1999, checksum: info.checksum })).rejects.toThrow(/Verify failed/);
    await expect(verifyArchiveFile(abs, { count: 2000, checksum: 'x'.repeat(64) })).rejects.toThrow(/checksum/);
    await expect(verifyArchiveFile(abs, { count: 2000, checksum: info.checksum, day: '2026-08-02' })).rejects.toThrow(/another day/);
  });

  it('a rewrite replaces the file in place (re-archive after a restore)', async () => {
    const abs = resolveArchivePath(dir, archiveRelPath(CID, OID, '2026-08-01'));
    await fileArchiveWriter.write(abs, header, [pt(1)]);
    const info = await fileArchiveWriter.write(abs, header, [pt(1), pt(2)]);
    expect((await readArchiveFile(abs)).points).toHaveLength(2);
    expect(info.count).toBe(2);
  });

  it('detects a corrupt or truncated gzip file', async () => {
    const abs = path.join(dir, 'x.jsonl.gz');
    const { text } = encodeArchive(header, [pt(1), pt(2)]);
    const gz = gzipSync(Buffer.from(text));
    await fsp.writeFile(abs, gz.subarray(0, gz.length - 12));
    await expect(readArchiveFile(abs)).rejects.toThrow(ArchiveFileError);
  });

  it('paths stay inside the archive directory', () => {
    expect(archiveRelPath(CID, OID, '2026-08-01')).toBe(`${CID}/${OID}/2026/08/01.jsonl.gz`);
    expect(() => resolveArchivePath(dir, '../etc/passwd')).toThrow(/outside/);
    expect(() => archiveRelPath('../x', OID, '2026-08-01')).toThrow();
  });

  it('merges by (deviceId, fixTime), the preferred side wins, sorted', () => {
    const merged = mergePoints([pt(3), pt(1)], [pt(2), pt(1, { flags: 64 })]);
    expect(merged.map((p) => p.fixTime)).toEqual([pt(1).fixTime, pt(2).fixTime, pt(3).fixTime]);
    expect(merged[0].flags).toBe(64);
  });
});
