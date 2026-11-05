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
  private const val ATTENTION_CHANNEL_ID = "attendance"
  private const val ATTENTION_NOTIFICATION_ID = 4712

  private class Texts(
    val title: String,
    val text: String,
    val trackingChannel: String,
    val trackingChannelInfo: String,
    val attendanceChannel: String,
    val attendanceChannelInfo: String,
    val selfieTitle: String,
    val selfieText: String,
    val leftTitle: (String?) -> String,
    val leftText: String,
  )

  private val hindi = Texts(
    "VeeTrax Tracker आपका स्थान साझा कर रहा है",
    "ट्रैकिंग चालू है। रोकने के लिए ऐप खोलें।",
    "ट्रैकिंग",
    "जब VeeTrax Tracker इस फ़ोन का स्थान साझा करता है तब दिखता है",
    "उपस्थिति",
    "आपकी उपस्थिति के बारे में प्रश्न",
    "अपनी चेक-इन सेल्फ़ी लें",
    "इसे लेने के लिए VeeTrax Tracker खोलें।",
    { site -> "आप ${site ?: "कार्यस्थल"} से बाहर गए" },
    "टैप करके बताएँ कि यह कार्यालय का काम था या निजी।",
  )

  private val tamil = Texts(
    "VeeTrax Tracker உங்கள் இருப்பிடத்தைப் பகிர்கிறது",
    "கண்காணிப்பு இயக்கத்தில் உள்ளது. நிறுத்த செயலியைத் திறக்கவும்.",
    "கண்காணிப்பு",
    "VeeTrax Tracker இந்த ஃபோனின் இருப்பிடத்தைப் பகிரும்போது காட்டப்படும்",
    "வருகைப்பதிவு",
    "உங்கள் வருகைப்பதிவு பற்றிய கேள்விகள்",
    "உங்கள் செக்-இன் செல்ஃபியை எடுக்கவும்",
    "அதை எடுக்க VeeTrax Tracker-ஐத் திறக்கவும்.",
    { site -> if (site == null) "நீங்கள் பணியிடத்திலிருந்து வெளியேறினீர்கள்" else "நீங்கள் $site இடத்திலிருந்து வெளியேறினீர்கள்" },
    "அலுவல் பணியா, தனிப்பட்டதா என்று தட்டிச் சொல்லுங்கள்.",
  )

  private val english = Texts(
    "VeeTrax Tracker is sharing your location",
    "Tracking is on. Open the app to stop.",
    "Tracking",
    "Shown while VeeTrax Tracker shares this phone's location",
    "Attendance",
    "Questions about your attendance",
    "",
    "",
    { "" },
    "",
  )

  private fun texts(context: Context) = when (Prefs(context).language) {
    "hi" -> hindi
    "ta" -> tamil
    else -> english
  }

  /** After a language change: renames the channels and rewrites the tracking notification if it is showing. */
  fun refresh(context: Context) {
    ensureChannel(context)
    if (!TrackerService.isRunning) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    runCatching { nm.notify(NOTIFICATION_ID, build(context)) }
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val t = texts(context)
    // For a channel that exists this only updates the name and description; the user's settings stay.
    nm.getNotificationChannel(ATTENTION_CHANNEL_ID)?.let {
      nm.createNotificationChannel(NotificationChannel(ATTENTION_CHANNEL_ID, t.attendanceChannel, NotificationManager.IMPORTANCE_HIGH).apply { description = t.attendanceChannelInfo })
    }
    val channel = NotificationChannel(CHANNEL_ID, t.trackingChannel, NotificationManager.IMPORTANCE_LOW).apply {
      description = t.trackingChannelInfo
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    nm.createNotificationChannel(channel)
  }

  /** An attendance question for the employee: a normal notification they can notice, unlike the silent tracking one. */
  fun showAttention(context: Context, id: String, serverTitle: String, serverText: String) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val t = texts(context)
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ATTENTION_CHANNEL_ID) == null) {
      nm.createNotificationChannel(NotificationChannel(ATTENTION_CHANNEL_ID, t.attendanceChannel, NotificationManager.IMPORTANCE_HIGH).apply {
        description = t.attendanceChannelInfo
      })
    }
    // The server writes these in English. The id says which it is; any other kind stays as the server wrote it.
    val translate = t !== english
    val selfie = translate && id.startsWith("selfie:")
    val outing = translate && id.startsWith("outing:")
    val site = serverTitle.removePrefix("You left ").takeIf { it != serverTitle && it != "the work site" }
    val title = if (selfie) t.selfieTitle else if (outing) t.leftTitle(site) else serverTitle
    val text = if (selfie) t.selfieText else if (outing) t.leftText else serverText
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED }
    val content = launch?.let {
      PendingIntent.getActivity(context, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val notification = NotificationCompat.Builder(context, ATTENTION_CHANNEL_ID)
      .setSmallIcon(R.drawable.veetrax_tracker_notification)
      .setColor(0xFF0F766E.toInt())
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(content)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()
    // Android 13+ without the notification permission: nothing is shown, the app's card still asks.
    runCatching { nm.notify(ATTENTION_NOTIFICATION_ID, notification) }
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
      .setContentTitle(texts(context).title)
      .setContentText(texts(context).text)
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
