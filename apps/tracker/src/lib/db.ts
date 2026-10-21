import * as SQLite from 'expo-sqlite';

/**
 * Small key/value store for UI state (session names, sign-out notice, …) in one SQLite file.
 * The position queue is NOT here any more: it lives in the native tracking engine (modules/veetrax-tracker).
 */
let db: SQLite.SQLiteDatabase | null = null;

function open(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync('tracker.db');
  db.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
    DROP TABLE IF EXISTS queue;
  `);
  return db;
}

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
