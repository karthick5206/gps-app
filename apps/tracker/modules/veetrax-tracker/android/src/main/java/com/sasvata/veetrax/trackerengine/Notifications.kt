package com.sasvata.veetrax.trackerengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The permanent "Tracking" notification required for a foreground service. Low importance: no sound, no
 * vibration, no heads-up. It is built once and never updated (no per-fix updates = no extra wake-ups).
 * There is deliberately no Stop action: tracking is stopped only from inside the app.
 */
object Notifications {
  const val CHANNEL_ID = "tracking"
  const val NOTIFICATION_ID = 4711

  private const val TITLE = "VeeTrax Tracker is sharing your location"
  private const val TEXT = "Tracking is on. Open the app to stop."

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Tracking", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shown while VeeTrax Tracker shares this phone's location"
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    nm.createNotificationChannel(channel)
  }

  fun build(context: Context): Notification {
    ensureChannel(context)
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED }
    val content = launch?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.veetrax_tracker_notification)
      .setColor(0xFF0F766E.toInt())
      .setContentTitle(TITLE)
      .setContentText(TEXT)
      .setContentIntent(content)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      // Android 12+ may delay showing an FGS notification by 10 s; show it at once so the user always sees it.
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
