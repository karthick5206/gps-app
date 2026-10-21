package com.sasvata.veetrax.trackerengine

import android.annotation.SuppressLint
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Location foreground service (foregroundServiceType="location"). It only owns the Android pieces: the
 * notification, the FusedLocationProviderClient request and the lifecycle hooks. All logic (filter, queue,
 * upload, mode switching) is in [Engine], on its background thread. Location callbacks are delivered straight
 * on that thread (we pass its Looper), so nothing runs on the main thread.
 *
 * START_STICKY: if Android kills the process for memory, it recreates the service later with a null intent.
 */
class TrackerService : Service() {

  companion object {
    private const val TAG = "VeeTraxTracker"

    /** True while this process has a started, foreground TrackerService. Process-scoped: resets if we're killed. */
    @Volatile
    var isRunning = false
      private set
  }

  private lateinit var engine: Engine
  private lateinit var fused: FusedLocationProviderClient

  private val callback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      engine.onLocations(result.locations)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    engine = Engine.get(this)
    fused = LocationServices.getFusedLocationProviderClient(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // startForeground() must be called within a few seconds of startForegroundService(), even if we then stop,
    // otherwise Android crashes the app. So do it first.
    if (!goForeground()) {
      stopSelf()
      return START_NOT_STICKY
    }
    val prefs = engine.prefs
    if (!prefs.wanted || prefs.token.isNullOrEmpty()) {
      // A sticky restart after the user stopped / signed out: nothing to do.
      stopSelf()
      return START_NOT_STICKY
    }
    if (!isRunning) {
      isRunning = true
      engine.service = this
      engine.post { it.onServiceStarted() }
    }
    WatchdogWorker.schedule(this)
    return START_STICKY
  }

  private fun goForeground(): Boolean = try {
    val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
    ServiceCompat.startForeground(this, Notifications.NOTIFICATION_ID, Notifications.build(this), type)
    true
  } catch (e: Exception) {
    // Android 14+: SecurityException when location permission is missing (or "all the time" is missing and we
    // were started from the background). Android 12+: ForegroundServiceStartNotAllowedException.
    Log.w(TAG, "startForeground failed: $e")
    engine.prefs.lastError = "Could not start tracking: ${e.message ?: e.javaClass.simpleName}"
    false
  }

  /**
   * (Re)requests location updates for the current mode. Calling requestLocationUpdates again with the same
   * callback replaces the previous request. Called on the engine thread.
   *
   * MOVING: GPS high accuracy every intervalSec, only when moved distanceM, and wait for an accurate first fix.
   * STATIONARY: balanced power (Wi-Fi / cell, GPS mostly off) every stoppedIntervalSec, no distance filter (so
   * heartbeats keep coming), and batched delivery (maxUpdateDelay = 3 × interval) so the CPU sleeps in between.
   */
  @SuppressLint("MissingPermission")
  fun requestUpdates(mode: Engine.Mode, cfg: TrackerConfig) {
    val request = when (mode) {
      Engine.Mode.MOVING -> {
        val interval = cfg.intervalSec * 1000L
        LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
          .setMinUpdateDistanceMeters(cfg.distanceM.toFloat())
          .setWaitForAccurateLocation(true)
          .build()
      }
      Engine.Mode.STATIONARY -> {
        val interval = cfg.stoppedIntervalSec * 1000L
        LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, interval)
          .setMinUpdateIntervalMillis(interval)
          .setMinUpdateDistanceMeters(0f)
          .setMaxUpdateDelayMillis(interval * 3)
          .build()
      }
    }
    try {
      fused.requestLocationUpdates(request, callback, engine.looper)
      Log.i(TAG, "location updates: $mode")
    } catch (e: SecurityException) {
      engine.prefs.lastError = "Location permission missing"
    }
  }

  /** Swiped away from recents. A foreground service normally survives this; some OEMs kill it anyway. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    if (engine.prefs.wanted) Starter.scheduleRestart(applicationContext, 5_000)
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    try {
      fused.removeLocationUpdates(callback)
    } catch (_: Exception) {
    }
    val wasRunning = isRunning
    isRunning = false
    engine.service = null
    if (wasRunning) engine.post { it.onServiceStopped() }
    // Destroyed although tracking is still wanted (OEM task killer, system): come back.
    if (engine.prefs.wanted && !engine.prefs.token.isNullOrEmpty()) Starter.scheduleRestart(applicationContext, 10_000)
    super.onDestroy()
  }
}
