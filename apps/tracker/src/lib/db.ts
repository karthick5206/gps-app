import * as SQLite from 'expo-sqlite';
import type { Point } from './api';

/**
 * Local storage in one SQLite file: the upload queue (one row per point, keyed by fix time so duplicates
 * are ignored) and a small key/value table for settings and status. Works in the headless background task too.
 */
export const QUEUE_CAP = 20_000;

let db: SQLite.SQLiteDatabase | null = null;

function open(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync('tracker.db');
  db.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS queue (t INTEGER PRIMARY KEY NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
  `);
  return db;
}

// ---- key/value ----

export function kvGet<T>(key: string, fallback: T): T {
  const row = open().getFirstSync<{ v: string }>('SELECT v FROM kv WHERE k = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown): void {
  if (value === undefined || value === null) open().runSync('DELETE FROM kv WHERE k = ?', key);
  else open().runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', key, JSON.stringify(value));
}

/** Merge fields into an object stored under key. */
export function kvMerge<T extends object>(key: string, patch: Partial<T>): T {
  const next = { ...kvGet<T>(key, {} as T), ...patch };
  kvSet(key, next);
  return next;
}

// ---- queue ----

/** Add points; a point with a fix time already queued is skipped (SOS points replace it). Trims to QUEUE_CAP. */
export function enqueue(points: Point[]): number {
  if (!points.length) return 0;
  const d = open();
  let added = 0;
  d.withTransactionSync(() => {
    for (const p of points) {
      const verb = p.sos ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
      added += d.runSync(`${verb} INTO queue (t, json) VALUES (?, ?)`, p.t, JSON.stringify(p)).changes;
    }
    const n = queueSize();
    if (n > QUEUE_CAP) d.runSync('DELETE FROM queue WHERE t IN (SELECT t FROM queue ORDER BY t ASC LIMIT ?)', n - QUEUE_CAP);
  });
  return added;
}

/** Oldest points first. */
export function peek(limit: number): Point[] {
  return open()
    .getAllSync<{ json: string }>('SELECT json FROM queue ORDER BY t ASC LIMIT ?', limit)
    .map((r) => JSON.parse(r.json) as Point);
}

export function remove(times: number[]): void {
  if (!times.length) return;
  const d = open();
  d.withTransactionSync(() => {
    for (const t of times) d.runSync('DELETE FROM queue WHERE t = ?', t);
  });
}

export function queueSize(): number {
  return open().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM queue')?.n ?? 0;
}

export function clearQueue(): void {
  open().runSync('DELETE FROM queue');
}
