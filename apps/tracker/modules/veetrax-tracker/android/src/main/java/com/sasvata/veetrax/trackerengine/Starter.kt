package com.sasvata.veetrax.trackerengine

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat

/** Starting / restarting the foreground service safely from anywhere (app, boot receiver, watchdog, alarm). */
object Starter {
  private const val TAG = "VeeTraxTracker"
  const val ACTION_RESTART = "com.sasvata.veetrax.trackerengine.RESTART"

  fun hasLocationPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

  /** Tracking should be on: the user wants it, we have a token and location permission. */
  fun shouldRun(context: Context): Boolean {
    val prefs = Prefs(context)
    return prefs.wanted && !prefs.token.isNullOrEmpty() && hasLocationPermission(context)
  }

  /** Starts the service if it should run and isn't running. Returns true when it is (or was just) started. */
  fun ensureRunning(context: Context, why: String): Boolean {
    if (!shouldRun(context)) return false
    if (TrackerService.isRunning) return true
    return start(context, why)
  }

  /**
   * startForegroundService can throw on Android 12+ when called from the background
   * (ForegroundServiceStartNotAllowedException). Allowed cases that matter here: the app is visible, BOOT_COMPLETED /
   * MY_PACKAGE_REPLACED receivers, and apps the user exempted from battery optimisation. Everything else is caught.
   */
  fun start(context: Context, why: String): Boolean = try {
    ContextCompat.startForegroundService(context, Intent(context, TrackerService::class.java))
    Log.i(TAG, "service start requested ($why)")
    true
  } catch (e: Exception) {
    Log.w(TAG, "service start refused ($why): $e")
    Prefs(context).lastError = "Android blocked the tracking restart ($why). Open the app."
    false
  }

  fun stop(context: Context) {
    context.stopService(Intent(context, TrackerService::class.java))
  }

  /**
   * One inexact alarm a few seconds from now that calls ensureRunning (via BootReceiver). Used when the task is
   * swiped away or the service is destroyed while tracking is wanted. Inexact alarms need no permission;
   * Doze may delay it, the 15-min watchdog is the second line.
   */
  fun scheduleRestart(context: Context, delayMs: Long) {
    try {
      val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val intent = Intent(context, BootReceiver::class.java).setAction(ACTION_RESTART)
      val pi = PendingIntent.getBroadcast(
        context, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delayMs, pi)
    } catch (e: Exception) {
      Log.w(TAG, "restart alarm failed: $e")
    }
  }
}
