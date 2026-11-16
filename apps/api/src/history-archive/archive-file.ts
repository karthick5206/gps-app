/**
 * History archive files: one gzip-compressed JSON Lines file per vehicle per (company-local) day.
 *
 *   line 1      header  {"format":"veetrax-history-archive","version":1,"companyId",…,"columns":[…]}
 *   lines 2…n   points  JSON arrays in `columns` order (times as epoch milliseconds, all values exactly as stored)
 *   last line   trailer {"end":true,"count":N,"sha256":"<hex of the point lines, each followed by \n>"}
 *
 * Files are written to a temporary name, flushed to disk, re-read and verified (count + checksum) and only then renamed
 * into place, so a file under its final name is always complete. Node zlib only (no extra dependencies).
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const ARCHIVE_FORMAT = 'veetrax-history-archive';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_COLUMNS = ['deviceId', 'fixTime', 'serverTime', 'lat', 'lng', 'speedKph', 'course', 'altitude', 'satellites', 'valid', 'ignition', 'flags', 'attributes'] as const;

/** One Position row (objectId is the file's). */
export interface ArchivePoint {
  deviceId: string;
  /** epoch ms */
  fixTime: number;
  serverTime: number;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  altitude: number | null;
  satellites: number | null;
  valid: boolean;
  ignition: boolean | null;
  flags: number;
  attributes: unknown;
}

export interface ArchiveHeader {
  companyId: string;
  objectId: string;
  /** YYYY-MM-DD (company time zone) */
  day: string;
  tz: string;
  /** ISO bounds of the day [from, to). */
  from: string;
  to: string;
}

export interface ArchiveFileInfo {
  count: number;
  checksum: string;
  bytes: number;
}

export interface ArchiveContent {
  header: ArchiveHeader & { format: string; version: number; columns: string[] };
  points: ArchivePoint[];
  checksum: string;
}

export class ArchiveFileError extends Error {}

/** Default archive directory (env HISTORY_ARCHIVE_DIR). */
export function archiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HISTORY_ARCHIVE_DIR ?? '').trim() || '/var/lib/veetrax/history-archive';
}

/** `<companyId>/<objectId>/<yyyy>/<mm>/<dd>.jsonl.gz` (always forward slashes; stored in ArchivedDay.filePath). */
export function archiveRelPath(companyId: string, objectId: string, day: string): string {
  const [y, m, d] = day.split('-');
  if (!/^[0-9a-f-]{36}$/i.test(companyId) || !/^[0-9a-f-]{36}$/i.test(objectId) || !y || !m || !d) throw new ArchiveFileError('Invalid archive path parts');
  return `${companyId}/${objectId}/${y}/${m}/${d}.jsonl.gz`;
}

/** Absolute path of a stored relative path; refuses anything that would leave the archive directory. */
export function resolveArchivePath(dir: string, rel: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new ArchiveFileError('Archive path outside the archive directory');
  return abs;
}

const pointLine = (p: ArchivePoint) =>
  JSON.stringify([p.deviceId, p.fixTime, p.serverTime, p.lat, p.lng, p.speedKph, p.course, p.altitude, p.satellites, p.valid, p.ignition, p.flags, p.attributes ?? {}]);

/** The uncompressed file text and the checksum of its point lines. */
export function encodeArchive(header: ArchiveHeader, points: ArchivePoint[]): { text: string; checksum: string } {
  const hash = createHash('sha256');
  const lines: string[] = [JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, ...header, columns: ARCHIVE_COLUMNS, count: points.length })];
  for (const p of points) {
    const line = pointLine(p);
    hash.update(line + '\n');
    lines.push(line);
  }
  const checksum = hash.digest('hex');
  lines.push(JSON.stringify({ end: true, count: points.length, sha256: checksum }));
  return { text: lines.join('\n') + '\n', checksum };
}

/** Parses and checks an uncompressed archive (header, every line, trailer count and checksum). */
export function decodeArchive(text: string): ArchiveContent {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2) throw new ArchiveFileError('Archive file is truncated');
  let header: ArchiveContent['header'];
  let trailer: { end?: unknown; count?: unknown; sha256?: unknown };
  try {
    header = JSON.parse(lines[0]);
    trailer = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new ArchiveFileError('Archive header or trailer is not valid JSON');
  }
  if (header.format !== ARCHIVE_FORMAT || header.version !== ARCHIVE_VERSION) throw new ArchiveFileError('Not a VeeTrax history archive (format / version)');
  if (trailer.end !== true) throw new ArchiveFileError('Archive file has no trailer (truncated)');
  const hash = createHash('sha256');
  const points: ArchivePoint[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    hash.update(lines[i] + '\n');
    let a: unknown[];
    try {
      a = JSON.parse(lines[i]);
    } catch {
      throw new ArchiveFileError(`Archive line ${i + 1} is not valid JSON`);
    }
    if (!Array.isArray(a) || a.length !== ARCHIVE_COLUMNS.length) throw new ArchiveFileError(`Archive line ${i + 1} has the wrong shape`);
    points.push({
      deviceId: a[0] as string,
      fixTime: a[1] as number,
      serverTime: a[2] as number,
      lat: a[3] as number,
      lng: a[4] as number,
      speedKph: a[5] as number,
      course: a[6] as number,
      altitude: a[7] as number | null,
      satellites: a[8] as number | null,
      valid: a[9] as boolean,
      ignition: a[10] as boolean | null,
      flags: a[11] as number,
      attributes: a[12],
    });
  }
  const checksum = hash.digest('hex');
  if (trailer.count !== points.length) throw new ArchiveFileError(`Archive count mismatch: trailer ${String(trailer.count)}, lines ${points.length}`);
  if (trailer.sha256 !== checksum) throw new ArchiveFileError('Archive checksum mismatch');
  return { header, points, checksum };
}

/** Reads, decompresses and checks a file (its own trailer). */
export async function readArchiveFile(abs: string): Promise<ArchiveContent> {
  const buf = await fsp.readFile(abs);
  let text: string;
  try {
    text = (await gunzipAsync(buf)).toString('utf8');
  } catch (e) {
    throw new ArchiveFileError(`Archive file is not valid gzip: ${(e as Error).message}`);
  }
  return decodeArchive(text);
}

/** Re-reads a file and checks it holds exactly `expected` (count and checksum), and that it belongs to this vehicle-day. */
export async function verifyArchiveFile(abs: string, expected: { count: number; checksum: string; objectId?: string; day?: string }): Promise<ArchiveContent> {
  const c = await readArchiveFile(abs);
  if (c.points.length !== expected.count) throw new ArchiveFileError(`Verify failed: ${c.points.length} points in the file, expected ${expected.count}`);
  if (c.checksum !== expected.checksum) throw new ArchiveFileError('Verify failed: checksum differs');
  if (expected.objectId && c.header.objectId !== expected.objectId) throw new ArchiveFileError('Verify failed: file belongs to another vehicle');
  if (expected.day && c.header.day !== expected.day) throw new ArchiveFileError('Verify failed: file belongs to another day');
  return c;
}

/** Writes and verifies files. An interface so tests can simulate a failing disk. */
export interface ArchiveWriter {
  write(abs: string, header: ArchiveHeader, points: ArchivePoint[]): Promise<ArchiveFileInfo>;
}

/**
 * Temp file → fsync → re-read + verify → rename over the final name → fsync the directory (best effort). The final
 * name only ever holds a complete, verified file; a failure leaves no temp file behind.
 */
export const fileArchiveWriter: ArchiveWriter = {
  async write(abs, header, points) {
    const { text, checksum } = encodeArchive(header, points);
    const gz = await gzipAsync(Buffer.from(text, 'utf8'), { level: 6 });
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Hidden temp name in the same directory (same filesystem, so the rename is atomic); backups may exclude ".*.tmp-*".
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
    try {
      const fh = await fsp.open(tmp, 'wx', 0o640);
      try {
        await fh.writeFile(gz);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await verifyArchiveFile(tmp, { count: points.length, checksum, objectId: header.objectId, day: header.day });
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    try {
      const dh = await fsp.open(path.dirname(abs), 'r');
      await dh.sync().catch(() => undefined);
      await dh.close();
    } catch {
      /* directories can't be opened on every platform (Windows dev) */
    }
    return { count: points.length, checksum, bytes: gz.length };
  },
};

/** Points of two sources merged by (deviceId, fixTime); `preferred` wins on a clash. Sorted by fixTime, deviceId. */
export function mergePoints(base: ArchivePoint[], preferred: ArchivePoint[]): ArchivePoint[] {
  const map = new Map<string, ArchivePoint>();
  for (const p of base) map.set(`${p.deviceId}|${p.fixTime}`, p);
  for (const p of preferred) map.set(`${p.deviceId}|${p.fixTime}`, p);
  return [...map.values()].sort((a, b) => a.fixTime - b.fixTime || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
}
