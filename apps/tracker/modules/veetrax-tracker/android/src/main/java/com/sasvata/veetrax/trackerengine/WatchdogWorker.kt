package com.sasvata.veetrax.trackerengine

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Every 15 minutes (WorkManager's minimum; it batches with other apps' work so it costs ~nothing): if tracking is
 * wanted but the service is gone (killed by an OEM battery manager), start it again. No network constraint: the
 * worker asks whether tracking is required while it is off, and otherwise restarts the service if needed and sends a
 * short health report when nothing else has reached the server for a while.
 * WorkManager survives reboots and app updates on its own.
 */
class WatchdogWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val app = applicationContext
    val prefs = Prefs(app)
    if (prefs.token.isNullOrEmpty()) return Result.success()
    if (!prefs.wanted) {
      // Tracking is off: the administrator may require it on.
      runOnEngine(app) { it.checkRequired() }
      return Result.success()
    }
    Starter.ensureRunning(app, "watchdog")
    runOnEngine(app) { it.ping() }
    return Result.success()
  }

  /** Waits for the work, or Android could freeze the process mid-request. */
  private fun runOnEngine(app: Context, block: (Engine) -> Unit) {
    val done = CountDownLatch(1)
    Engine.get(app).post {
      try {
        block(it)
      } finally {
        done.countDown()
      }
    }
    done.await(CHECK_TIMEOUT_SEC, TimeUnit.SECONDS)
  }

  companion object {
    private const val NAME = "veetrax-tracker-watchdog"
    private const val CHECK_TIMEOUT_SEC = 30L

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
