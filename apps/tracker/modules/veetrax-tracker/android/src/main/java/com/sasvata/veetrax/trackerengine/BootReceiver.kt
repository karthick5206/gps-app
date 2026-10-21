package com.sasvata.veetrax.trackerengine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts tracking after a reboot, after an app update (MY_PACKAGE_REPLACED: the update kills the old process),
 * and when our own restart alarm fires. Android lets BOOT_COMPLETED / MY_PACKAGE_REPLACED receivers start a
 * location foreground service (needs "Allow all the time" location on Android 14+).
 *
 * LOCKED_BOOT_COMPLETED is not used: our SharedPreferences live in credential-protected storage, which is not
 * readable before the user unlocks the phone, so we wait for BOOT_COMPLETED.
 * QUICKBOOT_POWERON is sent instead of BOOT_COMPLETED by some HTC / Xiaomi / older OEM "fast boot" modes.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      "android.intent.action.QUICKBOOT_POWERON",
      "com.htc.intent.action.QUICKBOOT_POWERON",
      Starter.ACTION_RESTART -> {
        val app = context.applicationContext
        if (Starter.shouldRun(app)) {
          Starter.ensureRunning(app, intent.action ?: "receiver")
          WatchdogWorker.schedule(app)
        }
      }
    }
  }
}
