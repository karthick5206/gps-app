package com.sasvata.veetrax.trackerengine

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Every 15 minutes (WorkManager's minimum; it batches with other apps' work so it costs ~nothing): if tracking is
 * wanted but the service is gone (killed by an OEM battery manager), start it again. No network constraint: the
 * worker itself never uses the network; it only checks and starts the service, and nudges the uploader.
 * WorkManager survives reboots and app updates on its own.
 */
class WatchdogWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val app = applicationContext
    if (!Prefs(app).wanted) return Result.success()
    if (Starter.ensureRunning(app, "watchdog")) Engine.get(app).post { it.requestUpload(force = false) }
    return Result.success()
  }

  companion object {
    private const val NAME = "veetrax-tracker-watchdog"

    fun schedule(context: Context) {
      try {
        val req = PeriodicWorkRequestBuilder<WatchdogWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context.applicationContext)
          .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
      } catch (_: Exception) {
        // WorkManager not initialised (should not happen with the default initializer); the alarm path remains.
      }
    }

    fun cancel(context: Context) {
      try {
        WorkManager.getInstance(context.applicationContext).cancelUniqueWork(NAME)
      } catch (_: Exception) {
      }
    }
  }
}
