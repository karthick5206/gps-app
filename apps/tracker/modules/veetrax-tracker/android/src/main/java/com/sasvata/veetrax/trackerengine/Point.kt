package com.sasvata.veetrax.trackerengine

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import kotlin.math.roundToInt

/** One queued position, exactly the API.md upload format. */
data class Point(
  val t: Long,
  val lat: Double,
  val lng: Double,
  val acc: Float?,
  val spd: Float?,
  val brg: Float?,
  val alt: Double?,
  val bat: Int?,
  val chg: Boolean?,
  val mock: Boolean,
  val sos: Boolean = false,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("t", t)
    .put("lat", lat)
    .put("lng", lng)
    .put("acc", acc?.let { round1(it.toDouble()) } ?: JSONObject.NULL)
    .put("spd", spd?.let { round1(it.toDouble()) } ?: JSONObject.NULL)
    .put("brg", brg?.let { round1(it.toDouble()) } ?: JSONObject.NULL)
    .put("alt", alt?.let { round1(it) } ?: JSONObject.NULL)
    .put("bat", bat ?: JSONObject.NULL)
    .put("chg", chg ?: JSONObject.NULL)
    .put("mock", mock)
    .put("sos", sos)

  companion object {
    private fun round1(v: Double) = (v * 10).roundToInt() / 10.0

    private fun optFloat(o: JSONObject, k: String): Float? = if (o.isNull(k)) null else o.optDouble(k).toFloat()

    fun fromJson(s: String): Point {
      val o = JSONObject(s)
      return Point(
        t = o.getLong("t"),
        lat = o.getDouble("lat"),
        lng = o.getDouble("lng"),
        acc = optFloat(o, "acc"),
        spd = optFloat(o, "spd"),
        brg = optFloat(o, "brg"),
        alt = if (o.isNull("alt")) null else o.optDouble("alt"),
        bat = if (o.isNull("bat")) null else o.optInt("bat"),
        chg = if (o.isNull("chg")) null else o.optBoolean("chg"),
        mock = o.optBoolean("mock", false),
        sos = o.optBoolean("sos", false),
      )
    }

    /** Android's mock flag: `isMock` from API 31, the deprecated `isFromMockProvider` before. */
    fun isMock(loc: Location): Boolean =
      if (Build.VERSION.SDK_INT >= 31) loc.isMock else @Suppress("DEPRECATION") loc.isFromMockProvider

    fun from(loc: Location, battery: Battery.Info, sos: Boolean = false) = Point(
      t = loc.time,
      lat = loc.latitude,
      lng = loc.longitude,
      acc = if (loc.hasAccuracy()) loc.accuracy else null,
      spd = if (loc.hasSpeed() && loc.speed >= 0f) loc.speed else null,
      brg = if (loc.hasBearing()) loc.bearing else null,
      alt = if (loc.hasAltitude()) loc.altitude else null,
      bat = battery.level,
      chg = battery.charging,
      mock = isMock(loc),
      sos = sos,
    )
  }
}

/** Battery % and charging, read from the sticky ACTION_BATTERY_CHANGED broadcast (no receiver kept), cached 60 s. */
object Battery {
  data class Info(val level: Int?, val charging: Boolean?)

  private var cached: Info = Info(null, null)
  private var cachedAt = 0L

  @Synchronized
  fun read(context: Context): Info {
    val now = SystemClock.elapsedRealtime()
    if (cachedAt != 0L && now - cachedAt < 60_000) return cached
    cached = try {
      val i: Intent? = context.applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      if (i == null) Info(null, null) else {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        Info(
          level = if (level >= 0 && scale > 0) (level * 100f / scale).roundToInt() else null,
          charging = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            -1, BatteryManager.BATTERY_STATUS_UNKNOWN -> null
            else -> false
          },
        )
      }
    } catch (_: Exception) {
      Info(null, null)
    }
    cachedAt = now
    return cached
  }
}
