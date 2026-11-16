import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Upload queue in SQLite (Android: PointQueue.kt): one row per point keyed by fix time `t` (duplicates ignored),
/// capped at [cap] rows (oldest dropped). WAL mode; batched in transactions. Only used from the engine queue.
final class PointQueue {
  static let cap: Int64 = 50_000

  private var db: OpaquePointer?

  /// Called with how many of the oldest points were dropped because the queue is full.
  var onTrimmed: ((Int64) -> Void)?

  init() {
    let fm = FileManager.default
    let dir = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? fm.temporaryDirectory
    let path = dir.appendingPathComponent("veetrax_tracker_queue.db").path
    if sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
      sqlite3_close(db)
      db = nil
      return
    }
    // Readable after the first unlock, so a relaunch in the background (after a reboot) can still queue points.
    try? fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
    exec("PRAGMA journal_mode=WAL")
    exec("CREATE TABLE IF NOT EXISTS queue (t INTEGER PRIMARY KEY NOT NULL, json TEXT NOT NULL)")
  }

  deinit { sqlite3_close(db) }

  @discardableResult
  private func exec(_ sql: String) -> Bool {
    sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
  }

  /// Adds points (an existing `t` is kept), then trims the oldest rows above [cap]. Returns rows added.
  @discardableResult
  func add(_ points: [Point]) -> Int {
    guard !points.isEmpty, db != nil else { return 0 }
    var added = 0
    exec("BEGIN IMMEDIATE")
    var stmt: OpaquePointer?
    if sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO queue (t, json) VALUES (?, ?)", -1, &stmt, nil) == SQLITE_OK {
      for p in points {
        guard let json = p.jsonString() else { continue }
        sqlite3_bind_int64(stmt, 1, p.t)
        sqlite3_bind_text(stmt, 2, json, -1, SQLITE_TRANSIENT)
        if sqlite3_step(stmt) == SQLITE_DONE, sqlite3_changes(db) > 0 { added += 1 }
        sqlite3_reset(stmt)
        sqlite3_clear_bindings(stmt)
      }
    }
    sqlite3_finalize(stmt)
    let n = size()
    if n > PointQueue.cap {
      exec("DELETE FROM queue WHERE t IN (SELECT t FROM queue ORDER BY t ASC LIMIT \(n - PointQueue.cap))")
      onTrimmed?(n - PointQueue.cap)
    }
    exec("COMMIT")
    return added
  }

  /// Oldest points first. A row that can't be parsed is deleted (it would block the queue for ever).
  func peek(_ limit: Int) -> [Point] {
    guard db != nil else { return [] }
    var out: [Point] = []
    var bad: [Int64] = []
    var stmt: OpaquePointer?
    if sqlite3_prepare_v2(db, "SELECT t, json FROM queue ORDER BY t ASC LIMIT \(max(1, limit))", -1, &stmt, nil) == SQLITE_OK {
      while sqlite3_step(stmt) == SQLITE_ROW {
        let t = sqlite3_column_int64(stmt, 0)
        if let c = sqlite3_column_text(stmt, 1), let p = Point.fromJSON(String(cString: c)) {
          out.append(p)
        } else {
          bad.append(t)
        }
      }
    }
    sqlite3_finalize(stmt)
    if !bad.isEmpty { remove(bad) }
    return out
  }

  func remove(_ times: [Int64]) {
    guard !times.isEmpty, db != nil else { return }
    exec("BEGIN IMMEDIATE")
    var stmt: OpaquePointer?
    if sqlite3_prepare_v2(db, "DELETE FROM queue WHERE t = ?", -1, &stmt, nil) == SQLITE_OK {
      for t in times {
        sqlite3_bind_int64(stmt, 1, t)
        sqlite3_step(stmt)
        sqlite3_reset(stmt)
        sqlite3_clear_bindings(stmt)
      }
    }
    sqlite3_finalize(stmt)
    exec("COMMIT")
  }

  func size() -> Int64 {
    guard db != nil else { return 0 }
    var stmt: OpaquePointer?
    var n: Int64 = 0
    if sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM queue", -1, &stmt, nil) == SQLITE_OK, sqlite3_step(stmt) == SQLITE_ROW {
      n = sqlite3_column_int64(stmt, 0)
    }
    sqlite3_finalize(stmt)
    return n
  }

  func clear() {
    exec("DELETE FROM queue")
  }
}
