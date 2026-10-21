package com.sasvata.veetrax.trackerengine

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import kotlin.math.roundToInt

const val DEFAULT_SERVER_URL = "https://gps.mintplus.co.in"

/** Server-controlled tracking settings (API.md `config`). */
data class TrackerConfig(
  val intervalSec: Int = 10,
  val stoppedIntervalSec: Int = 60,
  val distanceM: Int = 10,
  val maxAccuracyM: Int = 100,
  val batchMax: Int = 100,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("intervalSec", intervalSec)
    .put("stoppedIntervalSec", stoppedIntervalSec)
    .put("distanceM", distanceM)
    .put("maxAccuracyM", maxAccuracyM)
    .put("batchMax", batchMax)

  /** Same values, clamped to sane ranges so a bad server value can't spin the GPS or the uploader. */
  fun clamped() = TrackerConfig(
    intervalSec = intervalSec.coerceIn(1, 3600),
    stoppedIntervalSec = stoppedIntervalSec.coerceIn(10, 3600),
    distanceM = distanceM.coerceIn(0, 1000),
    maxAccuracyM = maxAccuracyM.coerceIn(1, 10_000),
    batchMax = batchMax.coerceIn(1, 500),
  )

  companion object {
    private fun num(v: Any?): Int? = (v as? Number)?.toDouble()?.takeIf { !it.isNaN() }?.roundToInt()

    /** Merges the keys present in [map] (from JS) over [base]. */
    fun merge(base: TrackerConfig, map: Map<String, Any?>?): TrackerConfig {
      if (map == null) return base
      return TrackerConfig(
        intervalSec = num(map["intervalSec"]) ?: base.intervalSec,
        stoppedIntervalSec = num(map["stoppedIntervalSec"]) ?: base.stoppedIntervalSec,
        distanceM = num(map["distanceM"]) ?: base.distanceM,
        maxAccuracyM = num(map["maxAccuracyM"]) ?: base.maxAccuracyM,
        batchMax = num(map["batchMax"]) ?: base.batchMax,
      ).clamped()
    }

    /** Merges the keys present in [o] (server JSON) over [base]. */
    fun merge(base: TrackerConfig, o: JSONObject?): TrackerConfig {
      if (o == null) return base
      val map = HashMap<String, Any?>()
      for (key in o.keys()) map[key] = o.opt(key)
      return merge(base, map)
    }
  }
}

/** Last accepted fix: the anchor for the jump / stationary filter. */
data class Anchor(val t: Long, val lat: Double, val lng: Double, val acc: Float) {
  fun toJson(): String = JSONObject().put("t", t).put("lat", lat).put("lng", lng).put("acc", acc.toDouble()).toString()

  companion object {
    fun fromJson(s: String?): Anchor? = try {
      if (s == null) null else JSONObject(s).let {
        Anchor(it.getLong("t"), it.getDouble("lat"), it.getDouble("lng"), it.getDouble("acc").toFloat())
      }
    } catch (_: Exception) {
      null
    }
  }
}

/**
 * Everything the engine must remember across process deaths, reboots and app updates, in one
 * SharedPreferences file (app-private storage). Values the service needs to restart on its own
 * (token, wanted, server URL) are written with commit() so they are on disk before we return.
 */
class Prefs(context: Context) {
  private val sp: SharedPreferences =
    context.applicationContext.getSharedPreferences("veetrax_tracker_engine", Context.MODE_PRIVATE)

  private fun str(k: String): String? = sp.getString(k, null)
  private fun long(k: String): Long = sp.getLong(k, 0L)
  private fun float(k: String): Float? = sp.getFloat(k, Float.NaN).takeIf { !it.isNaN() }

  // ---- credentials & intent ----

  var token: String?
    get() = str("token")
    set(v) { sp.edit().putString("token", v).commit() }

  var serverUrl: String
    get() = str("serverUrl")?.takeIf { it.isNotBlank() } ?: DEFAULT_SERVER_URL
    set(v) { sp.edit().putString("serverUrl", v.trim().trimEnd('/')).commit() }

  /** The user wants tracking on. Only Stop in the app (or a server REVOKED / INVALID / INACTIVE) clears it. */
  var wanted: Boolean
    get() = sp.getBoolean("wanted", false)
    set(v) { sp.edit().putBoolean("wanted", v).commit() }

  /** Why tracking stopped on its own: REVOKED, INVALID or INACTIVE (null after a user stop). */
  var stopReason: String?
    get() = str("stopReason")
    set(v) { sp.edit().putString("stopReason", v).commit() }

  var config: TrackerConfig
    get() = TrackerConfig.merge(TrackerConfig(), str("config")?.let { runCatching { JSONObject(it) }.getOrNull() })
    set(v) { sp.edit().putString("config", v.clamped().toJson().toString()).apply() }

  // ---- filter state ----

  var anchor: Anchor?
    get() = Anchor.fromJson(str("anchor"))
    set(v) { sp.edit().putString("anchor", v?.toJson()).apply() }

  /** Fix time of the newest queued point; every new point must be strictly later (server dedupes on t). */
  var lastQueuedT: Long
    get() = long("lastQueuedT")
    set(v) { sp.edit().putLong("lastQueuedT", v).apply() }

  // ---- status shown in the app ----

  fun recordFix(t: Long, acc: Float?, spd: Float?) {
    sp.edit()
      .putLong("lastFixAt", t)
      .putFloat("lastAcc", acc ?: Float.NaN)
      .putFloat("lastSpd", spd ?: Float.NaN)
      .apply()
  }

  val lastFixAt get() = long("lastFixAt")
  val lastAcc get() = float("lastAcc")
  val lastSpd get() = float("lastSpd")

  var lastAcceptedAt: Long
    get() = long("lastAcceptedAt")
    set(v) { sp.edit().putLong("lastAcceptedAt", v).apply() }

  var lastUploadAt: Long
    get() = long("lastUploadAt")
    set(v) { sp.edit().putLong("lastUploadAt", v).apply() }

  var lastError: String?
    get() = str("lastError")
    set(v) { sp.edit().putString("lastError", v).apply() }

  var failures: Int
    get() = sp.getInt("failures", 0)
    set(v) { sp.edit().putInt("failures", v).apply() }

  /** Wall-clock ms before which no automatic upload is tried (exponential backoff). */
  var backoffUntil: Long
    get() = long("backoffUntil")
    set(v) { sp.edit().putLong("backoffUntil", v).apply() }

  fun bump(counter: String) {
    sp.edit().putLong(counter, long(counter) + 1).apply()
  }

  val mockCount get() = long("mockCount")
  val droppedCount get() = long("droppedCount")

  /** Forget everything except the server URL (sign-out, REVOKED, INVALID). */
  fun clearAll() {
    val url = str("serverUrl")
    sp.edit().clear().putString("serverUrl", url).commit()
  }

  /** Reset upload / filter status (keeps credentials and wanted). */
  fun clearStatus() {
    sp.edit()
      .remove("anchor").remove("lastQueuedT").remove("lastFixAt").remove("lastAcc").remove("lastSpd")
      .remove("lastAcceptedAt").remove("lastUploadAt").remove("lastError").remove("failures")
      .remove("backoffUntil").remove("mockCount").remove("droppedCount")
      .apply()
  }
}
