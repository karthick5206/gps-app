package com.sasvata.veetrax.trackerengine

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.SystemClock
import kotlin.math.abs

/**
 * Explains a gap in tracking after the fact. A killed process can't record its own death, so on the next start this
 * asks Android why the app's process ended (API 30+) and whether the phone was restarted in between. Both end up in the
 * event history sent to the server (Devices → Tracker app → Tracking history).
 */
object Diagnostics {
  /** A move of the boot time smaller than this is a clock correction, not a restart. */
  private const val BOOT_TOLERANCE_MS = 5 * 60_000L
  private const val MAX_EXITS = 8

  fun record(context: Context, prefs: Prefs) {
    recordBoot(prefs)
    if (Build.VERSION.SDK_INT >= 30) recordExits(context, prefs)
  }

  private fun recordBoot(prefs: Prefs) {
    val bootAt = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    val known = prefs.bootAt
    if (known != 0L && abs(bootAt - known) <= BOOT_TOLERANCE_MS) return
    prefs.bootAt = bootAt
    if (known != 0L) prefs.recordEvent("boot", "phone restarted", bootAt)
  }

  private fun recordExits(context: Context, prefs: Prefs) {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val exits = am.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS)
    val seen = prefs.lastExitAt
    val fresh = exits.filter { it.timestamp > seen }.sortedBy { it.timestamp }
    for (e in fresh) {
      val detail = e.description?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""
      prefs.recordEvent("exit", reasonName(e.reason) + detail, e.timestamp)
    }
    fresh.lastOrNull()?.let { prefs.lastExitAt = it.timestamp }
  }

  private fun reasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_EXIT_SELF -> "app exited itself"
    ApplicationExitInfo.REASON_SIGNALED -> "killed by a signal"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "killed: low memory"
    ApplicationExitInfo.REASON_CRASH -> "app crashed"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "app crashed (native)"
    ApplicationExitInfo.REASON_ANR -> "app not responding"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "failed to start"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "a permission was changed"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "killed: excessive resource use"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "stopped by the user or phone (force stop / task manager)"
    ApplicationExitInfo.REASON_USER_STOPPED -> "phone user profile stopped"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "a dependency died"
    ApplicationExitInfo.REASON_OTHER -> "killed by the system"
    else -> "reason $reason"
  }
}
