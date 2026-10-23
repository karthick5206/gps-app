package com.sasvata.veetrax.trackerengine

import android.Manifest
import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * The phone settings that decide whether tracking survives in the background, sent with every upload so the server
 * (Devices → Tracker app → Phone health, and the "Device offline" alert) can say WHY a phone went quiet instead of
 * guessing. Cheap system queries only; no extra wake-ups or network.
 *
 * Keys: locOn, locFine, locBg (all the time), battOpt (true = battery-optimised), powerSave, dataSaver
 * ("on" | "off" | "allowed"), bgRestricted, bucket (app standby bucket, 10 active … 45 restricted), notif,
 * wanted, running, mode, failures, lastError, start/stop/refused { at, why }, mfr, model, sdk.
 */
object Health {
  fun snapshot(context: Context, prefs: Prefs, running: Boolean, mode: String): JSONObject {
    val app = context.applicationContext
    val o = JSONObject()
    fun safe(key: String, block: () -> Any?) {
      try {
        val v = block()
        if (v != null) o.put(key, v)
      } catch (_: Throwable) {
        // a query an OEM build doesn't support: leave the key out
      }
    }
    safe("locOn") {
      val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }
    safe("locFine") { granted(app, Manifest.permission.ACCESS_FINE_LOCATION) }
    safe("locBg") { Starter.hasBackgroundPermission(app) }
    safe("battOpt") { !(app.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(app.packageName) }
    safe("powerSave") { (app.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode }
    safe("dataSaver") {
      when ((app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).restrictBackgroundStatus) {
        ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> "on"
        ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED -> "allowed"
        else -> "off"
      }
    }
    if (Build.VERSION.SDK_INT >= 28) {
      safe("bgRestricted") { (app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isBackgroundRestricted }
      safe("bucket") { (app.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager).appStandbyBucket }
    }
    safe("notif") { NotificationManagerCompat.from(app).areNotificationsEnabled() }
    o.put("wanted", prefs.wanted)
    o.put("running", running)
    o.put("mode", mode)
    o.put("failures", prefs.failures)
    prefs.lastError?.let { o.put("lastError", it.take(200)) }
    for (kind in listOf("start", "stop", "refused")) prefs.event(kind)?.let { (at, why) -> o.put(kind, JSONObject().put("at", at).put("why", why)) }
    o.put("mfr", Build.MANUFACTURER ?: "")
    o.put("model", Build.MODEL ?: "")
    o.put("sdk", Build.VERSION.SDK_INT)
    return o
  }

  private fun granted(context: Context, permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
