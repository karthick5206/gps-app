package com.sasvata.veetrax.trackerengine

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Upload queue in native SQLite: one row per point keyed by fix time `t` (duplicates ignored),
 * capped at [CAP] rows (oldest dropped). WAL mode; inserts and deletes are batched in transactions.
 * Only used from the engine's background thread.
 */
class PointQueue(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "veetrax_tracker_queue.db", null, 1) {

  companion object {
    const val CAP = 50_000
  }

  override fun onConfigure(db: SQLiteDatabase) {
    db.enableWriteAheadLogging()
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE IF NOT EXISTS queue (t INTEGER PRIMARY KEY NOT NULL, json TEXT NOT NULL)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

  /** Adds points (an existing `t` is kept), then trims the oldest rows above [CAP]. Returns rows added. */
  fun add(points: List<Point>): Int {
    if (points.isEmpty()) return 0
    val db = writableDatabase
    var added = 0
    db.beginTransaction()
    try {
      for (p in points) {
        val cv = ContentValues(2).apply {
          put("t", p.t)
          put("json", p.toJson().toString())
        }
        if (db.insertWithOnConflict("queue", null, cv, SQLiteDatabase.CONFLICT_IGNORE) != -1L) added++
      }
      val n = DatabaseUtils.queryNumEntries(db, "queue")
      if (n > CAP) {
        db.execSQL(
          "DELETE FROM queue WHERE t IN (SELECT t FROM queue ORDER BY t ASC LIMIT ?)",
          arrayOf<Any>(n - CAP),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return added
  }

  /** Oldest points first. A row that can't be parsed is deleted (it would block the queue for ever). */
  fun peek(limit: Int): List<Point> {
    val out = ArrayList<Point>(limit)
    val bad = ArrayList<Long>()
    readableDatabase.rawQuery("SELECT t, json FROM queue ORDER BY t ASC LIMIT $limit", null).use { c ->
      while (c.moveToNext()) {
        try {
          out.add(Point.fromJson(c.getString(1)))
        } catch (_: Exception) {
          bad.add(c.getLong(0))
        }
      }
    }
    if (bad.isNotEmpty()) remove(bad)
    return out
  }

  fun remove(times: List<Long>) {
    if (times.isEmpty()) return
    val db = writableDatabase
    db.beginTransaction()
    try {
      val stmt = db.compileStatement("DELETE FROM queue WHERE t = ?")
      for (t in times) {
        stmt.bindLong(1, t)
        stmt.executeUpdateDelete()
        stmt.clearBindings()
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun size(): Long = DatabaseUtils.queryNumEntries(readableDatabase, "queue")

  fun clear() {
    writableDatabase.execSQL("DELETE FROM queue")
  }
}
